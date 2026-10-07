import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import entry from "./ours-entry.ts";
import { renderPrompt } from "../boot/prompt.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Tool = { name: string; execute: (id: string, args: unknown) => Promise<unknown> };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };

test("boot keeps the dashboard address out of shared prompts and uses the private owner tool", async () => {
  const source = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  for (const url of ["https://cloud-owner.example.test", null]) {
    const prompt = await renderPrompt(source, null, "fixture-token", "untrusted", url);
    assert.match(prompt, /plow_hours\(action="dashboard"\)/);
    assert.ok(!prompt.includes("Your dashboard is") && !prompt.includes("You have no dashboard"));
    assert.ok(!url || !prompt.includes(url), "contractor contexts must not receive the owner's URL");
  }
});

test("only the verified private owner turn can fetch the hours and OpenClaw URLs for its current installation", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const config = { channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line" } } };
  let webUrl: string | null = "https://tenant-one.example.test";
  let lineUid = "line";
  let identityRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "http://fixture/v1/agents/me") {
      identityRequests++;
      return Response.json({ line: { uid: lineUid }, agent: { web_url: webUrl } });
    }
    assert.equal(url, "http://fixture/v1/chats/cht_home");
    return Response.json(home);
  });
  for (const scenario of ["owner", "member", "owner-group", "web", "stale"] as const) {
    let tool: Tool | undefined;
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config, sessionKey: scenario === "owner-group" ? "agent:main:plow:group:cht_home" : "agent:main:main",
          messageChannel: scenario === "web" ? "webchat" : "plow", agentAccountId: "chat", nativeChannelId: home.uid,
          requesterSenderId: scenario === "member" ? "+15550000002" : "plow-owner", senderIsOwner: scenario !== "member",
          assertInvocationCurrent() { if (scenario === "stale") throw new Error("Expired turn"); } });
        if (candidate.name === "plow_hours") tool = candidate;
      },
    });
    assert.ok(tool);
    const before = identityRequests;
    if (scenario !== "owner") {
      await assert.rejects(() => tool.execute(scenario, { action: "dashboard" }), scenario === "stale" ? /Expired turn/ : /owner's main Plow DM/);
      if (scenario !== "stale") assert.equal(identityRequests, before, "denied turns cannot even fetch the private address");
      continue;
    }
    for (const [url, hoursUrl, openclawUrl] of [
      ["https://tenant-one.example.test", "https://tenant-one.example.test/hours", "https://tenant-one.example.test/openclaw/"],
      ["https://tenant-two.example.test/agent/?view=owner#panel", "https://tenant-two.example.test/agent/hours?view=owner#panel", "https://tenant-two.example.test/agent/openclaw/?view=owner#panel"],
      ["https://tenant-three.plow.run/", "https://tenant-three.plow.run/hours", "https://tenant-three.plow.run/openclaw/"],
      ["http://localhost:3331/", "http://localhost:3331/hours", "http://localhost:3331/openclaw/"],
    ]) {
      webUrl = url;
      const details = { url: hoursUrl, openclaw_url: openclawUrl, view: "hours", owner_only: true, read_only: true };
      assert.deepEqual(await tool.execute("dashboard", { action: "dashboard" }), { content: [{ type: "text", text: JSON.stringify(details) }], details });
    }
    await assert.rejects(() => tool.execute("injected-url", { action: "dashboard", url: "https://other.example.test" }));
    for (const url of [null, "javascript:alert(1)", "https://user:password@example.test"]) {
      webUrl = url;
      await assert.rejects(() => tool.execute("unavailable", { action: "dashboard" }), /address is unavailable/);
    }
    webUrl = "https://wrong-line.example.test";
    lineUid = "someone-elses-line";
    await assert.rejects(() => tool.execute("wrong-line", { action: "dashboard" }), /address is unavailable/);
    lineUid = "line";
  }
});
