import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { hoursWebSnapshot } from "../plugin/hours-web.ts";

test("Pix and ACH profiles persist before billing, separately from work entries and other workers", t => {
  const directory = mkdtempSync(join(tmpdir(), "payment-profile-"));
  let ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  for (const id of ["ana", "ben"]) ledger.manage({ action: "contractor", id, name: id,
    handle: `${id}@example.test`, chat_uid: `cht_${id}`, timezone: "UTC", rate_cents: 3000 }, id);
  const pix = { method: "pix", beneficiary: "Ana", key: "00000000000" };
  const ach = { method: "ach", beneficiary: "Ben", bank: "Example Bank", routing: "021000021",
    account: "001234567890", account_type: "checking" };
  ledger.self({ action: "payment_details", payment: pix }, "ana", "pix");
  ledger.self({ action: "payment_details", payment: ach }, "ben", "ach");
  ledger.close(); ledger = new HoursLedger(directory);
  assert.deepEqual(ledger.billingReport("ana").payment, pix);
  assert.deepEqual(ledger.billingReport("ben").payment, ach);
  assert.equal(ledger.billingReport("ana").requested, false);
  assert.equal(ledger.billingReport("ben").approved, false);
  assert.equal(ledger.billingReport("ben").paid, false);
  assert.ok(!JSON.stringify(ledger.self({ action: "report" }, "ana", "ana-report")).includes(ach.account));
  assert.ok(!JSON.stringify(ledger.self({ action: "report" }, "ben", "ben-report")).includes(pix.key));
  for (const [id, payment] of [["ana", pix], ["ben", ach]] as const) {
    ledger.self({ action: "payment_details", payment }, id, `same-${id}`);
    assert.equal(ledger.billingReport(id).payment_version, 1);
    const source = { line_uid: "line", chat_uid: `cht_${id}`, handle: `${id}@example.test`, message_uid: `start-${id}`,
      created_at: "2026-10-06T09:00:00Z", body: "Starting work" };
    ledger.clock(source, { kind: "start", detail: "", description: "Editing video" });
    ledger.clock({ ...source, message_uid: `stop-${id}`, created_at: "2026-10-06T10:00:00Z", body: "Finished" }, { kind: "stop", detail: "Finished editing" });
    ledger.manage({ action: "billing_request", contractor_id: id, country: id === "ana" ? "BR" : "US",
      period_start: "2026-10-06", period_end: "2026-10-06" }, `request-${id}`);
    assert.deepEqual(ledger.billingReport(id).payment, payment);
  }
  const exported = JSON.stringify([ledger.report(), hoursWebSnapshot(ledger)]);
  for (const value of [pix.key, ach.account, ach.routing]) assert.ok(!exported.includes(value), value);
});

test("work descriptions are preserved after payment profile changes; incomplete bank instructions are rejected", t => {
  const directory = mkdtempSync(join(tmpdir(), "payment-changes-"));
  const ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  ledger.manage({ action: "contractor", id: "ana", name: "Ana", handle: "ana@example.test",
    chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000 }, "ana");
  for (const [index, key] of ["old-payments@example.test", "new-payments@example.test"].entries())
    ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", key } }, "ana", `payment-${index}`);
  ledger.clock({ line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "start",
    created_at: "2026-10-06T09:00:00Z", body: "Starting work" }, { kind: "start", detail: "",
    description: "Editing video; old-payments@example.test and new-payments@example.test" });
  const exported = JSON.stringify(ledger.report());
  assert.ok(exported.includes("old-payments@example.test"));
  assert.ok(exported.includes("new-payments@example.test"));
  assert.throws(() => ledger.self({ action: "payment_details", payment: { method: "ach", beneficiary: "Ana",
    bank: "Example", routing: "invalid", account: "1234", account_type: "checking" } }, "ana", "invalid-routing"));
  assert.throws(() => ledger.self({ action: "payment_details", payment: { method: "pix", beneficiary: "Ana", key: "" } }, "ana", "empty-key"));
  assert.equal(ledger.billingReport("ana").payment_version, 2);
});
