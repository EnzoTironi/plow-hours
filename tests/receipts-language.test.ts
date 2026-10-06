import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HoursLedger, duration } from "../plugin/hours.ts";

// Dates are fixed in July so receipts always show the date (a receipt for today shows only the time).
// Issue #18: an English-speaking contractor's /out answered "Ponto encerrado às 2026-10-05 21:46:57 GMT-7.
// 0.087981 h registradas." Receipts follow the contractor's registered language, read as a clock time and a
// timesheet duration, and the group prompt can see the receipts the channel sent without a model turn.
function fixture(t: TestContext, language?: "en" | "pt", directory = mkdtempSync(join(tmpdir(), "plow-hours-lang-"))) {
  const ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  ledger.manage({ action: "contractor", id: "plucas", name: "Plucas", handle: "+15550000009", chat_uid: "cht_plucas",
    timezone: "America/Los_Angeles", rate_cents: 10_000, ...(language ? { language } : {}) }, "register");
  ledger.manage({ action: "demand", id: "connectors", contractor_id: "plucas", project: "Plow", summary: "Connectors without Latch" }, "demand");
  ledger.manage({ action: "demand", id: "docs", contractor_id: "plucas", project: "Plow", summary: "Docs" }, "demand-2");
  let sequence = 0;
  const source = (body: string, created_at: string) =>
    ({ line_uid: "line", chat_uid: "cht_plucas", handle: "+1 (555) 000-0009", message_uid: `msg_${++sequence}`, body, created_at });
  return { ledger, source, clock: (body: string, created_at: string) => ledger.clock(source(body, created_at)) };
}

test("an English contractor's /in and /out receipts are English, with a clock time and minutes", t => {
  const f = fixture(t, "en");
  assert.match(f.clock("/in", "2026-07-15T21:41:40-07:00") ?? "", /^Clock started at Jul 15, 9:41\sPM PDT\.$/);
  assert.match(f.clock("/out", "2026-07-15T21:46:57-07:00") ?? "", /^Clock stopped at Jul 15, 9:46\sPM PDT\. Total: 5 min\.$/);
  assert.match(f.clock("/hours", "2026-07-15T21:47:00-07:00") ?? "", /^No clock running\./);
});

test("a contractor registered without a language keeps Portuguese receipts, now readable too", t => {
  const f = fixture(t);
  f.clock("/in", "2026-07-15T21:41:40-07:00");
  const stop = f.clock("/out", "2026-07-15T21:46:57-07:00") ?? "";
  assert.match(stop, /^Ponto encerrado às 15 de jul\.?, 21:46 GMT-7\. Total: 5 min\.$/);
  assert.doesNotMatch(stop, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|0\.08/);
});

test("a ledger created before the language column upgrades its contractors to Portuguese", t => {
  const directory = mkdtempSync(join(tmpdir(), "plow-hours-legacy-"));
  const legacy = new DatabaseSync(join(directory, "hours.sqlite"));
  legacy.exec(`CREATE TABLE contractors (id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, chat_uid TEXT NOT NULL,
    timezone TEXT NOT NULL, rate_cents INTEGER NOT NULL CHECK(rate_cents >= 0), revision INTEGER NOT NULL DEFAULT 1,
    sheet_id TEXT, sheet_revision INTEGER NOT NULL DEFAULT 0, wiki_revision INTEGER NOT NULL DEFAULT 0)`);
  legacy.prepare("INSERT INTO contractors(id, name, handle, chat_uid, timezone, rate_cents) VALUES ('old', 'Old', '+15550000010', 'cht_old', 'America/Sao_Paulo', 3000)").run();
  legacy.close();
  const f = fixture(t, "en", directory);
  assert.match(f.ledger.clock({ line_uid: "line", chat_uid: "cht_old", handle: "+15550000010", message_uid: "legacy_1", body: "/in", created_at: "2026-07-15T10:00:00-03:00" }) ?? "", /^Ponto iniciado às /);
});

test("an English contractor can switch tasks: the switch no longer depends on Portuguese wording", t => {
  const f = fixture(t, "en");
  f.ledger.clock(f.source("starting connectors", "2026-07-15T21:00:00-07:00"), { kind: "start", detail: "connectors" });
  const switched = f.ledger.clock(f.source("moving to docs", "2026-07-15T21:30:00-07:00"), { kind: "switch", detail: "docs", details: "" }) ?? "";
  assert.match(switched, /^Clock stopped at .+ Total: 30 min\. Clock started at /);
});

test("the receipts sent in a contractor's group are available to the next model turn, oldest first", t => {
  const f = fixture(t, "en");
  f.clock("/in", "2026-07-15T21:41:40-07:00");
  f.clock("/out", "2026-07-15T21:46:57-07:00");
  const recent = f.ledger.recentReceipts("plucas");
  assert.equal(recent.length, 2);
  assert.match(recent[0] ?? "", /^Clock started/);
  assert.match(recent[1] ?? "", /^Clock stopped/);
});

test("durations read like a timesheet", () => {
  assert.equal(duration(34_000), "1 min");
  assert.equal(duration(317_000), "5 min");
  assert.equal(duration(80 * 60_000), "1 h 20 min");
  assert.equal(duration(2 * 3_600_000), "2 h");
});
