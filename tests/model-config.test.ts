import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { renderConfig, syncConfig } from "../boot/ours-config.ts";
import { websocketFixture } from "./ws-fixture.ts";

const primary = "plow/anthropic/claude-sonnet-5";
const flash = "plow/z-ai/glm-5.3-flash";
const legacy = "plow/z-ai/glm-5.2";
const model = z.union([z.string(), z.object({ primary: z.string(), fallbacks: z.array(z.string()).optional() })]);
const savedConfig = z.object({ agents: z.object({
  defaults: z.object({ model, workspace: z.string() }),
  entries: z.object({ main: z.object({ model: model.optional() }) }),
}) });
function render() {
  return renderConfig({ owner_uid: "owner-account", line: { uid: "line" }, agent: { name: "Ours" }, chats: [] }, "http://fixture", "untrusted");
}

test("a new installation boots with Claude Sonnet 5 and a GPT 6 Sol fallback", async t => {
  await websocketFixture(t);
  const config = render();
  assert.equal(config.agents.defaults.userTimezone, "America/Sao_Paulo");
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m", target: "none" });
  const root = process.env.OPENCLAW_STATE_DIR;
  assert.ok(root);
  const path = join(root, "openclaw.json");
  await syncConfig(config, path, join(root, "includes"));
  const saved = savedConfig.parse(JSON.parse(await readFile(path, "utf8")));
  assert.equal(config.models.providers.plow.models[0].id, "openai/gpt-6-sol");
  assert.equal(config.models.providers.plow.models[0].reasoning, true);
  assert.ok(config.models.providers.plow.models.some(entry => entry.id === "anthropic/claude-sonnet-5"));
  assert.deepEqual(saved.agents.defaults.model, { primary, fallbacks: ["plow/openai/gpt-6-sol"] });
});

for (const selection of [
  { name: "legacy object", before: { primary: legacy, fallbacks: ["custom/fallback"] }, after: { primary, fallbacks: ["custom/fallback"] } },
  { name: "legacy string", before: legacy, after: primary },
  { name: "Flash default object", before: { primary: flash, fallbacks: [primary] }, after: { primary, fallbacks: ["plow/openai/gpt-6-sol"] } },
  { name: "Flash default string", before: flash, after: primary },
  { name: "another explicit model", before: { primary: "openai/custom", fallbacks: ["custom/fallback"] }, after: { primary: "openai/custom", fallbacks: ["custom/fallback"] } },
  { name: "already migrated", before: primary, after: primary },
]) {
  test(`updating ${selection.name} preserves owner settings and is repeatable`, async t => {
    await websocketFixture(t);
    const root = process.env.OPENCLAW_STATE_DIR;
    assert.ok(root);
    const path = join(root, "openclaw.json"), includes = join(root, "includes");
    await writeFile(path, JSON.stringify({ agents: {
      defaults: { model: selection.before, workspace: "/owner/workspace" },
      entries: { main: { model: selection.before, heartbeat: { every: "1m", target: "last" } } },
    } }));
    await syncConfig(render(), path, includes);
    const saved = savedConfig.parse(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(saved.agents.defaults.model, selection.after);
    assert.deepEqual(saved.agents.entries.main.model, selection.after);
    assert.equal(saved.agents.defaults.workspace, "/owner/workspace");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(persisted.agents.defaults.heartbeat, { every: "0m", target: "none" });
    assert.deepEqual(persisted.agents.entries.main.heartbeat, { every: "0m", target: "none" });
    const first = await readFile(path, "utf8");
    await syncConfig(render(), path, includes);
    assert.equal(await readFile(path, "utf8"), first);
  });
}


test("the installed personality and hours policy fit inside the bootstrap budget", async t => {
  await websocketFixture(t);
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  assert.ok(render().agents.defaults.bootstrapMaxChars >= prompt.length,
    "The model must receive the complete personality and correction policy.");
});

test("an existing installation enables the separate hours plugin and keeps unrelated plugin settings", async t => {
  await websocketFixture(t);
  const root = process.env.OPENCLAW_STATE_DIR;
  assert.ok(root);
  const path = join(root, "openclaw.json"), includes = join(root, "includes");
  await writeFile(path, JSON.stringify({ plugins: { entries: { unrelated: { enabled: false } } } }));
  await syncConfig(render(), path, includes);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.plugins.entries.ours, { enabled: true });
  assert.deepEqual(saved.plugins.entries.unrelated, { enabled: false });
  assert.ok(JSON.parse(await readFile(join(includes, "plugin-load.json5"), "utf8")).paths.includes("/opt/ours/plugin"));
});

test("Ours disables autonomous heartbeat messages in fresh and upgraded configurations", async t => {
  await websocketFixture(t);
  const config = render();
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m", target: "none" });
  const root = process.env.OPENCLAW_STATE_DIR;
  assert.ok(root);
  const path = join(root, "openclaw.json");
  await writeFile(path, JSON.stringify({ agents: {
    defaults: { heartbeat: { every: "1m", target: "last" } },
    entries: { main: { heartbeat: { every: "1m", target: "plow" } } },
  } }));
  await syncConfig(config, path, join(root, "includes"));
  const saved = z.object({ agents: z.object({ defaults: z.object({ heartbeat: z.unknown() }), entries: z.object({ main: z.object({ heartbeat: z.unknown() }) }) }) }).parse(JSON.parse(await readFile(path, "utf8")));
  assert.deepEqual(saved.agents.defaults.heartbeat, { every: "0m", target: "none" });
  assert.deepEqual(saved.agents.entries.main.heartbeat, { every: "0m", target: "none" });
});
