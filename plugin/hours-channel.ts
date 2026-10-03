import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { hoursEnabled, hoursLedger, managementSchema, normalizeHandle } from "./hours.ts";
import { selfSchema } from "./hours-billing.ts";
import { accepts, request, type Account, type Chat, type Message } from "./transport.ts";

const clockSourceSchema = z.object({ line_uid: z.string().min(1), chat_uid: z.string().min(1),
  handle: z.string().min(1), message_uid: z.string().min(1), created_at: z.iso.datetime({ offset: true }), body: z.string() }).strict();

export function hoursGroup(account: Account, chat: Chat) {
  if (!hoursEnabled() || account.accountId !== "chat") return undefined;
  const contractor = hoursLedger().groupContractor(chat.uid);
  if (!contractor) return undefined;
  const members = chat.participants.filter(p => p.type === "member" && p.role !== "owner");
  const owners = chat.participants.filter(p => p.type === "member" && p.role === "owner");
  if (!accepts(account, chat) || chat.trusted || chat.participants.length !== 3 || owners.length !== 1 || members.length !== 1
    || members[0]?.type !== "member" || normalizeHandle(members[0].provider_key) !== contractor.handle) return undefined;
  return contractor;
}

export function clockHours(input: { account: Account; chat: Chat; message: Message; senderIsOwner: boolean }): string | undefined {
  const { account, chat, message, senderIsOwner } = input;
  if (!hoursEnabled() || account.accountId !== "chat" || message.sender.type !== "member" || senderIsOwner) return undefined;
  if (hoursLedger().groupContractor(chat.uid) && !hoursGroup(account, chat)) return "O grupo mudou. O dono precisa revisar os participantes e as permissões antes de continuar o registro.";
  if (!hoursGroup(account, chat)) return undefined;
  if (!/^\/(in|out|hours)(?:\s|$)/i.test(message.body.trim())) return undefined;
  return hoursLedger().clock({ line_uid: account.lineUid, chat_uid: chat.uid,
    handle: message.sender.provider_key, message_uid: message.uid, created_at: message.created_at, body: message.body });
}

async function selfGroupTurn(context: OpenClawPluginToolContext) {
  if (!context.config || context.messageChannel !== "plow" || context.agentAccountId !== "chat" || !context.sessionKey
    || !context.requesterSenderId) throw new Error("This action requires the registered contractor's group.");
  const account = { ...context.config.channels?.plow, accountId: "chat" };
  const configuration = z.object({ apiBase: z.string(), lineUid: z.string(), accountId: z.literal("chat") }).parse(account);
  const uid = (context.nativeChannelId ?? context.deliveryContext?.to)?.replace(/^plow:/i, "");
  if (!uid) throw new Error("This action requires the registered contractor's group.");
  const chat = await request<Chat>(configuration, `/chats/${encodeURIComponent(uid)}`);
  const contractor = hoursGroup(configuration, chat);
  if (!contractor || (!context.senderIsOwner && normalizeHandle(context.requesterSenderId) !== contractor.handle)) {
    throw new Error("This action requires the registered contractor's group.");
  }
  return { configuration, uid, contractor };
}

export function registerHours(api: OpenClawPluginApi, authorize: (context: OpenClawPluginToolContext) => Promise<{ account: Account; chat: Chat }>) {
  if (!hoursEnabled()) return;
  api.registerTool(context => ({
    name: "plow_hours", label: "Manage contractor hours",
    description: "Owner's main Plow DM only. Register contractors and immutable demands, correct hours, export exact timesheet/wiki data. billing_request requests a BR nota fiscal/Pix or US invoice/ACH for an explicit period, returning request_text and the contractor's chat_uid: send that text with plow_reply_to. billing_report returns private masked billing readiness. No payments. rate_cents is the hourly USD rate in integer cents. Never publish an owner report into a contractor group.",
    parameters: z.toJSONSchema(managementSchema),
    async execute(_id, raw: unknown) {
      const { account, chat: ownerChat } = await authorize(context);
      const input = managementSchema.parse(raw);
      if (input.action === "contractor") {
        const chat = await request<Chat>(account, `/chats/${encodeURIComponent(input.chat_uid)}`);
        const contractors = chat.participants.filter(p => p.type === "member" && p.role !== "owner");
        if (!accepts(account, chat) || chat.participants.length !== 3 || chat.participants.filter(p => p.type === "member" && p.role === "owner").length !== 1
          || contractors.length !== 1 || contractors[0]?.type !== "member" || normalizeHandle(contractors[0].provider_key) !== normalizeHandle(input.handle)) {
          throw new Error("Register the active thread containing the owner, this agent and exactly this contractor.");
        }
        if (chat.trusted) throw new Error("Contractor threads must use normal chat trust. Set trusted=false before registering.");
      }
      context.assertInvocationCurrent?.();
      const recorded = hoursLedger().manage(input, JSON.stringify([ownerChat.uid, _id]));
      const details = input.action === "contractor"
        ? { ...z.object({ contractor_id: z.string(), registered: z.literal(true) }).parse(recorded), chat_uid: input.chat_uid,
          thread_verified: true, participants: "owner, registered contractor, this agent", trusted: false }
        : recorded;
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  }));
  api.registerTool(context => ({
    name: "plow_hours_self", label: "This contractor's hours and billing",
    description: "Only the current registered contractor group. Interpret natural language and choose report, start or stop. report returns actual assigned demands, hours and masked billing status. start needs the assigned demand_id; stop closes the open point and may include supplied work details. Clock time and sender come from the verified inbound message, never tool arguments. Only the contractor can clock their own hours; the owner cannot clock on their behalf in the group. Ask when intent or demand is unclear; do not clock negations, plans, questions or historical statements. Confirm the actual tool result. Record invoice, payment_details or tax_document separately after the owner's persisted billing request. No other contractors, rates, corrections, files or payments.",
    parameters: z.toJSONSchema(selfSchema),
    async execute(_id, raw: unknown) {
      const { configuration, uid, contractor } = await selfGroupTurn(context);
      const input = selfSchema.parse(raw);
      let details: unknown;
      if (input.action === "start" || input.action === "stop") {
        if (context.senderIsOwner) throw new Error("Only the contractor's own inbound message can clock their hours. Use the private owner DM for corrections.");
        const source = clockSourceSchema.parse(context.toolBindings?.plowHoursClock);
        if (source.line_uid !== configuration.lineUid || source.chat_uid !== uid
          || normalizeHandle(source.handle) !== contractor.handle) throw new Error("The clock source does not match this contractor's message.");
        context.assertInvocationCurrent?.();
        const confirmation = hoursLedger().clock(source, { kind: input.action, detail: input.action === "start" ? input.demand_id : input.details });
        if (!confirmation) throw new Error("No authorized clock source.");
        details = { confirmation, state: hoursLedger().self({ action: "report" }, contractor.id, _id) };
      } else {
        context.assertInvocationCurrent?.();
        details = hoursLedger().self(input, contractor.id, JSON.stringify([uid, _id]));
      }
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  }));
}
