import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HoursLedger } from "../plugin/hours.ts";
import { periodBounds, periodValue } from "../plugin/hours-period.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hours-review-")), ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  ledger.manage({ action: "contractor", id: "ana", name: "Ana", handle: "ana@example.test", chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000, language: "pt" }, "profile");
  ledger.manage({ action: "demand", contractor_id: "ana", id: "work", project: "Website", summary: "Landing page" }, "work");
  let sequence = 0;
  const request = (country: "BR" | "US" = "BR", extra = {}) => ledger.manage({ action: "billing_request", contractor_id: "ana", country, period_start: "2026-10-02", period_end: "2026-10-02", ...extra }, `request-${++sequence}`);
  const manual = (start = "2026-10-02T09:00:00Z", finish = "2026-10-02T11:00:00Z", rate_cents = 3000, source = "manual") => ledger.manage({ action: "manual", contractor_id: "ana", demand_id: "work", start, finish, rate_cents, reason: "Worker's confirmed missing session" }, source);
  const invoice = (amount_cents = 6000, currency: "USD" | "BRL" = "USD", number = "NF-1") => ledger.self({ action: "invoice", invoice: { number, url: `https://private.example.test/${number}.pdf`, currency, amount_cents, period_start: "2026-10-02", period_end: "2026-10-02" } }, "ana", `invoice-${number}-${amount_cents}-${currency}`);
  const pix = (name = "Ana Silva", url = "https://private.example.test/pix.pdf") => ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: name, document_url: url } }, "ana", `pix-${name}-${url}`);
  return { directory, ledger, request, manual, invoice, pix, report: () => ledger.billingReport("ana"), close: (extra = {}, source = "close") => ledger.manage({ action: "close_period", contractor_id: "ana", ...extra }, source) };
}

test("received paperwork is not approval; invoice mismatch is explicit and changes invalidate the exact approval", t => {
  const f = fixture(t); f.request(); f.manual(); f.pix(); f.invoice(10_000_000);
  assert.equal(f.report().ready_for_owner_review, false);
  assert.equal(f.report().approved, false);
  f.close();
  assert.equal(f.report().expected?.expected_amount_cents, 6000);
  assert.equal(f.report().discrepancy_cents, 9_994_000);
  assert.equal(f.report().ready_for_owner_review, false);
  assert.throws(() => f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: f.report().fingerprint }, "approve-wrong-amount"), /unresolved/);
  f.invoice();
  const before = f.report(); assert.ok(before.fingerprint);
  assert.equal(before.ready_for_owner_review, true); assert.equal(before.approved, false);
  f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: before.fingerprint }, "verified-owner-approval");
  assert.equal(f.report().approved, true);
  f.pix("Other beneficiary", "https://private.example.test/new-pix.pdf");
  assert.equal(f.report().payment_version, 2);
  assert.equal(f.report().approved, false);
  assert.notEqual(f.report().fingerprint, before.fingerprint);
  const repeated = f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: before.fingerprint }, "verified-owner-approval");
  assert.equal(JSON.parse(JSON.stringify(repeated)).approved, false, "an old approval receipt cannot approve the new destination");
  assert.deepEqual(f.report().expected, before.expected);
  assert.throws(() => f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: before.fingerprint }, "stale-approval"), /changed/);
  const fresh = f.report().fingerprint!;
  f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: fresh }, "new-approval");
  f.invoice(6000, "USD", "NF-REPLACED");
  assert.equal(f.report().approved, false);
  assert.equal(f.report().paid, false);
  assert.throws(() => f.ledger.manage({ action: "pay", contractor_id: "ana" }, "pay"));
  assert.throws(() => f.ledger.manage({ action: "mark_paid", contractor_id: "ana" }, "mark-paid"));
});

test("a contractor changing approved payment instructions saves one owner alert atomically and survives restart", t => {
  const f = fixture(t); f.request(); f.manual(); f.invoice(); f.pix(); f.close();
  assert.deepEqual(f.ledger.pendingOwnerNotices(), []);
  f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: f.report().fingerprint }, "owner-approve");
  f.ledger.rememberClockMessage({ line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "incoming-docs", created_at: "2026-10-03T09:00:00Z", body: "Here are my updated instructions" });
  assert.equal(f.report().approved, false, "the incoming message temporarily blocks readiness before its actual changes are processed");
  f.ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana Silva", document_url: "https://private.example.test/pix.pdf" } }, "ana", "unchanged-docs");
  assert.deepEqual(f.ledger.pendingOwnerNotices(), [], "an unchanged resubmission is not a revocation");
  f.pix("Ana Novo", "https://private.example.test/new.pdf");
  assert.equal(f.report().approved, false);
  f.pix("Ana Novo", "https://private.example.test/new.pdf");
  const notices = f.ledger.pendingOwnerNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.name, "Ana");
  const reopened = new HoursLedger(f.directory);
  try {
    assert.deepEqual(reopened.pendingOwnerNotices(), notices);
    assert.ok(notices[0]);
    reopened.completeOwnerNotice(notices[0].source);
    assert.deepEqual(reopened.pendingOwnerNotices(), []);
  } finally { reopened.close(); }
});

test("closed periods reject edits, voids and backdated additions until reopening with a reason", t => {
  const f = fixture(t); f.request(); f.manual(); f.invoice(); f.pix(); f.close();
  const entry = f.ledger.report("ana")[0]!.entries[0]!;
  assert.throws(() => f.ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", reason: "Changed" }, "locked-correction"), /closed period/);
  assert.throws(() => f.ledger.manage({ action: "void", entry_id: entry.id, reason: "Mistake" }, "locked-void"), /closed period/);
  assert.throws(() => f.manual("2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z", 3000, "late-addition"), /closed period/);
  assert.throws(() => f.ledger.manage({ action: "reopen_period", contractor_id: "ana", reason: "" }, "blank-reopen"));
  f.ledger.manage({ action: "reopen_period", contractor_id: "ana", reason: "Worker corrected their finish" }, "reopen");
  f.ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", reason: "Worker confirmed finish" }, "correct");
  f.close({}, "reclose");
  assert.equal(f.report().expected?.expected_amount_cents, 3000);
  assert.equal(f.report().discrepancy_cents, 3000); assert.equal(f.report().approved, false);
  f.request("BR", { period_start: "2026-10-03", period_end: "2026-10-03" });
  assert.throws(() => f.manual("2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z", 3000, "old-period-is-still-closed"), /closed period/);
});

test("period closure splits midnight hours, respects captured rates and uses actual DST elapsed time", t => {
  const f = fixture(t);
  f.manual("2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z", 3000, "cross-month");
  f.manual("2026-10-01T02:00:00Z", "2026-10-01T03:00:00Z", 5000, "new-rate");
  f.request("BR", { period_start: "2026-10-01", period_end: "2026-10-01" }); f.close();
  assert.equal(f.report().expected?.total_hours, 2); assert.equal(f.report().expected?.amount_usd_cents, 8000);
  const bounds = periodBounds("2026-11-01", "2026-11-01", "America/New_York");
  assert.equal(bounds.end_ms - bounds.start_ms, 25 * 3600000);
  const spring = periodBounds("2026-03-08", "2026-03-08", "America/New_York");
  assert.equal(spring.end_ms - spring.start_ms, 23 * 3600000);
  const minute = f.ledger.report("ana")[0]!.entries[0]!;
  const rows = [0, 1, 2].map(i => ({ ...minute, id: `fraction-${i}`, start_ms: bounds.start_ms + i * 60000, end_ms: bounds.start_ms + (i + 1) * 60000, rate_cents: 100 }));
  assert.equal(periodValue(rows, bounds).amount_usd_cents, 5, "round the sum once, not 2 cents per row");
  assert.throws(() => periodBounds("2011-12-30", "2011-12-30", "Pacific/Apia"), /does not exist/);
});

test("currency conversion and W-9 requirements come from the owner, and changing country clears tax documents", t => {
  const f = fixture(t); f.manual(); f.request(); f.pix(); f.invoice(30000, "BRL"); f.close();
  assert.equal(f.report().ready_for_owner_review, false);
  f.ledger.manage({ action: "reopen_period", contractor_id: "ana", reason: "Use agreed BRL amount" }, "reopen");
  assert.throws(() => f.close({ brl_amount_cents: 30000 }, "missing-rate-note"), /conversion note/);
  f.close({ brl_amount_cents: 30000, conversion_note: "Owner agreed USD 60 = BRL 300 for this period" }, "brl-close");
  assert.equal(f.report().expected?.currency, "BRL"); assert.equal(f.report().ready_for_owner_review, true);
  f.request("US", { w9_required: true });
  assert.equal(f.report().payment, null);
  f.ledger.self({ action: "tax_document", url: "https://private.example.test/w9.pdf" }, "ana", "tax");
  f.request("BR");
  assert.equal(f.report().tax_document_url, null);
  assert.throws(() => f.ledger.self({ action: "tax_document", url: "https://private.example.test/w9.pdf" }, "ana", "tax-br"), /not requested/);
});

test("direct Pix details bind the billing approval to the exact key; legacy data upgrades without a replacement link", t => {
  const f = fixture(t); f.request(); f.manual(); f.invoice();
  const payment = { method: "pix", beneficiary: "Ana", key: "ana-payments@example.test" };
  f.ledger.self({ action: "payment_details", payment }, "ana", "raw-pix");
  assert.throws(() => f.ledger.self({ action: "payment_details", payment: { method: "ach", beneficiary: "Ana", bank: "Bank", routing: "021000021", account: "1234567890", account_type: "checking" } }, "ana", "raw-ach"));
  assert.throws(() => f.pix("Ana", "https://user:secret@private.example.test/pix.pdf"));
  f.close();
  const before = f.report();
  assert.deepEqual(before.payment, payment);
  assert.ok(before.ready_for_owner_review && before.fingerprint);
  f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint: before.fingerprint }, "approval");
  f.ledger.self({ action: "payment_details", payment: { ...payment, key: "updated-payments@example.test" } }, "ana", "raw-pix-update");
  assert.equal(f.report().approved, false);
  assert.notEqual(f.report().fingerprint, before.fingerprint);
  assert.ok(!JSON.stringify(f.ledger.report()).includes(payment.key));
  const db = new DatabaseSync(join(f.directory, "hours.sqlite"));
  db.exec("DROP TABLE billing_payments");
  db.prepare("UPDATE billing_requests SET payment_json=? WHERE contractor_id='ana'").run(JSON.stringify({ method: "pix", beneficiary: "Ana", key: "private-pix-key" }));
  db.close();
  const upgraded = new HoursLedger(f.directory);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.billingReport("ana").payment, { method: "pix", beneficiary: "Ana", key: "private-pix-key" });
  assert.equal(upgraded.billingReport("ana").ready_for_owner_review, true);
  assert.equal(upgraded.billingReport("ana").approved, false);
});

test("open clocks, unresolved messages and unreviewed long entries block billing closure", t => {
  const f = fixture(t); f.request();
  const source = { line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "pending", created_at: "2026-10-02T09:00:00Z", body: "Starting now" };
  f.ledger.clockAttempt(source);
  assert.throws(() => f.close({}, "pending-close"), /pending clock/);
  f.ledger.completeClockMessage("line", "cht_ana", "pending");
  f.ledger.clock(source, { kind: "start", detail: "work" });
  assert.throws(() => f.close({}, "open-close"), /open clocks/);
  f.ledger.clock({ ...source, message_uid: "end", created_at: "2026-10-02T23:00:00Z" }, { kind: "stop", detail: "14 hours confirmed" });
  assert.throws(() => f.close({}, "long-close"), /review long/);
  const entry = f.ledger.report("ana")[0]!.entries[0]!;
  f.ledger.manage({ action: "review_entry", entry_id: entry.id, reason: "Owner verified the 14-hour session with worker" }, "review");
  f.close({}, "reviewed-close"); assert.equal(f.report().closed, true);
});

test("work on another task is a note; only an explicit stop closes the clock and description differences do not block billing", t => {
  const f = fixture(t); f.request();
  f.ledger.manage({ action: "demand", contractor_id: "ana", id: "brand", project: "Brand", summary: "Identity design" }, "brand");
  const source = { line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "start", created_at: "2026-10-02T09:00:00Z", body: "Starting design" };
  f.ledger.clock(source, { kind: "start", detail: "brand" });
  const note = { ...source, message_uid: "note", created_at: "2026-10-02T09:30:00Z", body: "Also implemented the website, commit abc123" };
  f.ledger.clock(note, { kind: "note", detail: note.body });
  f.ledger.clock(note, { kind: "note", detail: note.body });
  const open = f.ledger.report("ana")[0]!.open_entry!;
  assert.equal(open.start_ms, Date.parse(source.created_at));
  assert.equal(open.demand_id, "brand"); assert.equal(open.end_ms, null);
  assert.equal(open.details, note.body, "replays do not duplicate work notes");
  assert.equal(f.ledger.report("ana")[0]!.total_hours, 0);
  f.ledger.clock({ ...source, message_uid: "stop", created_at: "2026-10-02T10:00:00Z" }, { kind: "stop", detail: "Finished for today" });
  const entry = f.ledger.report("ana")[0]!.entries[0]!;
  assert.equal(entry.end_ms, Date.parse("2026-10-02T10:00:00Z"));
  assert.match(entry.details, /website.*abc123\nFinished for today/);
  assert.deepEqual(f.ledger.report("ana")[0]!.review_needed, []);
  f.invoice(3000); f.pix(); f.close();
  assert.equal(f.report().ready_for_owner_review, true);
  assert.equal(f.report().expected?.blocks[0]?.demand_id, "brand");
});

test("a late conflicting clock survives completion and restart, revokes approval, and requires owner resolution", t => {
  const f = fixture(t); f.request(); f.manual(); f.invoice(); f.pix(); f.close();
  const fingerprint = f.report().fingerprint!;
  f.ledger.manage({ action: "approve_billing", contractor_id: "ana", fingerprint }, "approve");
  const source = { line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "late-start", created_at: "2026-10-02T10:00:00Z", body: "Started earlier" };
  assert.match(f.ledger.clock(source, { kind: "start", detail: "work" }) ?? "", /cruza/);
  f.ledger.completeClockMessage(source.line_uid, source.chat_uid, source.message_uid);
  const reopened = new HoursLedger(f.directory);
  try {
    assert.equal(reopened.report("ana")[0]!.pending_clock.reviews.length, 1);
    assert.equal(reopened.report("ana")[0]!.total_hours, 2);
    assert.equal(reopened.billingReport("ana").approved, false);
    assert.equal(reopened.billingReport("ana").ready_for_owner_review, false);
    assert.throws(() => reopened.manage({ action: "approve_billing", contractor_id: "ana", fingerprint }, "stale-after-late-message"), /unresolved/);
    reopened.manage({ action: "resolve_clock", contractor_id: "ana", reason: "Worker confirmed it was a duplicate of the recorded 9–11 session" }, "resolve");
    assert.equal(reopened.billingReport("ana").ready_for_owner_review, true);
    assert.equal(reopened.billingReport("ana").approved, false, "resolving a conflict never restores approval");
    assert.match(reopened.clock(source, { kind: "start", detail: "work" }) ?? "", /nenhuma hora/);
  } finally { reopened.close(); }
});
