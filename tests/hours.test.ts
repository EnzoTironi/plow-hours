import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { HoursLedger, clockCommand, SHEET_HEADERS } from "../plugin/hours.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "plow-hours-"));
  let ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  const contractor = { action: "contractor", id: "ana", name: "Ana", handle: "+15550000002", chat_uid: "cht_ana", timezone: "America/Sao_Paulo", rate_cents: 3000, language: "pt" };
  ledger.manage(contractor, "contractor");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "Website", summary: "Build the landing page", references: "github.com/team/site/issues/42" }, "demand");
  let sequence = 0;
  return {
    get ledger() { return ledger; }, contractor,
    restart() { ledger.close(); ledger = new HoursLedger(directory); },
    clock(body: string, created_at: string, extra = {}) {
      return ledger.clock({ line_uid: "line", chat_uid: "cht_ana", handle: "+1 (555) 000-0002", message_uid: `msg_${++sequence}`, body, created_at, ...extra });
    },
    pendingStart() { return z.object({ pending_start: z.string().nullable() }).parse(ledger.self({ action: "report" }, "ana", "pending-report")).pending_start; },
    snapshot() { const result = ledger.report("ana")[0]; assert.ok(result); return result; },
  };
}

test("a contractor sees their own recorded value at USD 5000 per hour, with captured rates and no unmatched or other-worker hours", t => {
  const f = fixture(t);
  f.ledger.manage({ ...f.contractor, rate_cents: 500_000, timezone: "America/Los_Angeles" }, "high-rate");
  f.clock("parei", "2026-10-05T19:18:00-07:00");
  f.clock("comecei landing", "2026-10-05T19:30:30-07:00");
  f.ledger.manage({ ...f.contractor, rate_cents: 250_000, timezone: "America/Los_Angeles" }, "new-rate");
  f.clock("parei Fixes to one-click deploy", "2026-10-05T19:39:00-07:00");
  f.ledger.manage({ ...f.contractor, id: "ben", name: "Other Worker", handle: "+15550000003", chat_uid: "cht_ben", rate_cents: 77_777 }, "other-profile");
  f.ledger.manage({ action: "demand", id: "private", contractor_id: "ben", project: "Other project", summary: "Other work" }, "other-work");
  f.ledger.manage({ action: "manual", contractor_id: "ben", demand_id: "private", start: "2026-10-05T19:00:00-07:00", finish: "2026-10-05T20:00:00-07:00", rate_cents: 77_777, reason: "Other worker's confirmed interval" }, "other-hours");
  f.restart();
  const schema = z.object({ contractor: z.object({ rate_cents: z.number() }), total_hours: z.number(),
    earnings: z.object({ amount_usd_cents: z.number(), duration_ms: z.number() }),
    entries: z.array(z.object({ rate_cents: z.number() })), pending_clock: z.object({ unmatched_stops: z.number() }) });
  const raw = f.ledger.self({ action: "report", period_start: "2026-10-05", period_end: "2026-10-05" }, "ana", "earnings");
  const report = schema.parse(raw);
  assert.equal(report.contractor.rate_cents, 250_000); assert.equal(report.entries[0]?.rate_cents, 500_000);
  assert.equal(report.total_hours, 8.5 / 60); assert.equal(report.earnings.duration_ms, 510_000);
  assert.equal(report.earnings.amount_usd_cents, 70_833);
  assert.equal(report.pending_clock.unmatched_stops, 1); assert.equal(report.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(raw), /Other Worker|Other project|77777/);
  assert.throws(() => f.ledger.self({ action: "report", contractor_id: "ben" }, "ana", "other"));
  f.ledger.manage({ ...f.contractor, rate_cents: 0, timezone: "America/Los_Angeles" }, "zero-rate");
  f.clock("comecei landing", "2026-10-05T20:00:00-07:00"); f.clock("parei", "2026-10-05T20:01:00-07:00");
  const zero = schema.parse(f.ledger.self({ action: "report" }, "ana", "known-zero"));
  assert.equal(zero.contractor.rate_cents, 0); assert.equal(zero.entries[1]?.rate_cents, 0);
  assert.equal(zero.earnings.amount_usd_cents, 70_833); assert.equal(zero.earnings.duration_ms, 570_000);
});

test("a member date report clips midnight at their timezone and rounds money once while excluding voided and open time", t => {
  const f = fixture(t);
  f.ledger.manage({ ...f.contractor, rate_cents: 100, timezone: "America/Los_Angeles" }, "one-dollar");
  f.clock("comecei landing", "2026-10-04T23:59:50-07:00"); f.clock("parei", "2026-10-05T00:00:10-07:00");
  f.clock("comecei landing", "2026-10-05T00:01:00-07:00"); f.clock("parei", "2026-10-05T00:01:20-07:00");
  f.clock("comecei landing", "2026-10-05T01:00:00-07:00"); f.clock("parei", "2026-10-05T02:00:00-07:00");
  const mistake = f.snapshot().entries.at(-1); assert.ok(mistake);
  f.ledger.manage({ action: "void", entry_id: mistake.id, reason: "Accidental clock" }, "void");
  f.clock("comecei landing", "2026-10-05T03:00:00-07:00");
  const report = z.object({ total_hours: z.number(), earnings: z.object({ amount_usd_cents: z.number(), duration_ms: z.number(), timezone: z.string() }) })
    .parse(f.ledger.self({ action: "report", period_start: "2026-10-05", period_end: "2026-10-05" }, "ana", "local-day"));
  assert.equal(report.earnings.timezone, "America/Los_Angeles");
  assert.equal(report.earnings.duration_ms, 30_000); assert.equal(report.total_hours, 30 / 3600);
  assert.equal(report.earnings.amount_usd_cents, 1);
  assert.throws(() => f.ledger.self({ action: "report", period_start: "2026-10-05" }, "ana", "partial-period"), /both/);
  assert.throws(() => f.ledger.self({ action: "report", period_start: "2026-10-06", period_end: "2026-10-05" }, "ana", "backwards-period"), /before/);
});

test("original message timestamps produce the requested seven columns and survive restart", t => {
  const f = fixture(t);
  assert.match(f.clock("comecei landing", "2026-10-02T09:00:00-03:00") ?? "", /Ponto iniciado/);
  assert.equal(f.snapshot().total_hours, 0, "an open point never inflates payable hours");
  assert.match(f.clock("parei commit abc123", "2026-10-02T11:30:00-03:00") ?? "", /Total: 2 h 30 min\./);
  f.restart();
  const result = f.snapshot();
  assert.equal(result.total_hours, 2.5);
  assert.equal(result.open_entry, null);
  assert.deepEqual(result.sheet.values[0], SHEET_HEADERS);
  assert.deepEqual(result.sheet.values[1], ["2026-10-02", "2026-10-02 09:00:00 GMT-3", "2026-10-02 11:30:00 GMT-3", 2.5, 30, "Website", "landing | Build the landing page | github.com/team/site/issues/42 | commit abc123"]);
  assert.match(result.wiki.markdown, /Ana/);
  assert.match(result.wiki.markdown, /Recorded hours: 2.5/);
});

test("a pending model message survives restart with its original source, rate and timezone", t => {
  const f = fixture(t);
  const first = { line_uid: "line", chat_uid: "cht_ana", handle: "+15550000002", message_uid: "offline",
    body: "Started the landing page.", created_at: "2026-10-02T09:00:00-03:00" };
  assert.equal(f.ledger.clockAttempt(first), 1);
  f.ledger.manage({ ...f.contractor, rate_cents: 4000, timezone: "UTC" }, "changed-offline-rate");
  f.restart();
  assert.deepEqual(f.ledger.pendingClockMessages("line", "cht_ana"), [first]);
  assert.deepEqual(f.ledger.pendingClockMessages("another-line", "cht_ana"), []);
  assert.deepEqual(f.ledger.pendingClockMessages("line", "another-group"), []);
  assert.equal(f.ledger.clockAttempt({ ...first, body: "Changed body" }), 2);
  const response = f.ledger.clock(first, { kind: "start", detail: "landing" });
  const entry = f.snapshot().open_entry;
  assert.ok(entry);
  assert.equal(entry.start_ms, Date.parse(first.created_at));
  assert.equal(entry.rate_cents, 3000);
  assert.equal(entry.timezone, "America/Sao_Paulo");
  assert.equal(f.ledger.clockReceipt(first), response);
  assert.equal(f.snapshot().entries.length, 1);
  f.ledger.completeClockMessage("line", "cht_ana", first.message_uid);
  f.restart();
  assert.equal(f.ledger.isPendingClockMessage("line", "cht_ana", first.message_uid), false);
  assert.deepEqual(f.ledger.pendingClockMessages("line", "cht_ana"), []);
});

test("a clarified start retains its first message time, rate and timezone across restarts", t => {
  const f = fixture(t);
  const first = { line_uid: "line", chat_uid: "cht_ana", handle: "+15550000002", message_uid: "ambiguous",
    body: "Comecei a trabalhar agora.", created_at: "2026-10-02T09:00:00-03:00" };
  assert.match(f.ledger.clock(first, { kind: "clarify_start" }) ?? "", /09:00 BRT/);
  assert.equal(f.snapshot().entries.length, 0);
  f.ledger.manage({ ...f.contractor, rate_cents: 4000, timezone: "UTC" }, "changed-rate");
  f.restart();
  assert.equal(f.pendingStart(), first.created_at);
  const reply = { ...first, message_uid: "clarification", body: "Na landing.", created_at: "2026-10-02T09:10:00-03:00" };
  const confirmation = f.ledger.clock(reply, { kind: "confirm_start", detail: "landing" });
  assert.match(confirmation ?? "", /09:00 BRT/);
  const entry = f.snapshot().open_entry;
  assert.ok(entry);
  assert.equal(entry.start_ms, Date.parse(first.created_at));
  assert.equal(entry.rate_cents, 3000);
  assert.equal(entry.timezone, "America/Sao_Paulo");
  assert.equal(entry.start_message, JSON.stringify([first.line_uid, first.chat_uid, first.message_uid]));
  f.restart();
  assert.equal(f.ledger.clock(reply, { kind: "confirm_start", detail: "landing" }), confirmation);
  assert.equal(f.ledger.clock(first, { kind: "clarify_start" }), confirmation);
  assert.equal(f.snapshot().entries.length, 1);
  f.clock("/out", "2026-10-02T11:30:00-03:00");
  assert.equal(f.snapshot().total_hours, 2.5);
});

test("pending starts cannot cross sender, group or line, and a fresh start uses its own time", t => {
  const f = fixture(t);
  const first = { line_uid: "line", chat_uid: "cht_ana", handle: "+15550000002", message_uid: "pending",
    body: "Started working.", created_at: "2026-10-02T09:00:00-03:00" };
  f.ledger.clock(first, { kind: "clarify_start" });
  const reply = { ...first, message_uid: "answer", created_at: "2026-10-02T09:10:00-03:00", body: "Landing." };
  assert.equal(f.ledger.clock({ ...reply, handle: "+15550000003" }, { kind: "confirm_start", detail: "landing" }), undefined);
  assert.equal(f.ledger.clock({ ...reply, chat_uid: "cht_elsewhere" }, { kind: "confirm_start", detail: "landing" }), undefined);
  assert.match(f.ledger.clock({ ...reply, line_uid: "other-line" }, { kind: "confirm_start", detail: "landing" }) ?? "", /Não há um início pendente/);
  f.ledger.clock({ ...reply, message_uid: "withdrawn" }, { kind: "cancel_start" });
  assert.equal(f.pendingStart(), null);
  f.ledger.clock({ ...first, message_uid: "second-pending" }, { kind: "clarify_start" });
  f.ledger.clock({ ...reply, message_uid: "fresh" }, { kind: "start", detail: "landing" });
  assert.equal(f.snapshot().open_entry?.start_ms, Date.parse(reply.created_at));
  assert.equal(f.pendingStart(), null);
});

test("message replay is idempotent across restarts and source identity includes the line and chat", t => {
  const f = fixture(t);
  const timestamp = "2026-10-02T12:00:00Z";
  const first = f.clock("/in landing", timestamp, { message_uid: "same" });
  const revision = f.snapshot().revision;
  f.restart();
  assert.equal(f.clock("/in landing", timestamp, { message_uid: "same" }), first);
  assert.equal(f.snapshot().entries.length, 1);
  assert.equal(f.snapshot().revision, revision);
  f.clock("/out", "2026-10-02T13:00:00Z", { message_uid: "end" });
  f.clock("/out", "2026-10-02T13:00:00Z", { message_uid: "end" });
  assert.equal(f.snapshot().total_hours, 1);
});

test("a committed natural clock can be recovered without rerunning the model", t => {
  const f = fixture(t);
  const message = { line_uid: "line", chat_uid: "cht_ana", handle: "+15550000002", message_uid: "natural-start",
    body: "Starting the landing page now.", created_at: "2026-10-02T09:00:00-03:00" };
  assert.equal(f.ledger.clockReceipt(message), undefined);
  const confirmation = f.ledger.clock(message, { kind: "start", detail: "landing" });
  f.restart();
  assert.equal(f.ledger.clockReceipt(message), confirmation);
  assert.equal(f.ledger.clockReceipt({ ...message, handle: "+15550000003" }), undefined);
  assert.equal(f.ledger.clockReceipt({ ...message, chat_uid: "cht_other" }), undefined);
  assert.equal(f.ledger.clockReceipt({ ...message, line_uid: "other-line" }), undefined);
  assert.equal(f.snapshot().entries.length, 1);
});

test("only a registered sender in their registered thread can clock work, including unassigned activities", t => {
  const f = fixture(t);
  assert.equal(f.clock("comecei landing", "2026-10-02T12:00:00Z", { handle: "+15550000003" }), undefined);
  assert.equal(f.clock("comecei landing", "2026-10-02T12:00:00Z", { chat_uid: "cht_other" }), undefined);
  assert.equal(clockCommand("Ela disse que comecei landing"), undefined);
  assert.match(f.clock("comecei outra", "2026-10-02T12:00:00Z") ?? "", /Ponto iniciado/);
  assert.equal(f.snapshot().entries.length, 1);
  assert.equal(f.snapshot().open_entry?.details, "outra");
});

test("each contractor can use the same demand id and cannot access another contractor's session", t => {
  const f = fixture(t);
  f.ledger.manage({ ...f.contractor, id: "bea", name: "Bea", handle: "+15550000003", chat_uid: "cht_bea" }, "bea");
  f.ledger.manage({ action: "demand", id: "landing", contractor_id: "bea", project: "Design", summary: "Design the landing page" }, "bea-demand");
  f.clock("comecei landing", "2026-10-02T12:00:00Z");
  assert.match(f.clock("ponto", "2026-10-02T12:10:00Z", { handle: "+15550000003", chat_uid: "cht_bea" }) ?? "", /Nenhum ponto aberto/);
  f.clock("comecei landing", "2026-10-02T12:00:00Z", { handle: "+15550000003", chat_uid: "cht_bea" });
  assert.equal(f.ledger.report().length, 2);
});

test("a second start, reversed stop and malformed timestamp cannot change an open point", t => {
  const f = fixture(t);
  f.clock("comecei landing", "2026-10-02T12:00:00Z");
  assert.match(f.clock("comecei landing", "2026-10-02T12:05:00Z") ?? "", /já está aberto/);
  assert.match(f.clock("parei", "2026-10-02T11:00:00Z") ?? "", /antes do início/);
  assert.throws(() => f.clock("parei", "2026-10-02 13:00"));
  assert.equal(f.snapshot().entries.length, 1);
  assert.ok(f.snapshot().open_entry);
});

test("rates and timezones are captured at the start, including during a rate change", t => {
  const f = fixture(t);
  f.clock("comecei landing", "2026-10-02T12:00:00Z");
  f.ledger.manage({ ...f.contractor, rate_cents: 4500, timezone: "Europe/London" }, "new-rate");
  f.clock("parei", "2026-10-02T13:00:00Z");
  assert.equal(f.snapshot().sheet.values[1]?.[4], 30);
  assert.match(String(f.snapshot().sheet.values[1]?.[1]), /09:00:00 GMT-3/);
  f.clock("comecei landing", "2026-10-02T14:00:00Z");
  f.clock("parei", "2026-10-02T15:00:00Z");
  assert.equal(f.snapshot().sheet.values[2]?.[4], 45);
  assert.match(String(f.snapshot().sheet.values[2]?.[1]), /15:00:00 GMT\+1/);
});

test("midnight and daylight saving use elapsed time rather than clock face subtraction", t => {
  const f = fixture(t);
  f.clock("comecei landing", "2026-10-02T23:30:00-03:00");
  f.clock("parei", "2026-10-03T00:30:00-03:00");
  assert.equal(f.snapshot().total_hours, 1);
  assert.match(String(f.snapshot().sheet.values[1]?.[2]), /2026-10-03/);
  f.ledger.manage({ ...f.contractor, timezone: "America/New_York" }, "timezone");
  f.clock("comecei landing", "2026-11-01T01:30:00-04:00");
  f.clock("parei", "2026-11-01T01:30:00-05:00");
  assert.equal(f.snapshot().total_hours, 2);
});

test("owner corrections preserve evidence, reject overlaps and can close a forgotten stop", t => {
  const f = fixture(t);
  f.clock("comecei landing", "2026-10-02T09:00:00-03:00");
  f.clock("parei", "2026-10-02T10:00:00-03:00");
  f.clock("comecei landing", "2026-10-02T11:00:00-03:00");
  const entry = f.snapshot().open_entry;
  assert.ok(entry);
  assert.throws(() => f.ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T09:30:00-03:00", finish: "2026-10-02T12:00:00-03:00", reason: "Forgot to stop" }, "bad-correction"), /overlap/);
  f.ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T11:00:00-03:00", finish: "2026-10-02T12:00:00-03:00", reason: "Forgot to stop, confirmed with Ana" }, "correction");
  assert.equal(f.snapshot().open_entry, null);
  assert.equal(f.snapshot().total_hours, 2);
  assert.match(JSON.stringify(f.snapshot().audit), /Forgot to stop, confirmed with Ana/);
  assert.match(JSON.stringify(f.snapshot().audit), /before_json/);
});

test("manual entries require exact times, rate and a reason, and a retried tool call inserts only once", t => {
  const f = fixture(t);
  const input = { action: "manual", contractor_id: "ana", demand_id: "landing", start: "2026-10-02T09:00:00-03:00", finish: "2026-10-02T11:00:00-03:00", rate_cents: 2500, reason: "Forgot both messages" };
  assert.deepEqual(f.ledger.manage(input, "manual"), f.ledger.manage(input, "manual"));
  assert.equal(f.snapshot().total_hours, 2);
  assert.equal(f.snapshot().entries.length, 1);
  assert.throws(() => f.ledger.manage({ ...input, start: "2026-10-02T10:00:00-03:00" }, "overlap"), /overlap/);
});

test("a sync in progress cannot acknowledge newer points or a different spreadsheet", t => {
  const f = fixture(t);
  f.ledger.manage({ action: "link_sheet", contractor_id: "ana", sheet_id: "spreadsheet_ana" }, "link");
  const version = f.snapshot().revision;
  f.clock("comecei landing", "2026-10-02T12:00:00Z");
  f.ledger.manage({ action: "projected", contractor_id: "ana", target: "sheet", sheet_id: "spreadsheet_ana", revision: version }, "projected");
  assert.equal(f.snapshot().sheet.pending, true);
  assert.equal(f.snapshot().wiki.pending, true);
  f.ledger.manage({ action: "link_sheet", contractor_id: "ana", sheet_id: "spreadsheet_new" }, "relink");
  assert.throws(() => f.ledger.manage({ action: "projected", contractor_id: "ana", target: "sheet", sheet_id: "spreadsheet_ana", revision: version }, "old-sheet"), /current spreadsheet/);
  assert.equal(f.snapshot().sheet.pending, true);
});
