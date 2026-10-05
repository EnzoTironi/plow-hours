import assert from "node:assert/strict";
import { test } from "node:test";
import { hoursLedger } from "../plugin/hours.ts";
import { flushHoursNotices } from "../plugin/hours-notifications.ts";
import { websocketFixture } from "./ws-fixture.ts";

test("approval-change alerts reach only the current private owner DM, retry failures and reject another account", async t => {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  const ledger = hoursLedger();
  ledger.manage({ action: "contractor", id: "ana", name: "Ana", handle: "ana@example.test", chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000 }, "profile");
  ledger.manage({ action: "demand", id: "work", contractor_id: "ana", project: "Site", summary: "Landing" }, "work");
  ledger.manage({ action: "manual", contractor_id: "ana", demand_id: "work", start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", rate_cents: 3000, reason: "Confirmed work" }, "session");
  ledger.manage({ action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-02" }, "request");
  ledger.self({ action: "invoice", invoice: { number: "NF-1", url: "https://private.example.test/invoice.pdf", currency: "USD", amount_cents: 3000, period_start: "2026-10-02", period_end: "2026-10-02" } }, "ana", "invoice");
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", document_url: "https://private.example.test/pix.pdf" } }, "ana", "pix");
  ledger.manage({ action: "close_period", contractor_id: "ana" }, "close");
  ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: ledger.billingReport("ana").fingerprint }, "approval");
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", document_url: "https://private.example.test/new-pix.pdf" } }, "ana", "new-pix");
  const account = { apiBase: "http://notice-fixture", accountId: "chat", lineUid: "line" };
  const home = { uid: "cht_owner", status: "active", trusted: false, participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", role: "owner", uid: "member-owner", provider_key: "owner@example.test" },
  ] };
  let ownerUid = "different-account", failed = true, group = false;
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    if (path === "/v1/agents/me") return Response.json({ line: { uid: "line" } });
    if (path === "/v1/auth/owner-uid") return Response.json({ owner_uid: ownerUid });
    if (path === "/v1/chats") return Response.json({ data: [home], has_more: false });
    if (path === "/v1/chats/cht_owner") return Response.json(group ? { ...home, participants: [...home.participants, { type: "member", role: "member" }] } : home);
    assert.equal(path, "/v1/chats/cht_owner/messages");
    assert.equal(init.method, "POST");
    if (failed) return Response.json({ error: "Unavailable" }, { status: 503 });
    sent.push(String(init.body));
    return Response.json({ uid: "sent-owner-notice" });
  });
  await assert.rejects(() => flushHoursNotices(account), /different Plow owner/);
  assert.equal(sent.length, 0);
  ownerUid = "owner-account";
  group = true;
  await assert.rejects(() => flushHoursNotices(account), /private owner conversation/);
  group = false;
  await assert.rejects(() => flushHoursNotices(account), /503/);
  assert.equal(ledger.pendingOwnerNotices().length, 1);
  failed = false;
  await Promise.all([flushHoursNotices(account), flushHoursNotices(account)]);
  await flushHoursNotices(account);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /aprova.*revogada/i);
  assert.ok(!sent[0]?.includes("new-pix.pdf"));
  assert.equal(ledger.pendingOwnerNotices().length, 0);
});
