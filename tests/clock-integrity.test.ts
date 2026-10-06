import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { workText } from "../plugin/hours-period.ts";
import { HoursLedger } from "../plugin/hours.ts";
import { hoursWebSnapshot } from "../plugin/hours-web.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hours-integrity-"));
  let ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  const profile = { action: "contractor", id: "ana", name: "Ana", handle: "ana@example.test", chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000 };
  ledger.manage(profile, "register");
  for (const id of ["landing", "brand"]) ledger.manage({ action: "demand", id, contractor_id: "ana", project: id, summary: `Work on ${id}` }, id);
  const source = (uid: string, hour: string, body = "") => ({ line_uid: "ln_test", chat_uid: "cht_ana", handle: profile.handle,
    message_uid: uid, created_at: `2026-10-02T${hour}:00Z`, body });
  return { directory, profile, source, get ledger() { return ledger; }, restart() { ledger.close(); ledger = new HoursLedger(directory); },
    report() { const r = ledger.report("ana")[0]; assert.ok(r); return r; } };
}

test("one natural task switch preserves every minute and both rates, with all-or-nothing replay", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("start", "09:00"), { kind: "start", detail: "landing" });
  f.ledger.manage({ ...f.profile, rate_cents: 5000 }, "new-rate");
  const change = f.source("switch", "10:00", "Finished landing; starting brand now");
  f.ledger.clockAttempt(change);
  f.ledger.manage({ ...f.profile, rate_cents: 7000 }, "rate-after-arrival");
  const confirmation = f.ledger.clock(change, { kind: "switch", detail: "brand", details: "commit abc123" });
  assert.match(confirmation ?? "", /encerrado.*iniciado/);
  f.restart();
  assert.equal(f.ledger.clock(change, { kind: "switch", detail: "brand", details: "edited" }), confirmation);
  f.ledger.clock(f.source("stop", "11:00"), { kind: "stop", detail: "done" });
  const r = f.report();
  assert.equal(r.total_hours, 2);
  assert.deepEqual(r.entries.map(e => [e.demand_id, e.rate_cents, e.end_ms! - e.start_ms]), [["landing", 3000, 3600000], ["brand", 5000, 3600000]]);
  assert.equal(r.entries[0]?.end_ms, r.entries[1]?.start_ms);
});

test("an immediate start with no assigned work keeps its time and rate when the overview arrives, including after restart", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("plain-start", "09:00", "Starting work now"), { kind: "start", detail: "" });
  const original = f.report().open_entry;
  assert.ok(original); assert.equal(original.details, ""); assert.equal(f.report().pending_clock.start, null);
  f.ledger.manage({ ...f.profile, rate_cents: 5000, timezone: "America/New_York" }, "rate-change");
  f.restart();
  const source = f.source("overview", "09:03", "Animation for Rowan");
  const receipt = f.ledger.clock(source, { kind: "note", detail: "Animation for Rowan", project: "Rowan" });
  assert.equal(f.ledger.clock(source, { kind: "note", detail: "Duplicate message", project: "Other" }), receipt);
  f.ledger.clock(f.source("new-activity", "09:15"), { kind: "note", detail: "Color correction for another video", project: "Another project" });
  const active = f.report().open_entry;
  assert.ok(active); assert.equal(active.id, original.id); assert.equal(active.start_ms, original.start_ms);
  assert.equal(active.rate_cents, 3000); assert.equal(active.timezone, "UTC"); assert.equal(f.report().entries.length, 1);
  assert.equal(active.details, "Animation for Rowan\nColor correction for another video");
  const view = hoursWebSnapshot(f.ledger).contractors[0];
  assert.ok(view); assert.equal(view.entries[0]?.project, "Rowan"); assert.ok(!view.entries[0]?.details.includes("activity_"));
  assert.ok(view.demands.every(d => d.id !== active.demand_id), "Reported activities do not appear as owner-assigned tasks");
  f.ledger.clock(f.source("plain-stop", "10:00"), { kind: "stop", detail: "Finished" });
  assert.equal(f.report().total_hours, 1);
  f.ledger.manage({ action: "billing_request", contractor_id: "ana", country: "US", period_start: "2026-10-02", period_end: "2026-10-02" }, "reported-billing");
  f.ledger.manage({ action: "close_period", contractor_id: "ana" }, "reported-close");
  assert.equal(f.ledger.billingReport("ana").expected.expected_amount_cents, 3000);
  assert.equal(f.ledger.billingReport("ana").approved, false);
  f.ledger.clock({ ...f.source("next-start", "09:00"), created_at: "2026-10-03T09:00:00Z" }, { kind: "start", detail: active.demand_id, description: "" });
  f.ledger.clock({ ...f.source("next-overview", "09:03"), created_at: "2026-10-03T09:03:00Z" }, { kind: "note", detail: "A different animation", project: "New project" });
  assert.notEqual(f.report().open_entry?.demand_id, active.demand_id);
  const previous = f.report().demands.find(d => d.id === active.demand_id);
  assert.equal(previous?.summary, "Animation for Rowan"); assert.equal(previous?.project, "Rowan");
  assert.equal(f.ledger.billingReport("ana").expected.expected_amount_cents, 3000);
});

test("legacy pending starts accept a free-form overview without a task approval and preserve their original source", t => {
  const f = fixture(t);
  const origin = f.source("legacy-start", "09:00", "Started working");
  f.ledger.clock(origin, { kind: "clarify_start" });
  f.restart();
  f.ledger.clock(f.source("legacy-overview", "09:03"), { kind: "confirm_start", detail: "", description: "Animation for Rowan", project: "Rowan" });
  const active = f.report().open_entry;
  assert.ok(active); assert.equal(active.start_ms, Date.parse(origin.created_at)); assert.equal(active.details, "Animation for Rowan");
  assert.equal(f.report().pending_clock.start, null); assert.equal(f.report().demands.find(d => d.id === active.demand_id)?.reported, 1);
});

test("invalid switches keep the original clock and closed periods reject late starts", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("first", "09:00"), { kind: "start", detail: "landing" });
  f.ledger.clock(f.source("wrong", "10:00"), { kind: "switch", detail: "missing", details: "" });
  assert.equal(f.report().open_entry?.demand_id, "landing");
  assert.equal(f.report().entries.length, 1);
  f.ledger.clock(f.source("end", "11:00"), { kind: "stop", detail: "" });
  f.ledger.manage({ action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-02" }, "request");
  f.ledger.manage({ action: "close_period", contractor_id: "ana" }, "close");
  const previousDay = { ...f.source("late-before-closed", "22:00"), created_at: "2026-10-01T22:00:00Z" };
  assert.match(f.ledger.clock(previousDay, { kind: "start", detail: "brand" }) ?? "", /cruza/);
  assert.equal(f.report().open_entry, null);
});

test("a database failure after the old task stops rolls back the entire switch, and retry applies once", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("start", "09:00"), { kind: "start", detail: "landing" });
  const before = f.report();
  const db = new DatabaseSync(join(f.directory, "hours.sqlite"));
  db.exec("CREATE TRIGGER fail_switch BEFORE INSERT ON entries WHEN NEW.demand_id='brand' BEGIN SELECT RAISE(ABORT,'Injected storage failure'); END;");
  const source = f.source("switch-with-failure", "10:00");
  assert.throws(() => f.ledger.clock(source, { kind: "switch", detail: "brand", details: "done" }), /Injected storage failure/);
  assert.deepEqual(f.report(), before);
  db.exec("DROP TRIGGER fail_switch"); db.close();
  f.ledger.clock(source, { kind: "switch", detail: "brand", details: "done" });
  f.ledger.clock(source, { kind: "switch", detail: "brand", details: "done" });
  assert.equal(f.report().entries.length, 2); assert.equal(f.report().total_hours, 1);
});

test("a stop delivered before its start is recovered across restart, and stop retries retain the first timestamp", t => {
  const f = fixture(t);
  const stop = f.source("early-delivered-stop", "11:00");
  f.ledger.clockAttempt(stop);
  f.ledger.clock(stop, { kind: "stop", detail: "commit abc" });
  f.ledger.completeClockMessage(stop.line_uid, stop.chat_uid, stop.message_uid);
  f.restart();
  f.ledger.clock(f.source("late-delivered-start", "09:00"), { kind: "start", detail: "landing" });
  assert.equal(f.report().total_hours, 2);
  assert.equal(f.report().open_entry, null);
  assert.match(f.ledger.clock({ ...stop, created_at: "2026-10-02T13:00:00Z" }, { kind: "stop", detail: "changed" }) ?? "", /2 h/);
  f.ledger.clock(f.source("second-start", "12:00"), { kind: "start", detail: "brand" });
  const secondStop = f.source("retry-stop", "12:30");
  f.ledger.clockAttempt(secondStop);
  f.restart();
  f.ledger.clock({ ...secondStop, created_at: "2026-10-02T18:00:00Z" }, { kind: "stop", detail: "done" });
  assert.equal(f.report().total_hours, 2.5);
  assert.equal(f.report().entries.length, 2);
});

test("an accidental clock can be voided without creating zero hours; task corrections preserve evidence", t => {
  const f = fixture(t);
  const original = f.source("accidental", "08:00");
  f.ledger.clock(original, { kind: "start", detail: "landing" });
  const id = f.report().open_entry!.id;
  f.ledger.manage({ action: "void", entry_id: id, reason: "Started by mistake; no work performed" }, "void");
  assert.equal(f.report().open_entry, null);
  assert.equal(f.report().total_hours, 0);
  assert.match(f.ledger.clockReceipt(original) ?? "", /anulado/);
  assert.equal(hoursWebSnapshot(f.ledger).contractors[0]?.entries.length, 0);
  f.ledger.clock(f.source("actual", "09:00"), { kind: "start", detail: "landing" });
  f.ledger.clock(f.source("end", "10:00"), { kind: "stop", detail: "commit" });
  const entry = f.report().entries.find(e => !e.voided)!;
  f.ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", demand_id: "brand", reason: "Wrong assignment" }, "correct");
  const fixed = f.report().entries.find(e => !e.voided)!;
  assert.equal(fixed.demand_id, "brand");
  assert.equal(fixed.start_message, entry.start_message);
  assert.equal(fixed.rate_cents, entry.rate_cents);
  assert.ok(f.report().audit.some(a => a.action === "void"));
  assert.ok(f.report().audit.some(a => a.action === "correct"));
});

test("pending-start finish is recovered after task clarification, and cancelled unresolved sources cannot reapply", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("unclear", "09:00"), { kind: "clarify_start" });
  f.ledger.clock(f.source("finish-before-answer", "10:00"), { kind: "stop", detail: "done" });
  f.restart();
  f.ledger.clock(f.source("answer", "10:15"), { kind: "confirm_start", detail: "landing" });
  assert.equal(f.report().total_hours, 1);
  assert.equal(f.report().open_entry, null);
  const abandoned = f.source("abandoned", "11:00", "Maybe working?");
  f.ledger.clockAttempt(abandoned);
  f.ledger.manage({ action: "resolve_clock", contractor_id: "ana", reason: "Confirmed with worker: no work" }, "resolve");
  assert.match(f.ledger.clock(abandoned, { kind: "start", detail: "brand" }) ?? "", /nenhuma hora/);
  assert.equal(f.report().total_hours, 1);
  assert.equal(f.report().pending_clock.messages, 0);
});

test("long sessions require owner review; archiving and deactivation preserve history and remove clock access", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("long-start", "00:00"), { kind: "start", detail: "landing" });
  f.ledger.clock({ ...f.source("long-end", "12:00"), created_at: "2026-10-03T12:00:00Z" }, { kind: "stop", detail: "forgot to stop" });
  const id = f.report().entries[0]!.id;
  assert.deepEqual(f.report().review_needed, [id]);
  f.ledger.manage({ action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-03" }, "request");
  assert.throws(() => f.ledger.manage({ action: "close_period", contractor_id: "ana" }, "close-before-review"), /review long/);
  f.ledger.manage({ action: "correct", entry_id: id, start: "2026-10-02T00:00:00Z", finish: "2026-10-02T02:00:00Z", reason: "Worker confirmed 2 hours" }, "correct");
  assert.deepEqual(f.report().review_needed, []);
  f.ledger.manage({ action: "archive_demand", contractor_id: "ana", demand_id: "landing", reason: "Complete" }, "archive");
  assert.match(f.ledger.clock(f.source("archived", "15:00"), { kind: "start", detail: "landing" }) ?? "", /Ponto iniciado/);
  assert.equal(f.report().demands.find(d => d.id === "landing")?.active, 0, "Clocking reported work does not reactivate an archived assignment");
  f.ledger.manage({ action: "void", entry_id: f.report().open_entry!.id, reason: "Owner withdrew the mistaken start" }, "void-archived-start");
  f.ledger.manage({ action: "deactivate", contractor_id: "ana", reason: "Contract ended" }, "deactivate");
  assert.equal(f.ledger.groupContractor("cht_ana"), undefined);
  assert.equal(f.ledger.clock(f.source("after-departure", "16:00"), { kind: "start", detail: "brand" }), undefined);
  assert.equal(f.report().total_hours, 2);
});

test("banking notes are omitted from dashboard, TSV and wiki while work references remain", t => {
  assert.equal(workText("Me passe a chave Pix e a conta ACH de todos"), "Me passe a chave Pix e a conta ACH de todos", "questions without banking values must remain readable");
  const f = fixture(t);
  f.ledger.clock(f.source("start", "09:00"), { kind: "start", detail: "landing" });
  f.ledger.clock(f.source("end", "10:00"), { kind: "stop", detail: "commit abc123\nChave Pix: sensitive@example.test\nrouting number: 021000021 account number: 1234567890" });
  const r = f.report();
  const projections = JSON.stringify([r.sheet, r.wiki, hoursWebSnapshot(f.ledger)]);
  assert.match(projections, /abc123/);
  for (const secret of ["sensitive@example.test", "021000021", "1234567890"]) assert.ok(!projections.includes(secret));
});

test("eight independent processes clock ten sessions each without crossing contractors or duplicating totals", async t => {
  const f = fixture(t);
  const workerIds = Array.from({ length: 8 }, (_, i) => `worker${i}`);
  for (const id of workerIds) {
    f.ledger.manage({ ...f.profile, id, name: id, handle: `${id}@example.test`, chat_uid: `cht_${id}`, rate_cents: 1000 + Number(id.slice(6)) }, `register-${id}`);
    f.ledger.manage({ action: "demand", contractor_id: id, id: "work", project: id, summary: "Assigned work" }, `demand-${id}`);
  }
  const code = `import {HoursLedger} from ${JSON.stringify(new URL("../plugin/hours.ts", import.meta.url).href)};
    const [directory,id]=process.argv.slice(1), ledger=new HoursLedger(directory);
    for(let i=0;i<10;i++){ const start=Date.parse('2026-10-02T00:00:00Z')+i*3600000;
      const source={line_uid:'line',chat_uid:'cht_'+id,handle:id+'@example.test',message_uid:id+'-'+i,created_at:new Date(start).toISOString(),body:''};
      ledger.clock(source,{kind:'start',detail:'work'}); ledger.clock({...source,message_uid:source.message_uid+'-end',created_at:new Date(start+1800000).toISOString()},{kind:'stop',detail:id}); }
    ledger.close();`;
  await Promise.all(workerIds.map(id => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, f.directory, id], { timeout: 90000 })));
  for (const id of workerIds) {
    const r = f.ledger.report(id)[0]!;
    assert.equal(r.entries.length, 10); assert.equal(r.total_hours, 5);
    assert.ok(r.entries.every(e => e.contractor_id === id && e.details === id && e.rate_cents === 1000 + Number(id.slice(6))));
  }
});

test("out-of-order starts and stops keep conflicting timestamps for review rather than silently losing work", t => {
  const f = fixture(t);
  f.ledger.clock(f.source("newer-start", "11:00"), { kind: "start", detail: "brand" });
  f.ledger.clock(f.source("earlier-start", "09:00"), { kind: "start", detail: "landing" });
  f.ledger.clock(f.source("earlier-stop", "10:00"), { kind: "stop", detail: "done" });
  f.ledger.completeClockMessage("ln_test", "cht_ana", "earlier-start");
  f.ledger.completeClockMessage("ln_test", "cht_ana", "earlier-stop");
  f.restart();
  assert.equal(f.report().pending_clock.reviews.length, 2);
  assert.equal(f.report().open_entry?.start_ms, Date.parse("2026-10-02T11:00:00Z"));
  assert.equal(f.report().total_hours, 0);
  assert.equal(hoursWebSnapshot(f.ledger).contractors[0]?.review_needed, true);
  f.ledger.clock(f.source("current-stop", "12:00"), { kind: "stop", detail: "done" });
  f.ledger.manage({ action: "billing_request", contractor_id: "ana", country: "BR", period_start: "2026-10-02", period_end: "2026-10-02" }, "request");
  assert.throws(() => f.ledger.manage({ action: "close_period", contractor_id: "ana" }, "close"), /pending clock/);
  f.ledger.manage({ action: "manual", contractor_id: "ana", demand_id: "landing", start: "2026-10-02T09:00:00Z", finish: "2026-10-02T10:00:00Z", rate_cents: 3000, reason: "Worker confirmed the earlier session" }, "manual-earlier");
  f.ledger.manage({ action: "resolve_clock", contractor_id: "ana", reason: "Recovered earlier start/stop as the verified manual session" }, "resolve");
  assert.equal(f.report().pending_clock.reviews.length, 0); assert.equal(f.report().total_hours, 2);
  f.ledger.manage({ action: "close_period", contractor_id: "ana" }, "close-after-review");
  assert.equal(f.ledger.billingReport("ana").expected?.total_hours, 2);
});
