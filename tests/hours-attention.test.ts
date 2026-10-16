import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldParticipate } from "../plugin/hours-attention.ts";
import { websocketFixture } from "./ws-fixture.ts";

test("group attention uses source participants and recent replies without tools or other chats", async t => {
  await websocketFixture(t);
  const owner = { type: "member" as const, uid: "owner", role: "owner" as const, display_name: "Dane", provider_key: "dane@example.test" };
  const worker = { ...owner, uid: "worker", role: "member" as const, display_name: "Alex", provider_key: "alex@example.test" };
  const agent = { type: "agent" as const, relationship: "self" as const, line: { uid: "line", display_name: "Elm" } };
  const chat = { uid: "group", status: "active" as const, participants: [owner, worker, agent] };
  const message = { uid: "current", sender: worker, direction: "inbound" as const, body: "Started working", created_at: "2026-10-06T12:00:00Z", attachments: [], // Plow's MessageReplyResource: the replied-to message is wrapped with the part being answered.
    reply_to: { part_index: 0, message: { uid: "question", sender: agent, body: "What are you working on?", direction: "outbound" as const, created_at: "2026-10-06T11:59:00Z", attachments: [] } } };
  let result = '{"participate":true}';
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (new URL(url).pathname === "/v1/chats/group/messages") {
      assert.equal(new URL(url).searchParams.get("starting_after"), message.uid);
      historyReads++;
      return Response.json({ data: Array(6).fill(message), has_more: false });
    }
    assert.equal(new URL(url).pathname, "/v1/chat/completions");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, "anthropic/claude-sonnet-5");
    assert.equal(request.tools, undefined);
    assert.equal(request.stream, false);
    const context = JSON.parse(request.messages[1].content);
    assert.ok(context.agent_names.includes("Elm"), "The verified line name is also the agent's name");
    assert.equal(context.current.sender.role, "member");
    assert.equal(context.current.replying_to.sender.role, "agent");
    assert.equal(context.current.replying_to.body, "What are you working on?");
    assert.equal(context.recent.length, 6);
    assert.deepEqual(context.participants.map((p: { name: string }) => p.name), ["Dane", "Alex", "Elm"]);
    return Response.json({ choices: [{ message: { content: result } }] });
  });
  const decide = (history = Array(10).fill(message)) => shouldParticipate({}, { accountId: "chat", apiBase: "http://fixture", lineUid: "line" }, chat, message, history, new AbortController().signal);
  assert.equal(await decide(), true);
  result = '{"participate":false}';
  assert.equal(await decide(), false);
  assert.equal(historyReads, 0);
  assert.equal(await decide([]), false);
  assert.equal(historyReads, 1, "Contextualized native turns still read recent history from their own group");
  for (const malformed of ['{"participate":"true"}', '{"participate":true,"send":"other-chat"}', 'I should reply']) {
    result = malformed;
    await assert.rejects(decide);
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(decide);
});

test("group attention reads quoted replies and handle-less roster members without failing the decision", async t => {
  await websocketFixture(t);
  const owner = { type: "member" as const, uid: "owner", role: "owner" as const, display_name: "Dane", provider_key: "dane@example.test" };
  const worker = { ...owner, uid: "worker", role: "member" as const, display_name: "Alex", provider_key: "alex@example.test" };
  // Plow may list a member without a handle; that member is still a participant.
  const hidden = { type: "member" as const, uid: "hidden", role: "member" as const, display_name: "Sam", provider_key: null };
  const agent = { type: "agent" as const, relationship: "self" as const, line: { uid: "line", display_name: "Elm" } };
  const chat = { uid: "group", status: "active" as const, trusted: false, participants: [owner, worker, hidden, agent] };
  const quoted = { uid: "q", sender: owner, body: "Ana, can you send the invoice?", direction: "inbound" as const, created_at: "2026-10-06T11:58:00Z", attachments: [] };
  const swipe = { uid: "swipe", sender: worker, direction: "inbound" as const, body: "Sent!", created_at: "2026-10-06T12:00:00Z", attachments: [],
    reply_to: { part_index: null, message: quoted } };
  const noQuote = { ...swipe, uid: "plain", reply_to: null };
  let seen: { current: { replying_to?: { sender: { name: string }; body: string } }; participants: { name: string; handle?: string }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
    seen = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
    return Response.json({ choices: [{ message: { content: '{"participate":true}' } }] });
  });
  const decide = (message: typeof swipe | typeof noQuote) => shouldParticipate({}, { accountId: "chat", apiBase: "http://fixture", lineUid: "line" },
    chat as never, message as never, [message as never], new AbortController().signal);
  assert.equal(await decide(swipe), true);
  assert.deepEqual(seen?.current.replying_to, { sender: { name: "Dane", role: "owner", handle: "dane@example.test" }, body: quoted.body });
  assert.equal(seen?.participants.find(p => p.name === "Sam")?.handle, undefined);
  assert.equal(await decide(noQuote), true);
  assert.equal(seen?.current.replying_to, undefined);
});
