import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";
import type { ReplyPayload, ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import entry from "../plugin/index.ts";
import { hoursLedger } from "../plugin/hours.ts";
import { websocketFixture } from "./ws-fixture.ts";

const owner = { type: "member", uid: "owner", role: "owner", display_name: "Enzo", provider_key: "+15550000001" };
const worker = { ...owner, uid: "worker", role: "member", display_name: "Daniel", provider_key: "daniel@example.test" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };
const group = { uid: "cht_daniel", status: "active", trusted: false, participants: [owner, worker, self] };
const contextSchema = z.object({ route: z.object({ sessionKey: z.string() }) });
const postSchema = z.object({ body: z.string(), attachment_uids: z.array(z.string()) });
type Dispatch = {
  replyOptions: { disableBlockStreaming?: boolean; turnAdoptionLifecycle: { onAdopted(): Promise<void> } };
  delivery: {
    preparePayload(payload: ReplyPayload, info: ReplyDispatchRuntimeInfo): ReplyPayload | null;
    deliver(payload: ReplyPayload): Promise<unknown>;
  };
};

for (const route of ["owner-group", "owner-dm", "contractor-group"]) {
  for (const mode of ["reply", "silent", "error", "empty", "tool-syntax", "attention-narration"]) {
    const silent = mode === "silent";
    const failed = mode === "error" || mode === "empty" || mode === "tool-syntax" || mode === "attention-narration";
    test(`${route} ${mode}: model controls attention and only a completed final or deliberate silence is terminal`, async t => {
      const { server, apiBase, abortAfter } = await websocketFixture(t);
      hoursLedger().manage({ action: "contractor", id: "daniel", name: "Daniel", handle: worker.provider_key,
        chat_uid: group.uid, timezone: "America/Los_Angeles", rate_cents: 500000 }, "register-daniel");
      const posts: { path: string; body: string }[] = [];
      t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/ws/ticket")) return Response.json({ ticket: "fixture" });
        if (path === "/v1/chats") return Response.json({ data: [home, group], has_more: false });
        if (path.endsWith("/messages")) {
          if (options?.method === "POST") {
            posts.push({ path, body: postSchema.parse(JSON.parse(String(options.body))).body });
            return Response.json({ uid: "msg_out_" + posts.length });
          }
          return Response.json({ data: [], has_more: false });
        }
        if (path.endsWith("/typing") || path.endsWith("/read")) return Response.json({});
        if (path.endsWith("/" + group.uid)) return Response.json(group);
        if (path.endsWith("/" + home.uid)) return Response.json(home);
        assert.fail("Unexpected provider request: " + path);
      });
      const source = route === "owner-dm" ? home : group;
      server.on("connection", (socket: { send(text: string): void }) => socket.send(JSON.stringify({
        event_type: "message_received", event_id: "latest-message", chat_id: source.uid,
        data: { message: { uid: "latest-message", sender: route === "contractor-group" ? worker : owner,
          direction: "inbound", attachments: [], created_at: "2026-10-06T00:00:00Z",
          body: silent ? "Daniel, please set up your own account." : "How can I record hours?" } },
      })));
      const account = { apiBase, accountId: "chat", lineUid: "line", threadTrust: "untrusted" };
      const cfg = { agents: { entries: { main: { identity: { name: "Alder" } } } }, channels: { plow: account } };
      let channel: { gateway: { startAccount(value: object): Promise<void> } } | undefined;
      let dispatches = 0;
      const finalText = "Tell me here when you start or finish working.";
      entry.register({ registrationMode: "full", logger: { info() {} }, registerTool() {}, registerHttpRoute() {},
        registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; },
        runtime: { channel: { routing: { resolveAgentRoute }, session: { resolveStorePath, updateLastRoute }, inbound: {
          buildContext(raw: unknown) { return { SessionKey: contextSchema.parse(raw).route.sessionKey }; },
          async dispatch({ replyOptions, delivery }: Dispatch) {
            dispatches++;
            await replyOptions.turnAdoptionLifecycle.onAdopted();
            assert.equal(replyOptions.disableBlockStreaming, true);
            const intermediate: { payload: ReplyPayload; kind: ReplyDispatchRuntimeInfo["kind"] }[] = [
              { kind: "tool", payload: { text: "This is Enzo speaking to Daniel, not to me." } },
              { kind: "block", payload: { text: finalText } },
              { kind: "final", payload: { text: "The owner is speaking to Daniel.", isReasoning: true } },
              { kind: "final", payload: { text: "> reasoning: The owner is speaking to Daniel." } },
              { kind: "final", payload: { text: "Thinking... _The owner is speaking to Daniel._" } },
            ];
            for (const candidate of intermediate) {
              assert.equal(delivery.preparePayload(candidate.payload, { kind: candidate.kind }), null);
            }
            assert.deepEqual(posts, []);
            if (failed) {
              const rejected: ReplyPayload = mode === "error"
                ? { text: "NO_REPLY", isError: true }
                : mode === "empty" ? { text: "No reply available", isFallbackNotice: true }
                : mode === "attention-narration" ? { text: "This is just a casual comment confirming he's working, no clock action needed - already recorded as note." }
                : { text: '<tool_call>plow_hours_start*)\n(uid="cht_daniel"*)\nWait, let me check the available tools first.\n</arg_value><tool_call>plow_hours_self_start(work="")=' };
              assert.equal(delivery.preparePayload(rejected, { kind: "final" }), null);
              return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: mode === "error",
                counts: { tool: 0, block: 0, final: 0 } } };
            }
            const final: ReplyPayload = silent
              ? { text: "The owner is talking to Daniel.\nNO_REPLY\nI should stay quiet.", mediaUrls: ["https://private.example.test/internal.png"] }
              : { text: finalText };
            const prepared = delivery.preparePayload(final, { kind: "final" });
            if (silent) {
              assert.equal(prepared, null);
              assert.equal(delivery.preparePayload({ text: "NO_REPLY" }, { kind: "final" }), null);
            } else {
              assert.ok(prepared);
              await delivery.deliver(prepared);
            }
            return { dispatched: true, dispatchResult: { deliberateSilentTerminalReply: silent,
              counts: { tool: 0, block: 0, final: silent ? 0 : 1 } } };
          },
        } } },
      });
      assert.ok(channel);
      const controller = abortAfter(30000);
      const logs: string[] = [];
      const completed = failed ? `turn incomplete chat=${source.uid}` : route === "owner-dm" ? `completed chat=${source.uid}` : "stage=terminal";
      await channel.gateway.startAccount({ account, cfg, abortSignal: controller.signal, log: { info(value: string) {
        logs.push(value); if (value.includes(completed)) controller.abort();
      } } });
      assert.ok(logs.some(value => value.includes(completed)), logs.join("\n"));
      const destination = route === "contractor-group" ? group : home;
      assert.deepEqual(posts, silent || failed ? [] : [{ path: `/v1/chats/${destination.uid}/messages`, body: finalText }]);
      assert.equal(hoursLedger().report("daniel")[0]?.entries.length, 0);
      assert.equal(dispatches, 1);
      const reason = mode === "silent" ? "model_silent" : mode === "error" ? "model_error" : mode === "empty" ? "empty_reply" : (mode === "tool-syntax" || mode === "attention-narration") ? "internal_protocol" : "delivered";
      assert.ok(logs.some(value => value.includes(`reply_outcome chat=${source.uid}`) && value.includes(`reason=${reason}`)), logs.join("\n"));
      if (failed) assert.ok(!logs.some(value => value.includes("stage=terminal")), "A failed or empty turn must not be completed as deliberate silence");
      if (failed && route === "contractor-group") {
        assert.equal(hoursLedger().isPendingClockMessage("line", group.uid, "latest-message"), true,
          "The source stays available for retry instead of falsely completing the clock message");
      }
    });
  }
}
