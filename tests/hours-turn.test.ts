import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Tool = { name: string; execute: (id: string, args: unknown) => Promise<unknown> };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const contractor = { ...owner, uid: "ana", role: "member", display_name: "Ana", provider_key: "+15550000002" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [self, owner] };
const group = { uid: "cht_ana", status: "active", trusted: false, participants: [self, owner, contractor] };
const profile = { action: "contractor", id: "ana", name: "Ana", handle: contractor.provider_key, chat_uid: group.uid, timezone: "America/Sao_Paulo", rate_cents: 3000 };

test("registered normal-room clock events commit and confirm without any model or Mac call", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Site", summary: "Landing page" }, "demand");
  const controller = abortAfter(10_000);
  const posts: { body: string; path: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "POST" && path.endsWith("/messages")) {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(body && typeof body === "object" && "body" in body && typeof body.body === "string");
      posts.push({ body: body.body, path });
      if (posts.length === 2) setTimeout(() => controller.abort(), 20);
      return Response.json({ uid: `sent_${posts.length}` });
    }
    if (path.endsWith("/ws/ticket")) return Response.json({ ticket: "fixture" });
    if (path === "/v1/chats") return Response.json({ data: [home, group], has_more: false });
    if (path.endsWith("/messages")) return Response.json({ data: [], has_more: false });
    if (path.endsWith(`/${group.uid}`)) return Response.json(group);
    if (path.endsWith(`/${home.uid}`)) return Response.json(home);
    throw new Error(`Unexpected external call: ${path}`);
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const [uid, body, created_at] of [
      ["start", "comecei landing", "2026-10-02T09:00:00-03:00"],
      ["stop", "parei commit abc123", "2026-10-02T11:30:00-03:00"],
    ]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: group.uid,
      data: { message: { uid, body, created_at, direction: "inbound", sender: contractor, attachments: [] } } }));
  });
  const account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "untrusted" };
  const cfg = { channels: { plow: account }, plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } } };
  let channel: { gateway: { startAccount: (value: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", logger: { info() {} }, registerTool() {}, registerHttpRoute() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: `agent:main:plow:group:${group.uid}` }) },
      session: { resolveStorePath, updateLastRoute },
      inbound: { buildContext() { assert.fail("Clock events must not build a model prompt"); }, dispatch() { assert.fail("Clock events must not invoke the model"); } },
    } },
  });
  assert.ok(channel);
  await channel.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info() {} } });
  assert.equal(posts.length, 2);
  assert.ok(posts.every(post => post.path === `/v1/chats/${group.uid}/messages`));
  assert.match(posts[0]?.body ?? "", /Ponto iniciado/);
  assert.match(posts[1]?.body ?? "", /2.5 h/);
  assert.equal(ledger.report("ana")[0]?.total_hours, 2.5);
  assert.equal(ledger.report("ana")[0]?.entries.length, 1);
});

test("management requires the owner's main DM and a normal thread bound to the actual contractor", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const cfg = { channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line" } } };
  let destination = group;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.endsWith(home.uid) ? home : destination));
  for (const scenario of ["member", "owner-group", "wrong-handle", "trusted-room", "owner"] as const) {
    let tool: Tool | undefined;
    destination = { ...group, trusted: scenario === "trusted-room" };
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: scenario === "owner-group" ? "agent:main:plow:group:cht_ana" : "agent:main:main",
          messageChannel: "plow", agentAccountId: "chat", nativeChannelId: home.uid,
          requesterSenderId: scenario === "member" ? contractor.provider_key : "plow-owner", senderIsOwner: scenario !== "member" });
        if (candidate.name === "plow_hours") tool = candidate;
      },
    });
    assert.ok(tool);
    const call = () => tool.execute(`profile-${scenario}`, { ...profile, handle: scenario === "wrong-handle" ? "+15550000003" : profile.handle });
    if (scenario === "owner") await call();
    else await assert.rejects(call, scenario === "trusted-room" ? /normal chat trust/ : scenario === "wrong-handle" ? /exactly this contractor/ : /owner's main Plow DM/);
  }
});

test("the base does not register the feature when its opt-in is absent", () => {
  const previous = process.env.PLOW_HOURS;
  delete process.env.PLOW_HOURS;
  const names: string[] = [];
  try {
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {},
      registerTool(factory: (context: object) => Tool) { names.push(factory({}).name); },
    });
    assert.ok(!names.includes("plow_hours"));
  } finally { if (previous !== undefined) process.env.PLOW_HOURS = previous; }
});
