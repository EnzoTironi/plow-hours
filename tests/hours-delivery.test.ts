import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { clearOwnerAnswer, ownerAnswerIsPrivate, findContractorGroups, ownerPrivateConversation } from "../plugin/hours-channel.ts";
import { DeliveryUnknownError, HttpError } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Tool = { name: string; execute: (id: string, args: unknown) => Promise<unknown> };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const worker = { ...owner, uid: "worker", role: "member", display_name: "Alex", provider_key: "alex@example.test" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };
const group = { uid: "cht_alex", status: "active", trusted: false, participants: [owner, worker, self] };
const introduction = { members: [worker.provider_key], body: "Hi Alex, Dane asked me to track your hours.", trusted: false };

test("private routing binds the actual group owner to their live DM, rejecting workers and changed identities", async t => {
  await websocketFixture(t);
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" };
  let current = group, privateChat = home;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith(group.uid)) return Response.json(current);
    if (url.endsWith(home.uid)) return Response.json(privateChat);
    if (url.endsWith("/v1/chats")) return Response.json({ data: [privateChat, current], has_more: false });
    assert.fail("Unexpected provider request: " + url);
  });
  const message = { uid: "owner-group-request", sender: owner, direction: "inbound", body: "Ours, send me the dashboard.", created_at: "2026-10-05T21:00:00Z", attachments: [] };
  const destination = await ownerPrivateConversation(account, group, message);
  assert.equal(destination.chat.uid, home.uid); assert.deepEqual(destination.sender, owner);
  await assert.rejects(() => ownerPrivateConversation(account, group, { ...message, sender: worker }), /verified owner/);
  await assert.rejects(() => ownerPrivateConversation(account, group, { ...message, sender: { ...worker, role: "owner" } }), /verified owner/);
  current = { ...group, participants: [self, { ...owner, role: "member" }, worker] };
  await assert.rejects(() => ownerPrivateConversation(account, group, message), /verified owner/);
  current = group;
  privateChat = { ...home, participants: [self, { ...owner, provider_key: "+15550000999" }] };
  await assert.rejects(() => ownerPrivateConversation(account, group, message), /private destination/);
  privateChat = { ...home, participants: [{ ...self, line: { uid: "another-line" } }, owner] };
  await assert.rejects(() => ownerPrivateConversation(account, group, message), /owner/);
});

test("an owner group turn keeps its native source and reply destination in the group", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const source = { ...group, display_name: "Enzo, Pueblo and Alder", participants: [
    { ...owner, uid: "owner-in-group", display_name: "Enzo" }, { ...worker, display_name: "Pueblo" }, self,
  ] };
  const destination = { ...home, display_name: "Private owner chat", participants: [{ ...owner, display_name: "Enzo" }, self] };
  hoursLedger().manage({ action: "contractor", id: "pueblo", name: "Pueblo", handle: worker.provider_key,
    chat_uid: source.uid, timezone: "America/Sao_Paulo", rate_cents: 2000 }, "register-pueblo");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify({ participate: true }) } }] });
    if (path.endsWith("/ws/ticket")) return Response.json({ ticket: "fixture" });
    if (path === "/v1/chats") return Response.json({ data: [destination, source], has_more: false });
    if (path.endsWith("/messages")) return Response.json({ data: [], has_more: false });
    if (path.endsWith(`/${source.uid}`)) return Response.json(source);
    if (path.endsWith(`/${destination.uid}`)) return Response.json(destination);
    assert.fail("Unexpected provider request: " + path);
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    socket.send(JSON.stringify({ event_type: "message_received", event_id: "human-question", chat_id: source.uid,
      data: { message: { uid: "human-question", sender: source.participants[0], direction: "inbound", attachments: [],
        created_at: "2026-10-05T21:00:00Z", body: "Alder, pode pedir para o Pueblo registrar o trabalho a partir de agora por aqui?" } } }));
  });
  const contextSchema = z.object({
    from: z.string(), route: z.object({ sessionKey: z.string() }),
    conversation: z.object({ kind: z.string(), id: z.string(), nativeChannelId: z.string(), label: z.string(), routePeer: z.object({ kind: z.string(), id: z.string() }) }),
    reply: z.object({ to: z.string(), nativeChannelId: z.string() }),
    message: z.object({ rawBody: z.string() }),
    supplemental: z.object({ channelStructuredContext: z.array(z.object({ payload: z.object({
      participants: z.array(z.object({ name: z.string(), type: z.string(), role: z.string() })),
      message_origin: z.object({ kind: z.string(), chat_uid: z.string() }),
      final_reply_destination: z.object({ kind: z.string(), chat_uid: z.string() }),
    }) })) }),
  });
  let seen: z.infer<typeof contextSchema> | undefined;
  const account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "untrusted" };
  const cfg = { agents: { entries: { main: { identity: { name: "Alder" } } } }, channels: { plow: account } };
  let channel: { gateway: { startAccount: (value: object) => Promise<void> } } | undefined;
  entry.register({ registrationMode: "full", logger: { info() {} }, registerTool() {}, registerHttpRoute() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
    runtime: { channel: { routing: { resolveAgentRoute }, session: { resolveStorePath, updateLastRoute }, inbound: {
      buildContext(raw: unknown) { seen = contextSchema.parse(raw); return { SessionKey: seen.route.sessionKey }; },
      async dispatch({ replyOptions, delivery }: { delivery: { durable(): Promise<{ to: string }> }, replyOptions: { turnAdoptionLifecycle: { onAdopted(): Promise<void> } } }) {
        assert.equal((await delivery.durable()).to, source.uid);
        await replyOptions.turnAdoptionLifecycle.onAdopted();
        return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: true } };
      },
    } } },
  });
  assert.ok(channel);
  const controller = abortAfter(10_000);
  const logs: string[] = [];
  await channel.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(value: string) {
    logs.push(value); if (value.includes("stage=terminal")) controller.abort();
  } } });
  assert.ok(seen, logs.join("\n"));
  assert.ok(logs.some(value => value.includes("stage=terminal")), logs.join("\n"));
  assert.equal(seen.from, `plow:group:${source.uid}`);
  assert.equal(seen.conversation.kind, "group"); assert.equal(seen.conversation.id, source.uid);
  assert.equal(seen.conversation.label, source.display_name);
  assert.deepEqual(seen.supplemental.channelStructuredContext[0]?.payload.message_origin, { kind: "group", chat_uid: source.uid });
  assert.deepEqual(seen.supplemental.channelStructuredContext[0]?.payload.final_reply_destination, { kind: "group", chat_uid: source.uid });
  assert.equal(seen.message.rawBody, "Alder, pode pedir para o Pueblo registrar o trabalho a partir de agora por aqui?");
  assert.deepEqual(seen.supplemental.channelStructuredContext[0]?.payload.participants.map(p => p.name), ["Enzo", "Pueblo", "Alder"]);
  assert.equal(seen.route.sessionKey, `agent:main:plow:owner-group:${source.uid}`);
  assert.equal(seen.conversation.nativeChannelId, source.uid);
  assert.deepEqual(seen.conversation.routePeer, { kind: "group", id: source.uid });
  assert.equal(seen.reply.to, `plow:${source.uid}`); assert.equal(seen.reply.nativeChannelId, source.uid);
});

function ownerTools(senderIsOwner = true, overrides: object = {}) {
  const tools = new Map<string, Tool>();
  const cfg = {
    channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line", threadTrust: "untrusted" } },
    plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } },
  };
  entry.register({ registrationMode: "full", logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
    runtime: { channel: { routing: { resolveAgentRoute }, session: { resolveStorePath, updateLastRoute } } },
    registerTool(factory: (context: object) => Tool) {
      const tool = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat",
        nativeChannelId: home.uid, requesterSenderId: "plow-owner", senderIsOwner, ...overrides });
      tools.set(tool.name, tool);
    },
  });
  return (name: string) => { const tool = tools.get(name); assert.ok(tool); return tool; };
}

test("accepted group requests and saved rosters do not claim iMessage availability or delivery", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/v1/chats")) {
      if (init.method === "GET") return Response.json({ data: [home], has_more: false });
      assert.equal(init.method, "POST"); requests.push(JSON.parse(String(init.body)));
      return Response.json({ uid: group.uid });
    }
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith("/agents/me")) return Response.json({ agent: { web_url: "https://hours.example.test" } });
    assert.fail("Unexpected provider request: " + url);
  });
  const tool = ownerTools();
  const receipt = z.object({ details: z.object({ chat_uid: z.literal(group.uid), request_status: z.literal("accepted"), delivery_status: z.literal("unconfirmed") }).passthrough() });
  const first = receipt.parse(await tool("plow_start_thread").execute("intro", introduction));
  assert.ok(!("message_sent" in first.details));
  await tool("plow_start_thread").execute("intro", introduction);
  assert.deepEqual(requests[0], requests[1], "The existing idempotency key is preserved on a replay");
  await assert.rejects(() => ownerTools(false)("plow_start_thread").execute("member", introduction), /owner's main Plow DM/);
  const registered = z.object({ details: z.object({ registered: z.literal(true), roster_verified: z.literal(true), verification_scope: z.string() }).passthrough() })
    .parse(await tool("plow_hours").execute("register", { action: "contractor", id: "alex", name: "Alex", handle: worker.provider_key, chat_uid: group.uid, timezone: "America/New_York", rate_cents: 2000 }));
  assert.ok(!("thread_verified" in registered.details));
  assert.match(registered.details.verification_scope, /delivery have not been checked/);
});

test("rejections, transport failures and malformed accepted responses produce no success receipt or automatic retry", async t => {
  await websocketFixture(t);
  let groupPosts = 0;
  let response: () => Response = () => Response.json({ uid: group.uid });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    if (init.method === "GET" && url.endsWith("/v1/chats")) return Response.json({ data: [home], has_more: false });
    assert.ok(url.endsWith("/v1/chats")); groupPosts++;
    return response();
  });
  const tool = ownerTools()("plow_start_thread");
  for (const status of [400, 403, 422, 429]) {
    response = () => Response.json({ error: "Request rejected" }, { status });
    const before = groupPosts;
    await assert.rejects(() => tool.execute(`reject-${status}`, introduction), (error: unknown) => error instanceof HttpError && error.status === status);
    assert.equal(groupPosts, before + 1);
  }
  for (const status of [408, 424, 500, 503]) {
    response = () => Response.json({ error: "Outcome unknown" }, { status });
    const before = groupPosts;
    await assert.rejects(() => tool.execute(`uncertain-${status}`, introduction), DeliveryUnknownError);
    assert.equal(groupPosts, before + 1);
  }
  for (const body of [{}, { uid: "" }, { uid: " " }, { uid: null }, { uid: 42 }]) {
    response = () => Response.json(body);
    const before = groupPosts;
    await assert.rejects(() => tool.execute("malformed", introduction), DeliveryUnknownError);
    assert.equal(groupPosts, before + 1);
  }
  response = () => { throw new TypeError("Fixture connection lost after request"); };
  const before = groupPosts;
  await assert.rejects(() => tool.execute("disconnected", introduction), DeliveryUnknownError);
  assert.equal(groupPosts, before + 1);
  response = () => new Response("Malformed JSON", { status: 200 });
  await assert.rejects(() => tool.execute("invalid-json", introduction), DeliveryUnknownError);
  assert.equal(groupPosts, before + 2);
  assert.deepEqual(hoursLedger().report(), []);
});

test("durable follow-ups report acceptance only, and malformed message responses remain uncertain", async t => {
  await websocketFixture(t);
  let posts = 0;
  let malformed = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith(`/chats/${group.uid}/messages`)) {
      assert.equal(init.method, "POST"); posts++;
      return Response.json(malformed ? {} : { uid: "msg_intro" });
    }
    assert.fail("Unexpected provider request: " + url);
  });
  const tool = ownerTools()("plow_reply_to");
  const receipt = z.object({ details: z.object({ message_uid: z.literal("msg_intro"), request_status: z.literal("accepted"), delivery_status: z.literal("unconfirmed") }) });
  receipt.parse(await tool.execute("followup", { chat_uid: group.uid, text: "Alex, are you able to see this group?" }));
  assert.equal(posts, 1);
  malformed = true;
  await assert.rejects(() => tool.execute("malformed-followup", { chat_uid: group.uid, text: "Another requested message." }), DeliveryUnknownError);
  assert.equal(posts, 2, "An uncertain response is not retried");
});

test("explicit follow-ups and group introductions reject internal protocol before any provider POST", async t => {
  await websocketFixture(t);
  const posts: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") { posts.push(url); assert.fail("Internal protocol reached the provider"); }
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    assert.fail("Unexpected provider request: " + url);
  });
  const tool = ownerTools();
  for (const text of [
    '<tool_call>plow_hours_self(action="start")',
    '<tool_call',
    '<function=plow_hours_self><arg_key>action</arg_key><arg_value>start</arg_value>',
    '<think>Let me check the tools.</think>Recorded.',
    '[TOOL_CALLS] [{"name":"plow_hours_self"}]',
    '> reasoning: The owner is speaking to Alex.',
    "This is just a casual comment confirming he's working, no clock action needed - already recorded as note.",
    "The latest message does not need a reply; I should stay quiet.",
    "Isso é apenas um comentário casual, não precisa de resposta.",
  ]) {
    await assert.rejects(() => tool("plow_reply_to").execute("bad-followup", { chat_uid: group.uid, text }), /Internal tool or reasoning protocol/);
    await assert.rejects(() => tool("plow_start_thread").execute("bad-introduction", { ...introduction, body: text }), /Internal tool or reasoning protocol/);
  }
  assert.deepEqual(posts, []);
});

test("the shared channel sender rejects tool protocol while preserving ordinary work descriptions", async t => {
  await websocketFixture(t);
  const cfg = { channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line" } } };
  let outbound: { sendText(ctx: { cfg: object; to: string; text: string; accountId: string }): Promise<unknown> } | undefined;
  entry.register({ registrationMode: "full", logger: { info() {} }, registerTool() {}, registerHttpRoute() {},
    registerChannel(value: { plugin: { outbound: typeof outbound } }) { outbound = value.plugin.outbound; },
  });
  assert.ok(outbound);
  const posts: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith(group.uid)) return Response.json(group);
    assert.equal(url, `http://fixture/v1/chats/${group.uid}/messages`);
    assert.equal(init.method, "POST");
    posts.push(z.object({ body: z.string() }).parse(JSON.parse(String(init.body))).body);
    return Response.json({ uid: "msg_safe_reply" });
  });
  await assert.rejects(() => outbound.sendText({ cfg, to: group.uid, accountId: "chat",
    text: '<tool_call>plow_hours_self_start(work="")=' }), /Internal tool or reasoning protocol/);
  assert.deepEqual(posts, []);
  const text = "Started fixing tool calls in the animation for Rowan. Pix: 00000000000.";
  await outbound.sendText({ cfg, to: group.uid, accountId: "chat", text });
  assert.deepEqual(posts, [text]);
});

test("correcting a contact preserves earlier hours under the original sender and starts a separate registration", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const wrong = { ...group, uid: "cht_alex_wrong", participants: [owner, { ...worker, provider_key: "alex@wrong.example.test" }, self] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(wrong.uid)) return Response.json(wrong);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith("/agents/me")) return Response.json({ agent: { web_url: "https://hours.example.test" } });
    assert.fail("Unexpected provider request: " + url);
  });
  const tool = ownerTools()("plow_hours");
  const setup = { action: "contractor", name: "Alex", timezone: "America/New_York", rate_cents: 2000 };
  await tool.execute("old-contact", { ...setup, id: "alex-old", handle: "alex@wrong.example.test", chat_uid: wrong.uid });
  await tool.execute("old-work", { action: "demand", contractor_id: "alex-old", id: "landing", project: "Website", summary: "Landing page" });
  await tool.execute("old-hours", { action: "manual", contractor_id: "alex-old", demand_id: "landing", start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", rate_cents: 2000, reason: "Owner confirmed historical work" });
  const earlier = hoursLedger().report("alex-old")[0].entries;
  await assert.rejects(() => tool.execute("unsafe-rebind", { ...setup, id: "alex-old", handle: worker.provider_key, chat_uid: group.uid }), /binding cannot be reassigned/);
  await tool.execute("deactivate-wrong", { action: "deactivate", contractor_id: "alex-old", reason: "Owner supplied the corrected iMessage contact" });
  await tool.execute("correct-contact", { ...setup, id: "alex", handle: worker.provider_key, chat_uid: group.uid });
  await tool.execute("correct-work", { action: "demand", contractor_id: "alex", id: "landing", project: "Website", summary: "Landing page" });
  assert.equal(hoursLedger().report("alex-old")[0].contractor.active, 0);
  assert.deepEqual(hoursLedger().report("alex-old")[0].entries, earlier);
  assert.deepEqual(hoursLedger().report("alex")[0].entries, []);
  assert.equal(hoursLedger().report("alex")[0].contractor.handle, worker.provider_key);
});


test("isolated owner group sessions retain authorization only with the bound source and live matching owner", async t => {
  await websocketFixture(t);
  let current = group;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(current);
    if (url.endsWith("/v1/chats")) return Response.json({ data: [home, current], has_more: false });
    if (url.endsWith("/agents/me")) return Response.json({ line: { uid: "line" }, agent: { web_url: "https://hours.example.test" } });
    assert.fail("Unexpected provider request: " + url);
  });
  const context = { sessionKey: "agent:main:plow:owner-group:" + group.uid, nativeChannelId: group.uid,
    toolBindings: { plowHoursOwner: { line_uid: "line", chat_uid: group.uid, handle: owner.provider_key,
      message_uid: "owner-dashboard", created_at: "2026-10-06T12:00:00Z", body: "Send my dashboard" } } };
  const tools = ownerTools(true, context);
  const receipt = await tools("plow_hours").execute("dashboard", { action: "dashboard" });
  assert.ok(receipt);
  assert.equal(ownerAnswerIsPrivate(context.toolBindings.plowHoursOwner), true);
  const separatelyLoaded = await import("../plugin/hours-channel.ts?separate-plugin-loader");
  assert.equal(separatelyLoaded.ownerAnswerIsPrivate(context.toolBindings.plowHoursOwner), true, "Tool and channel loaders share the per-message routing decision");
  assert.equal(separatelyLoaded.claimOwnerNotice(context.toolBindings.plowHoursOwner), true);
  assert.equal(separatelyLoaded.claimOwnerNotice(context.toolBindings.plowHoursOwner), false);
  assert.equal(ownerAnswerIsPrivate({ ...context.toolBindings.plowHoursOwner, message_uid: "different-request" }), false);
  clearOwnerAnswer(context.toolBindings.plowHoursOwner);
  assert.equal(ownerAnswerIsPrivate(context.toolBindings.plowHoursOwner), false);
  assert.match(JSON.stringify(receipt), /reply_routing/);
  assert.match(JSON.stringify(receipt), /private_answer/);
  await assert.rejects(() => ownerTools(true, { ...context, nativeChannelId: home.uid })("plow_hours").execute("wrong-source", { action: "dashboard" }), /group source changed/);
  await assert.rejects(() => tools("plow_hours").execute("group-approval", { action: "approve_billing", contractor_id: "ana", fingerprint: "a".repeat(64) }), /verified owner message in the private DM/);
  await assert.rejects(() => ownerTools(true, { ...context, toolBindings: {} })("plow_hours").execute("missing-source", { action: "dashboard" }), /owner's main Plow DM/);
  await assert.rejects(() => ownerTools(true, { ...context, sessionKey: "agent:main:plow:owner-group:another" })("plow_hours").execute("wrong-group", { action: "dashboard" }), /owner's main Plow DM/);
  current = { ...group, participants: [self, worker, { ...owner, role: "member" }] };
  await assert.rejects(() => tools("plow_hours").execute("revoked", { action: "dashboard" }), /group owner/);
});


test("existing contractor group is discovered and reused without creation or introduction", async t => {
  await websocketFixture(t);
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") { posts++; assert.fail("Reusing a group must not send or create"); }
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith("/v1/chats")) return Response.json({ data: [home, group], has_more: false });
    assert.fail("Unexpected request " + url);
  });
  const tools = ownerTools();
  const found = z.object({ details: z.object({ status: z.literal("found"), groups: z.array(z.object({ chat_uid: z.literal(group.uid) })) }) }).parse(await tools("plow_hours").execute("find", { action: "find_group", handle: worker.provider_key.toUpperCase() }));
  assert.equal(found.details.groups.length, 1);
  hoursLedger().manage({ action: "contractor", id: "alex", name: "Alex", handle: worker.provider_key,
    chat_uid: group.uid, timezone: "America/Sao_Paulo", rate_cents: 2000 }, "register-alex");
  const named = z.object({ details: z.object({ status: z.literal("found"), groups: z.array(z.object({ chat_uid: z.literal(group.uid), contractor_id: z.literal("alex") })) }) })
    .parse(await tools("plow_hours").execute("find-name", { action: "find_group", handle: "aLeX" }));
  assert.equal(named.details.groups.length, 1);
  const reused = z.object({ details: z.object({ chat_uid: z.literal(group.uid), reused: z.literal(true), introduction_sent: z.literal(false), request_status: z.literal("existing") }) }).parse(await tools("plow_start_thread").execute("reuse", introduction));
  assert.ok(reused); assert.equal(posts, 0);
});

test("a saved contractor name resolves only verified groups and duplicate names stay ambiguous", async t => {
  await websocketFixture(t);
  const other = { ...group, uid: "cht_other_alex", participants: [owner, { ...worker, uid: "other-worker", provider_key: "other@example.test" }, self] };
  for (const [id, chat] of [["alex", group], ["other", other]] as const) {
    const member = chat.participants.find(p => p.type === "member" && p.role !== "owner");
    assert.ok(member?.type === "member");
    hoursLedger().manage({ action: "contractor", id, name: "Alex", handle: member.provider_key,
      chat_uid: chat.uid, timezone: "America/Sao_Paulo", rate_cents: 2000 }, "register-" + id);
  }
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/v1/chats")) return Response.json({ data: [home, group, other], has_more: false });
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith(other.uid)) return Response.json(other);
    assert.fail("Unexpected provider request: " + url);
  });
  const found = await findContractorGroups({ apiBase: "http://fixture", accountId: "chat", lineUid: "line" }, home, "Alex");
  assert.equal(found.status, "ambiguous"); assert.equal(found.groups.length, 2);
});

test("a creation conflict triggers a fresh lookup and reuses a newly visible group without retrying POST", async t => {
  await websocketFixture(t);
  let visible = false, posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    assert.ok(url.endsWith("/v1/chats"));
    if (init.method === "POST") { posts++; visible = true; return Response.json({ error: "Conflict" }, { status: 409 }); }
    return Response.json({ data: visible ? [home, group] : [home], has_more: false });
  });
  const receipt = z.object({ details: z.object({ chat_uid: z.literal(group.uid), reused: z.literal(true), introduction_sent: z.literal(false) }) });
  receipt.parse(await ownerTools()("plow_start_thread").execute("race", introduction));
  assert.equal(posts, 1);
});

test("multiple matching groups require a choice and never create another group", async t => {
  await websocketFixture(t);
  const other = { ...group, uid: "cht_other" };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    assert.notEqual(init.method, "POST");
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith(other.uid)) return Response.json(other);
    return Response.json({ data: [home, group, other], has_more: false });
  });
  const tools = ownerTools();
  const result = z.object({ details: z.object({ status: z.literal("ambiguous"), groups: z.array(z.object({ chat_uid: z.string() })) }) }).parse(await tools("plow_hours").execute("find", { action: "find_group", handle: worker.provider_key }));
  assert.equal(result.details.groups.length, 2);
  await assert.rejects(() => tools("plow_start_thread").execute("ambiguous", introduction), /Several matching/);
});

test("an unresolved conflict is a blocked setup, not evidence of an existing group", async t => {
  await websocketFixture(t);
  const otherBotGroup = { ...group, participants: [owner, worker, { ...self, line: { uid: "another-bot" } }] };
  let posts = 0;
  let rejection = () => Response.json({ error: "Conflict" }, { status: 409 });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (url.endsWith(home.uid)) return Response.json(home);
    assert.ok(url.endsWith("/v1/chats"));
    if (init.method === "POST") { posts++; return rejection(); }
    return Response.json({ data: [home, otherBotGroup], has_more: false });
  });
  const result = z.object({ details: z.object({ request_status: z.literal("rejected"), registered: z.literal(false),
    introduction_sent: z.literal(false), reason: z.literal("unresolved_group_conflict"), cause: z.literal("unknown"),
    lookup_scope: z.literal("this_bot"), provider_error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional() }).strict().extend({ next_step: z.string(), owner_message: z.string() }) });
  const tool = ownerTools()("plow_start_thread");
  const first = result.parse(await tool.execute("blocked", introduction));
  assert.deepEqual(first.details.provider_error, { message: "Conflict" });
  rejection = () => Response.json({ error: { code: "fixture_conflict", message: "Fixture refusal", extra: "Do not copy unrelated fields" } }, { status: 409 });
  const second = result.parse(await tool.execute("structured-rejection", introduction));
  assert.deepEqual(second.details.provider_error, { code: "fixture_conflict", message: "Fixture refusal" });
  rejection = () => new Response("Invalid JSON error body", { status: 409 });
  const third = result.parse(await tool.execute("malformed-rejection", introduction));
  assert.equal(third.details.provider_error, undefined);
  assert.equal(posts, 3, "Exactly one POST per explicit invocation; none automatically retried");
});

test("group lookup rejects wrong owner, agent, contact, trust, extra members and stale roster", async t => {
  await websocketFixture(t);
  const account = { apiBase: "http://fixture", accountId: "chat", lineUid: "line" };
  let rows = [group], fresh = group;
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/v1/chats") ? Response.json({ data: rows, has_more: false }) : Response.json(fresh));
  for (const invalid of [
    { ...group, trusted: true }, { ...group, status: "inactive" },
    { ...group, participants: [self, { ...owner, provider_key: "+15550000999" }, worker] },
    { ...group, participants: [{ ...self, line: { uid: "other-line" } }, owner, worker] },
    { ...group, participants: [self, owner, { ...worker, provider_key: "other@example.test" }] },
    { ...group, participants: [...group.participants, { ...worker, uid: "extra" }] },
  ]) {
    rows = [invalid]; fresh = invalid;
    assert.equal((await findContractorGroups(account, home, worker.provider_key)).status, "not_found");
  }
  rows = [group]; fresh = { ...group, trusted: true };
  assert.equal((await findContractorGroups(account, home, worker.provider_key)).status, "not_found");
});

test("incomplete or unavailable discovery never claims no existing group or starts a duplicate", async t => {
  await websocketFixture(t);
  let unavailable = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    assert.notEqual(init.method, "POST");
    if (url.endsWith(home.uid)) return Response.json(home);
    return unavailable ? Response.json({}, { status: 503 }) : Response.json({ data: [home], has_more: true });
  });
  const tool = ownerTools()("plow_start_thread");
  await assert.rejects(() => tool.execute("truncated", introduction), /incomplete/);
  unavailable = true;
  await assert.rejects(() => tool.execute("unavailable", introduction), (error: unknown) => error instanceof HttpError && error.status === 503);
});


test("one private answer delivers its source notice once, without making delivery depend on the notice", async t => {
  await websocketFixture(t);
  const posts: { chat: string; body: string }[] = [];
  let uncertainNotice = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") {
      const chat = url.includes(`/chats/${home.uid}/`) ? home.uid : group.uid;
      posts.push({ chat, body: JSON.parse(String(init.body)).body });
      return Response.json(chat === group.uid && uncertainNotice ? {} : { uid: `sent_${posts.length}` });
    }
    if (url.endsWith(home.uid)) return Response.json(home);
    if (url.endsWith(group.uid)) return Response.json(group);
    if (url.endsWith("/v1/chats")) return Response.json({ data: [home, group], has_more: false });
    if (url.endsWith("/agents/me")) return Response.json({ line: { uid: "line" }, agent: { web_url: "https://hours.example.test" } });
    assert.fail("Unexpected request " + url);
  });
  for (const mode of ["normal", "suppressed", "uncertain"] as const) {
    uncertainNotice = mode === "uncertain";
    const source = { line_uid: "line", chat_uid: group.uid, handle: owner.provider_key,
      message_uid: mode, created_at: "2026-10-06T12:00:00Z", body: "Send my dashboard" };
    const tools = ownerTools(true, { sessionKey: "agent:main:plow:owner-group:" + group.uid,
      nativeChannelId: group.uid, toolBindings: { plowHoursOwner: source } });
    await tools("plow_hours").execute("dashboard-" + mode, { action: "dashboard" });
    const before = posts.length;
    await assert.rejects(() => tools("plow_reply_to").execute("notice-only", { chat_uid: group.uid, text: "I'll reply privately." }), /actual answer/);
    await assert.rejects(() => tools("plow_reply_to").execute("unsafe-notice", { chat_uid: home.uid, text: "Your dashboard.", source_notice: "USD 500" }), /without private data/);
    assert.equal(posts.length, before);
    const source_notice = mode === "suppressed" ? "" : "Vou te responder no privado.";
    await tools("plow_reply_to").execute("answer-" + mode, { chat_uid: home.uid, text: "Your dashboard: https://hours.example.test/hours", source_notice });
    assert.deepEqual(posts.slice(before), [
      ...(mode === "suppressed" ? [] : [{ chat: group.uid, body: source_notice }]),
      { chat: home.uid, body: "Your dashboard: https://hours.example.test/hours" },
    ]);
    await tools("plow_reply_to").execute("followup-" + mode, { chat_uid: home.uid, text: "Another requested detail.", source_notice });
    assert.equal(posts.slice(before).filter(p => p.chat === group.uid).length, mode === "suppressed" ? 0 : 1);
    clearOwnerAnswer(source);
  }
});
