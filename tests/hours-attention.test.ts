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
  const message = { uid: "current", sender: worker, direction: "inbound" as const, body: "Started working", created_at: "2026-10-06T12:00:00Z", attachments: [], reply_to: { uid: "question", sender: agent, body: "What are you working on?" } };
  let result = '{"participate":true}';
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    assert.equal(new URL(url).pathname, "/v1/chat/completions");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, "anthropic/claude-sonnet-5");
    assert.equal(request.tools, undefined);
    assert.equal(request.stream, false);
    const context = JSON.parse(request.messages[1].content);
    assert.equal(context.current.sender.role, "member");
    assert.equal(context.current.replying_to.sender.role, "agent");
    assert.equal(context.recent.length, 6);
    assert.deepEqual(context.participants.map((p: { name: string }) => p.name), ["Dane", "Alex", "Elm"]);
    return Response.json({ choices: [{ message: { content: result } }] });
  });
  const decide = () => shouldParticipate({}, { accountId: "chat", apiBase: "http://fixture", lineUid: "line" }, chat, message, Array(10).fill(message), new AbortController().signal);
  assert.equal(await decide(), true);
  result = '{"participate":false}';
  assert.equal(await decide(), false);
  for (const malformed of ['{"participate":"true"}', '{"participate":true,"send":"other-chat"}', 'I should reply']) {
    result = malformed;
    await assert.rejects(decide);
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(decide);
});
