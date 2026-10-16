import { z } from "zod";
import { hoursEnabled, hoursLedger, sameHandle } from "./hours.ts";
import { verifiedOwnerChat } from "./hours-notifications.ts";
import { accepts, HttpError, request, type Account, type Chat } from "./transport.ts";

// Proactive care on the transport's 30-second heartbeat, with no model turn: a nudge to a
// contractor whose clock has run ten hours, and the owner's evening summary. The ledger
// decides what is due and claims each send before any request, so a crash, a timeout or an
// overlapping heartbeat never sends it twice. A send whose outcome is uncertain is never
// repeated. A transient failure before sending releases the claim for the next heartbeat.

type Outcome = "accepted" | "rejected" | "unknown";
// Worth another heartbeat: the network, a timeout, rate limiting or a server error.
const transient = (error: unknown) => error instanceof HttpError ? error.status === 429 || error.status >= 500
  : error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

async function post(account: Account, chatUid: string, body: string): Promise<Outcome> {
  try {
    z.object({ uid: z.string().trim().min(1) })
      .parse(await request<unknown>(account, `/chats/${encodeURIComponent(chatUid)}/messages`, { body, attachment_uids: [] }));
    return "accepted";
  } catch (error) {
    return error instanceof HttpError && error.status < 500 ? "rejected" : "unknown";
  }
}

let running: Promise<void> | undefined;

/** Cheap when nothing is due: ledger reads only. PLOW_HOURS_PROACTIVE=0 turns it off. */
export async function runHoursSchedule(account: Account, now = Date.now()) {
  if (!hoursEnabled() || account.accountId !== "chat" || process.env.PLOW_HOURS_PROACTIVE === "0") return;
  if (running) return running;
  running = (async () => {
    const ledger = hoursLedger();
    ledger.assertInstallationLine(account.lineUid);
    for (const due of ledger.dueOpenClockNudges(now)) {
      if (!ledger.claimScheduled("open_clock", due.entry_id)) continue;
      let chat: Chat;
      try { chat = await request<Chat>(account, `/chats/${encodeURIComponent(due.contractor.chat_uid)}`); }
      catch (error) {
        if (transient(error)) ledger.releaseScheduled("open_clock", due.entry_id);
        else ledger.finishScheduled("open_clock", due.entry_id, "rejected");
        continue;
      }
      const members = chat.participants.filter(p => p.type === "member");
      const owner = members.find(p => p.role === "owner");
      // Only the contractor's own normal group: the owner, exactly this contractor and the agent.
      if (!accepts(account, chat) || chat.trusted || chat.participants.length !== 3 || members.length !== 2 || owner?.type !== "member"
        || !members.some(p => p.role !== "owner" && sameHandle(p.provider_key, due.contractor.handle))) {
        ledger.finishScheduled("open_clock", due.entry_id, "rejected");
        continue;
      }
      let text: string;
      try { text = ledger.openClockNudgeText(due.contractor.id, owner.display_name, now); }
      catch {
        // The clock closed while this ran: nothing to nudge.
        ledger.finishScheduled("open_clock", due.entry_id, "rejected");
        continue;
      }
      ledger.finishScheduled("open_clock", due.entry_id, await post(account, chat.uid, text));
    }
    const summary = ledger.dailySummary(now);
    if (!summary || !ledger.claimScheduled("summary", summary.key)) return;
    if (summary.text === undefined) return ledger.finishScheduled("summary", summary.key, "empty");
    let chat: Chat;
    try { chat = await verifiedOwnerChat(account); }
    catch (error) {
      if (transient(error)) ledger.releaseScheduled("summary", summary.key);
      else ledger.finishScheduled("summary", summary.key, "rejected");
      return;
    }
    ledger.finishScheduled("summary", summary.key, await post(account, chat.uid, summary.text));
  })();
  try { await running; } finally { running = undefined; }
}
