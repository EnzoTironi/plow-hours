import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSON5 from "json5";
import { z } from "zod";
import { renderConfig as renderBase, syncConfig as syncBase, type Identity as BaseIdentity } from "./config.ts";
import { identityFromApi as baseIdentity } from "./identity.ts";
import { HoursLedger } from "../plugin/hours.ts";

type Identity = BaseIdentity & { owner_uid?: string };
const primary = "plow/anthropic/claude-sonnet-5";
const fallback = "plow/openai/gpt-6-sol";
const legacyModels = new Set(["plow/z-ai/glm-5.2", "plow/z-ai/glm-5.3-flash"]);
const selectedModel = z.union([z.string(), z.object({
  primary: z.string().optional(), fallbacks: z.array(z.string()).optional(),
}).passthrough()]);
const modelSettings = z.object({ model: selectedModel.optional() }).passthrough();
const savedConfig = z.object({
  agents: z.object({ defaults: modelSettings.optional(),
    entries: z.record(z.string(), modelSettings).optional(),
  }).passthrough().optional(),
  surfaces: z.record(z.string(), z.unknown()).optional(),
  plugins: z.object({ entries: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
}).passthrough();

export async function identityFromApi(base: string, token: string): Promise<Identity> {
  const identity = await baseIdentity(base, token);
  const response = await fetch(`${base}/v1/auth/owner-uid`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Owner identity request refused: HTTP ${response.status}`);
  const owner = z.object({ owner_uid: z.string().trim().min(1) }).safeParse(await response.json());
  if (!owner.success) throw new Error("Owner identity is missing owner_uid");
  return { ...identity, owner_uid: owner.data.owner_uid };
}

export function renderConfig(identity: Identity, base: string, trust = process.env.PLOW_THREAD_TRUST ?? "ask") {
  if (!identity.owner_uid?.trim()) throw new Error("Ours needs an authenticated account owner identity.");
  const ledger = new HoursLedger(join(process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow", "plow-hours"));
  try { ledger.bindInstallation(identity.line.uid, identity.owner_uid); } finally { ledger.close(); }
  const config = renderBase({ ...identity, agent: { ...identity.agent, name: process.env.AGENT_NAME ?? identity.agent?.name } }, base, trust);
  return {
    ...config,
    gateway: { ...config.gateway,
      controlUi: { ...config.gateway.controlUi, basePath: "/openclaw" },
      auth: { ...config.gateway.auth, trustedProxy: { ...config.gateway.auth.trustedProxy,
        allowUsers: [identity.owner_uid, ...(process.env.PLOW_HOURS_LOCAL === "1" ? ["dev-owner"] : [])],
      } },
    },
    agents: { ...config.agents, defaults: { ...config.agents.defaults,
      bootstrapMaxChars: 32000, userTimezone: "America/Sao_Paulo",
      heartbeat: { every: "0m", target: "none" }, model: { primary, fallbacks: [fallback] },
    } },
    models: { providers: { plow: { ...config.models.providers.plow, models: [
      { id: "openai/gpt-6-sol", name: "GPT 6 Sol", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000 },
      ...config.models.providers.plow.models.filter(model => model.id === "anthropic/claude-sonnet-5"),
    ] } } },
    tools: { ...config.tools,
      alsoAllow: [...config.tools.alsoAllow.filter(name => !["read", "write", "edit", "exec"].includes(name)), "plow_hours", "plow_hours_self"],
      deny: [...config.tools.deny, "exec", "read", "write", "edit", "apply_patch"],
    },
    plugins: { ...config.plugins,
      load: { paths: [...config.plugins.load.paths, "/opt/ours/plugin"] },
      entries: { ...config.plugins.entries, ours: { enabled: true } },
    },
    surfaces: { plow: { silentReply: { group: "allow" } } },
  };
}

export async function syncConfig(config: ReturnType<typeof renderConfig>, path: string, includes: string) {
  const provider = config.models.providers.plow;
  await syncBase({ ...config, models: { providers: { plow: {
    ...provider, models: provider.models.filter(model => "cost" in model),
  } } } }, path, includes);
  await writeFile(join(includes, "plow-provider.json5"), JSON.stringify(provider, null, 2) + "\n");
  const owner = savedConfig.parse(JSON5.parse(await readFile(path, "utf8")));
  for (const settings of [owner.agents?.defaults, owner.agents?.entries?.main]) {
    const selected = settings?.model;
    if (!settings || !selected) continue;
    if (typeof selected === "string") {
      if (legacyModels.has(selected)) settings.model = primary;
    } else if (selected.primary && legacyModels.has(selected.primary)) {
      selected.primary = primary;
      if (selected.fallbacks?.length === 1 && selected.fallbacks[0] === primary) selected.fallbacks = [fallback];
    }
  }
  const silencePath = join(includes, "plow-silent-reply.json5");
  const promptPath = join(includes, "ours-prompt-limit.json5");
  await writeFile(silencePath, JSON.stringify(config.surfaces.plow.silentReply) + "\n");
  await writeFile(promptPath, JSON.stringify(config.agents.defaults.bootstrapMaxChars) + "\n");
  owner.plugins ??= {};
  owner.plugins.entries ??= {};
  owner.plugins.entries.ours = config.plugins.entries.ours;
  const surfaces = owner.surfaces ??= {};
  const plow = z.object({}).passthrough().parse(surfaces.plow ?? {});
  plow.silentReply = { $include: silencePath };
  surfaces.plow = plow;
  owner.agents ??= {};
  owner.agents.defaults ??= {};
  owner.agents.defaults.bootstrapMaxChars = { $include: promptPath };
  owner.agents.defaults.heartbeat = { every: "0m", target: "none" };
  if (owner.agents.entries?.main) owner.agents.entries.main.heartbeat = { every: "0m", target: "none" };
  await writeFile(`${path}.tmp`, JSON.stringify(Object.fromEntries(Object.entries(owner).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
