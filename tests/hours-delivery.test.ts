import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { ownerPrivateConversation } from "../plugin/hours-channel.ts";
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

test("an owner group turn keeps the original people and conversation facts while tools and delivery stay private", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const source = { ...group, display_name: "Enzo, Pueblo and Alder", participants: [
    { ...owner, uid: "owner-in-group", display_name: "Enzo" }, { ...worker, display_name: "Pueblo" }, self,
  ] };
  const destination = { ...home, display_name: "Private owner chat", participants: [{ ...owner, display_name: "Enzo" }, self] };
  hoursLedger().manage({ action: "contractor", id: "pueblo", name: "Pueblo", handle: worker.provider_key,
    chat_uid: source.uid, timezone: "America/Sao_Paulo", rate_cents: 2000 }, "register-pueblo");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(url).pathname;
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
    conversation: z.object({ kind: z.string(), id: z.string(), nativeChannelId: z.string(), label: z.string() }),
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
      async dispatch({ replyOptions }: { replyOptions: { turnAdoptionLifecycle: { onAdopted(): Promise<void> } } }) {
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
  assert.deepEqual(seen.supplemental.channelStructuredContext[0]?.payload.final_reply_destination, { kind: "direct", chat_uid: destination.uid });
  assert.ok(seen.message.rawBody.includes(source.uid));
  assert.match(seen.message.rawBody, /Message origin:.*"kind":"group"/);
  assert.ok(seen.message.rawBody.endsWith("Alder, pode pedir para o Pueblo registrar o trabalho a partir de agora por aqui?"));
  assert.deepEqual(seen.supplemental.channelStructuredContext[0]?.payload.participants.map(p => p.name), ["Enzo", "Pueblo", "Alder"]);
  assert.equal(seen.route.sessionKey, "agent:main:main");
  assert.equal(seen.conversation.nativeChannelId, destination.uid);
  assert.equal(seen.reply.to, `plow:${destination.uid}`); assert.equal(seen.reply.nativeChannelId, destination.uid);
});

function ownerTools(senderIsOwner = true) {
  const tools = new Map<string, Tool>();
  const cfg = {
    channels: { plow: { apiBase: "http://fixture", accountId: "chat", lineUid: "line", threadTrust: "untrusted" } },
    plugins: { load: { paths: [new URL("../plugin/", import.meta.url).pathname] }, entries: { plow: { enabled: true } } },
  };
  entry.register({ registrationMode: "full", logger: { info() {} }, registerChannel() {}, registerHttpRoute() {},
    runtime: { channel: { routing: { resolveAgentRoute }, session: { resolveStorePath, updateLastRoute } } },
    registerTool(factory: (context: object) => Tool) {
      const tool = factory({ config: cfg, sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat",
        nativeChannelId: home.uid, requesterSenderId: "plow-owner", senderIsOwner });
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
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith(home.uid)) return Response.json(home);
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
