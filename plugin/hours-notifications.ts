import { z } from "zod";
import { hoursEnabled, hoursLedger } from "./hours.ts";
import { accepts, findOwnerChat, ownerChat, request, type Account, type Chat } from "./transport.ts";

let sending: Promise<void> | undefined;

export async function flushHoursNotices(account: Account) {
  if (!hoursEnabled() || account.accountId !== "chat") return;
  if (sending) return sending;
  const ledger = hoursLedger();
  if (!ledger.pendingOwnerNotices().length) return;
  sending = (async () => {
    const identity = z.object({ line: z.object({ uid: z.string().min(1) }) })
      .parse(await request<unknown>(account, "/agents/me"));
    if (identity.line.uid !== account.lineUid) throw new Error("Owner notification belongs to a different Plow line.");
    const ownerIdentity = z.object({ owner_uid: z.string().min(1) }).parse(await request<unknown>(account, "/auth/owner-uid"));
    ledger.bindInstallation(account.lineUid, ownerIdentity.owner_uid);
    const discovered = await ownerChat(account);
    const chat = await request<Chat>(account, `/chats/${encodeURIComponent(discovered.uid)}`);
    const owner = chat.participants.find(p => p.type === "member" && p.role === "owner");
    if (!accepts(account, chat) || findOwnerChat(account, [chat]) !== chat || owner?.type !== "member") throw new Error("Owner notification requires the current private owner conversation.");
    for (const notice of ledger.pendingOwnerNotices()) {
      const receipt = await request<unknown>(account, `/chats/${encodeURIComponent(chat.uid)}/messages`, {
        body: notice.kind === "clock_review" ? notice.body
          : `${notice.name} atualizou documentos ou instruções de pagamento depois da sua aprovação. A aprovação foi revogada. Confira os dados atuais na conversa privada antes de aprovar novamente ou pagar.`,
        attachment_uids: [],
      });
      z.object({ uid: z.string().min(1) }).parse(receipt);
      ledger.completeOwnerNotice(notice.source);
    }
  })();
  try { await sending; } finally { sending = undefined; }
}
