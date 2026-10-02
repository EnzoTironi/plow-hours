import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { hoursEnabled, hoursLedger, managementSchema, normalizeHandle } from "./hours.ts";
import { accepts, request, type Account, type Chat, type Message } from "./transport.ts";

export function clockHours(input: { account: Account; chat: Chat; message: Message; senderIsOwner: boolean }): string | undefined {
  const { account, chat, message, senderIsOwner } = input;
  if (!hoursEnabled() || account.accountId !== "chat" || message.sender.type !== "member" || senderIsOwner) return undefined;
  return hoursLedger().clock({ line_uid: account.lineUid, chat_uid: chat.uid,
    handle: message.sender.provider_key, message_uid: message.uid, created_at: message.created_at, body: message.body });
}

export function registerHours(api: OpenClawPluginApi, authorize: (context: OpenClawPluginToolContext) => Promise<{ account: Account; chat: Chat }>) {
  if (!hoursEnabled()) return;
  api.registerTool(context => ({
    name: "plow_hours", label: "Manage contractor hours",
    description: "Owner's main Plow DM only. Register a contractor and immutable demands, correct or manually record a time entry with a reason, or export exact Sheets values and wiki text. Record projection revisions only after successful writes and readback. rate_cents is the hourly USD rate in integer cents. The registered contractor clocks directly in their thread, without model tools.",
    parameters: z.toJSONSchema(managementSchema),
    async execute(_id, raw: unknown) {
      const { account, chat: ownerChat } = await authorize(context);
      const input = managementSchema.parse(raw);
      if (input.action === "contractor") {
        const chat = await request<Chat>(account, `/chats/${encodeURIComponent(input.chat_uid)}`);
        const contractors = chat.participants.filter(p => p.type === "member" && p.role !== "owner");
        if (!accepts(account, chat) || chat.status !== "active" || !chat.participants.some(p => p.type === "member" && p.role === "owner")
          || contractors.length !== 1 || contractors[0]?.type !== "member" || normalizeHandle(contractors[0].provider_key) !== normalizeHandle(input.handle)) {
          throw new Error("Register the active thread containing the owner, this agent and exactly this contractor.");
        }
        if (chat.trusted) throw new Error("Contractor threads must use normal chat trust. Set trusted=false before registering.");
      }
      const details = hoursLedger().manage(input, JSON.stringify([ownerChat.uid, _id]));
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  }));
}
