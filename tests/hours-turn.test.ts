import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { clockHours, hoursGroup } from "../plugin/hours-channel.ts";
import { websocketFixture } from "./ws-fixture.ts";
import { listen, type Account, type Chat, type Message } from "../plugin/transport.ts";

type Tool = { name: string; execute: (id: string, args: unknown) => Promise<unknown> };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const contractor = { ...owner, uid: "ana", role: "member", display_name: "Ana", provider_key: "+15550000002" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [self, owner] };
const group = { uid: "cht_ana", status: "active", trusted: false, participants: [self, { ...owner, uid: "owner-in-group" }, contractor] };
const profile = { action: "contractor", id: "ana", name: "Ana", handle: contractor.provider_key, chat_uid: group.uid, timezone: "America/Sao_Paulo", rate_cents: 3000 };

test("an adopted contractor message recovers after restart even outside the provider history window", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Site", summary: "Landing page" }, "demand");
  const message: Message = { uid: "failed-start", body: "Started the landing page.", created_at: "2026-10-02T09:00:00-03:00",
    direction: "inbound", sender: { type: "member", uid: "ana", role: "member", display_name: "Ana", provider_key: profile.handle }, attachments: [] };
  const chat: Chat = { uid: group.uid, status: "active", trusted: false, participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: owner.provider_key }, message.sender,
  ] };
  let recovering = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/ws/ticket")) return Response.json({ ticket: "fixture" });
    if (parsed.pathname === "/v1/chats") return Response.json({ data: [home, chat], has_more: false });
    if (parsed.pathname.endsWith("/messages")) return Response.json({ data: [], has_more: false });
    if (parsed.pathname.endsWith(`/${chat.uid}`)) return Response.json(chat);
    if (parsed.pathname.endsWith(`/${home.uid}`)) return Response.json(home);
    throw new Error(`Unexpected provider request: ${parsed.pathname}`);
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    if (!recovering) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
  });
  const account: Account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "untrusted" };
  const failed = abortAfter(10_000);
  await listen(account, failed.signal, line => { if (line.includes("turn failed")) failed.abort(); }, async (_chat, _message, _first, _history, ingress) => {
    ingress.onSubmitted();
    ledger.clockAttempt({ line_uid: account.lineUid, chat_uid: chat.uid, handle: profile.handle,
      message_uid: message.uid, body: message.body, created_at: message.created_at });
    await ingress.onAdopted();
    throw new Error("Fixture: model returned HTTP 402 after adopting the source");
  });
  const checkpointPath = `${process.env.OPENCLAW_STATE_DIR}/plow-checkpoints/${chat.uid}`;
  const checkpoint = z.object({ uid: z.string(), recent: z.array(z.string()) }).parse(JSON.parse(await readFile(checkpointPath, "utf8")));
  assert.ok(!checkpoint.recent.includes(message.uid));
  assert.equal(ledger.report("ana")[0]?.entries.length, 0);
  recovering = true;
  const restarted = abortAfter(10_000);
  let recovered = 0;
  await listen(account, restarted.signal, line => { if (line.includes("stage=terminal")) restarted.abort(); }, async (currentChat, current, _first, _history, ingress) => {
    ingress.onSubmitted();
    await ingress.onAdopted();
    recovered++;
    ledger.clock({ line_uid: account.lineUid, chat_uid: currentChat.uid, handle: profile.handle,
      message_uid: current.uid, body: current.body, created_at: current.created_at }, { kind: "start", detail: "landing" });
    return "completed";
  });
  assert.equal(recovered, 1);
  assert.equal(ledger.report("ana")[0]?.open_entry?.start_ms, Date.parse(message.created_at));
  assert.equal(ledger.report("ana")[0]?.entries.length, 1);
});

test("optional clock shortcuts commit and confirm without any model or Mac call", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Site", summary: "Landing page" }, "demand");
  const controller = abortAfter(30_000);
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
      ["start", "/in landing", "2026-10-02T09:00:00-03:00"],
      ["stop", "/out commit abc123", "2026-10-02T11:30:00-03:00"],
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
  const logs: string[] = [];
  await channel.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(value: string) { logs.push(value); } } });
  assert.equal(posts.length, 2, JSON.stringify({ posts, logs }));
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

test("the scoped tool binds both the live roster and sender; owner DM, another group and changed membership have no member access", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "scoped-profile");
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" };
  const cfg = { channels: { plow: account } };
  let served = group;
  t.mock.method(globalThis, "fetch", async () => Response.json(served));
  for (const scenario of ["member", "owner-group", "owner-dm", "other-group", "wrong-sender", "expanded-group", "trusted-group"] as const) {
    served = scenario === "owner-dm" ? { ...group, ...home } : scenario === "other-group" ? { ...group, uid: "cht_other" }
      : scenario === "expanded-group" ? { ...group, participants: [...group.participants, { ...contractor, uid: "other", provider_key: "+15550000003" }] }
      : { ...group, trusted: scenario === "trusted-group" };
    let tool: Tool | undefined;
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: scenario === "owner-dm" ? "agent:main:main" : `agent:main:plow:group:${served.uid}`,
          messageChannel: "plow", agentAccountId: "chat", nativeChannelId: served.uid,
          requesterSenderId: scenario === "owner-group" ? "plow-owner" : scenario === "wrong-sender" ? "+15550000003" : contractor.provider_key,
          senderIsOwner: scenario === "owner-group" });
        if (candidate.name === "plow_hours_self") tool = candidate;
      },
    });
    assert.ok(tool);
    if (scenario === "member" || scenario === "owner-group") {
      const result = await tool.execute(`self-${scenario}`, { action: "report" });
      assert.ok(JSON.stringify(result).includes('"name":"Ana"'));
    } else await assert.rejects(() => tool.execute(`self-${scenario}`, { action: "report" }), /registered contractor's group/);
  }
  assert.ok(hoursGroup(account, group));
  assert.equal(hoursGroup(account, { ...group, participants: [...group.participants, contractor] }), undefined);
});

test("changed membership does not interrupt human conversations or run clock shortcuts", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "changed-group-profile");
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" };
  const chat: Chat = { ...group, participants: [...group.participants, contractor] };
  for (const body of ["Dane, pode preencher o horário?", "/in landing", "/out"]) {
    const message: Message = { uid: body, body, sender: contractor, direction: "inbound", created_at: "2026-10-05T09:00:00Z", attachments: [] };
    assert.equal(clockHours({ account, chat, message, senderIsOwner: false }), undefined);
  }
  assert.equal(ledger.report("ana")[0]?.entries.length, 0);
  assert.deepEqual(ledger.pendingClockMessages("line", group.uid), []);
});

test("natural clock tools bind the provider timestamp and message UID, never the model's arguments or the owner's identity", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage(profile, "natural-profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Site", summary: "Landing page" }, "natural-demand");
  const cfg = { channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line" } } };
  t.mock.method(globalThis, "fetch", async () => Response.json(group));
  function clockTool(messageUid: string, createdAt: string, options: { owner?: boolean; handle?: string; stale?: boolean } = {}) {
    let tool: Tool | undefined;
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: `agent:main:plow:group:${group.uid}`, messageChannel: "plow", agentAccountId: "chat",
          nativeChannelId: group.uid, requesterSenderId: options.owner ? "plow-owner" : contractor.provider_key, senderIsOwner: Boolean(options.owner),
          assertInvocationCurrent() { if (options.stale) throw new Error("Expired turn"); },
          toolBindings: { plowHoursClock: { line_uid: "line", chat_uid: group.uid, handle: options.handle ?? contractor.provider_key,
            message_uid: messageUid, created_at: createdAt, body: "An ordinary natural-language message" } } });
        if (candidate.name === "plow_hours_self") tool = candidate;
      },
    });
    assert.ok(tool); return tool;
  }
  const start = clockTool("natural-start", "2026-10-02T09:00:00-03:00");
  await assert.rejects(() => start.execute("invented-time", { action: "start", demand_id: "landing", created_at: "2020-01-01T00:00:00Z" }));
  await assert.rejects(() => clockTool("owner", "2026-10-02T09:00:00-03:00", { owner: true }).execute("owner-clock", { action: "start", demand_id: "landing" }), /Owner group turns can only/);
  await assert.rejects(() => clockTool("wrong", "2026-10-02T09:00:00-03:00", { handle: "+15550000003" }).execute("wrong-clock", { action: "start", demand_id: "landing" }), /source does not match/);
  await assert.rejects(() => clockTool("expired", "2026-10-02T09:00:00-03:00", { stale: true }).execute("expired-clock", { action: "start", demand_id: "landing" }), /Expired turn/);
  await start.execute("first-call", { action: "start", demand_id: "landing" });
  await start.execute("another-call-id", { action: "start", demand_id: "landing" });
  assert.equal(ledger.report("ana")[0]?.entries.length, 1);
  assert.equal(ledger.report("ana")[0]?.open_entry?.start_ms, Date.parse("2026-10-02T09:00:00-03:00"));
  await clockTool("natural-stop", "2026-10-02T11:30:00-03:00").execute("stop-call", { action: "stop", details: "commit abc123" });
  await start.execute("late-replay", { action: "start", demand_id: "landing" });
  assert.equal(ledger.report("ana")[0]?.entries.length, 1);
  assert.equal(ledger.report("ana")[0]?.total_hours, 2.5);
  assert.equal(ledger.report("ana")[0]?.open_entry, null);
});

test("natural owner approval is scoped to the current private DM and exact reviewed data", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS; process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger(); ledger.manage(profile, "profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Website", summary: "Landing page" }, "demand");
  ledger.manage({ action: "manual", contractor_id: "ana", demand_id: "landing", start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", rate_cents: 3000, reason: "Worker confirmed missing start" }, "hours");
  ledger.manage({ action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-02" }, "request");
  ledger.self({ action: "invoice", invoice: { number: "NF-1", url: "https://private.example.test/nf.pdf", currency: "USD", amount_cents: 3000, period_start: "2026-10-02", period_end: "2026-10-02" } }, "ana", "invoice");
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", document_url: "https://private.example.test/pix.pdf" } }, "ana", "pix");
  ledger.manage({ action: "close_period", contractor_id: "ana" }, "close");
  const before = ledger.billingReport("ana"); assert.ok(before.fingerprint);
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" }, cfg = { channels: { plow: account } };
  t.mock.method(globalThis, "fetch", async () => Response.json(home));
  function tool(bindingHandle = owner.provider_key, bindingChat = home.uid) {
    let ownerTool: Tool | undefined;
    entry.register({ registrationMode: "full", runtime: {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
      registerTool(factory: (context: object) => Tool) {
        const candidate = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: home.uid,
          requesterSenderId: "plow-owner", senderIsOwner: true, toolBindings: { plowHoursOwner: { line_uid: "line", chat_uid: bindingChat, handle: bindingHandle, message_uid: "approval", created_at: "2026-10-03T12:00:00Z", body: "I reviewed Ana's invoice and Pix instructions. Approve these USD 30 for her." } } });
        if (candidate.name === "plow_hours") ownerTool = candidate;
      },
    });
    assert.ok(ownerTool); return ownerTool;
  }
  const ownerTool = tool();
  assert.match(JSON.stringify(await ownerTool.execute("guide", { action: "guide" })), /Contractor hours/);
  await assert.rejects(() => ownerTool.execute("arbitrary-file", { action: "guide", path: "/var/lib/plow/openclaw.json" }));
  const approval = { action: "approve_billing", contractor_id: "ana", fingerprint: before.fingerprint };
  await assert.rejects(() => tool(contractor.provider_key).execute("worker-claimed-owner", approval), /verified owner message/);
  await assert.rejects(() => tool(owner.provider_key, group.uid).execute("group-binding", approval), /verified owner message/);
  await ownerTool.execute("owner-approval", approval);
  assert.equal(ledger.billingReport("ana").approved, true); assert.equal(ledger.billingReport("ana").paid, false);
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana New", document_url: "https://private.example.test/new.pdf" } }, "ana", "changed-pix");
  await assert.rejects(() => ownerTool.execute("stale-approval", approval), /changed/);
  assert.equal(ledger.billingReport("ana").approved, false);
});
