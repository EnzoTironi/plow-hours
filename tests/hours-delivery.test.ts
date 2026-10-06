import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { DeliveryUnknownError, HttpError } from "../plugin/transport.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Tool = { name: string; execute: (id: string, args: unknown) => Promise<unknown> };
const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const worker = { ...owner, uid: "worker", role: "member", display_name: "Alex", provider_key: "alex@example.test" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };
const group = { uid: "cht_alex", status: "active", trusted: false, participants: [owner, worker, self] };
const introduction = { members: [worker.provider_key], body: "Hi Alex, Dane asked me to track your hours.", trusted: false };

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
