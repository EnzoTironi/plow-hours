import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { hoursWebSnapshot } from "../plugin/hours-web.ts";

test("BR and US invoices/payment instructions persist privately, scoped to each contractor, without creating payments", t => {
  const dir = mkdtempSync(join(tmpdir(), "hours-billing-"));
  let ledger = new HoursLedger(dir);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true }); });
  for (const [id, country, phone] of [["ana", "BR", "+15550000002"], ["ben", "US", "+15550000003"]] as const) {
    ledger.manage({ action: "contractor", id, name: id, handle: phone, chat_uid: `cht_${id}`, timezone: "UTC", rate_cents: 3000 }, `register-${id}`);
    ledger.manage({ action: "billing_request", contractor_id: id, country, period_start: "2026-10-02", period_end: "2026-10-02", w9_required: country === "US" }, `request-${id}`);
  }
  ledger.self({ action: "invoice", invoice: { number: "NF-42", url: "https://invoices.example.test/ana.pdf", amount_cents: 7500,
    currency: "USD", period_start: "2026-10-02", period_end: "2026-10-02" } }, "ana", "nf");
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana Silva", document_url: "https://private.example.test/ana/pix.pdf" } }, "ana", "pix");
  ledger.self({ action: "payment_details", payment: { method: "ach", beneficiary: "Ben Smith", bank: "Example Bank", document_url: "https://private.example.test/ben/ach.pdf", account_last4: "7890", account_type: "checking" } }, "ben", "ach");
  ledger.self({ action: "tax_document", url: "https://private.example.test/ben/w9.pdf" }, "ben", "w9");
  ledger.manage({ action: "demand", contractor_id: "ana", id: "work", project: "Website", summary: "Landing page" }, "work");
  ledger.manage({ action: "manual", contractor_id: "ana", demand_id: "work", start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", rate_cents: 3000, reason: "Worker confirmed session", details: "commit abc123 https://private.example.test/ana/pix.pdf https://invoices.example.test/ana.pdf" }, "note-with-private-references");
  ledger.close(); ledger = new HoursLedger(dir);
  ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana Silva", document_url: "https://private.example.test/ana/new-pix.pdf" } }, "ana", "replace-pix");
  assert.equal(ledger.billingReport("ana").invoice?.number, "NF-42");
  assert.equal(ledger.billingReport("ben").payment?.method, "ach");
  assert.equal(ledger.billingReport("ana").paid, false);
  const regular = JSON.stringify([ledger.report(), hoursWebSnapshot(ledger)]);
  for (const secret of ["ana.payments", "1234567890", "021000021", "private.example", "invoices.example"]) assert.ok(!regular.includes(secret));
  const self = JSON.stringify(ledger.self({ action: "report" }, "ana", "report"));
  assert.ok(!self.includes("Ben Smith"));
  assert.ok(!self.includes("ana.payments"));
  const financial = JSON.stringify(ledger.billingReport("ben"));
  assert.ok(!financial.includes("1234567890"));
  assert.ok(financial.includes("7890"));
  assert.equal(statSync(join(dir, "hours.sqlite")).mode & 0o777, 0o600);
  assert.throws(() => ledger.self({ action: "payment_details", payment: { method: "ach", beneficiary: "Ana", bank: "Example", document_url: "https://private.example.test/ben/ach.pdf", account_last4: "7890", account_type: "checking" } }, "ana", "bad-method"), /Pix/);
  assert.throws(() => ledger.self({ action: "invoice", invoice: { number: "WRONG", url: "https://example.test/wrong.pdf", amount_cents: 1, currency: "USD", period_start: "2026-10-01", period_end: "2026-10-01" } }, "ana", "bad-period"), /requested period/);
  assert.throws(() => ledger.self({ action: "report", contractor_id: "ben" }, "ana", "select-other"));
  assert.throws(() => ledger.self({ action: "correct", entry_id: "x", start: "x", finish: "x" }, "ana", "correct"));
  assert.throws(() => ledger.self({ action: "pay" }, "ana", "pay"));
});

test("financial documents require an explicit owner request and invoice replacement retains prior documents", t => {
  const dir = mkdtempSync(join(tmpdir(), "hours-billing-period-"));
  const ledger = new HoursLedger(dir);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true }); });
  ledger.manage({ action: "contractor", id: "ana", name: "Ana", handle: "+15550000002", chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000 }, "register");
  assert.throws(() => ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", document_url: "https://private.example.test/pix.pdf" } }, "ana", "before-request"), /owner must request/);
  const request = { action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-02" };
  ledger.manage(request, "request");
  const invoice = { number: "NF-1", url: "https://example.test/nf1.pdf", currency: "BRL", amount_cents: 30000, period_start: "2026-10-02", period_end: "2026-10-02" };
  ledger.self({ action: "invoice", invoice }, "ana", "invoice");
  ledger.manage(request, "repeat-request");
  assert.equal(ledger.billingReport("ana").invoice?.number, "NF-1");
  ledger.manage({ ...request, period_start: "2026-10-03", period_end: "2026-10-03" }, "next-period");
  assert.equal(ledger.billingReport("ana").invoice, null);
  assert.equal(ledger.billingReport("ana").paid, false);
});
