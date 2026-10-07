import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
// @ts-expect-error The bundled backup helper is JavaScript.
import { startHoursBackups } from "../hours-source/backup.mjs";

const CONFIG = "/var/lib/plow/openclaw.json";
const INCLUDES = "/etc/plow/openclaw";
// Loaded by path at run time: these are the base image's compiled modules.
const load = (path: string) => import(path);

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

try {
  const { installBootLog } = await load("/opt/plow/boot/log.js");
  const { startAgentIndex } = await load("/opt/plow/boot/agent-index.js");
  const { renderConfig, syncConfig } = await load("/opt/plow/boot/ours-config.js");
  const { identityFromApi } = await load("/opt/plow/boot/ours-config.js");
  const { renderPrompt } = await load("/opt/plow/boot/prompt.js");
  const { startGateway } = await load("/opt/plow/boot/process.js");

  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  process.env.AGENT_NAME = identity.line.display_name?.trim() || process.env.AGENT_NAME;
  const config = renderConfig(identity, base);
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
  await chmod("/var/lib/plow/gateway-password", 0o600);
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN, config.channels.plow.threadTrust, identity.agent?.web_url));

  await syncConfig(config, CONFIG, INCLUDES);
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startHoursBackups();
  startAgentIndex(300_000, writeLog);
  await startGateway(false, identity.mcp_url ?? undefined, writeLog);
} catch (error) {
  console.error(`plow-boot: parked: ${message(error)}`);
  setInterval(() => {}, 2 ** 30);
}
