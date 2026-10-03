import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";

test("CEO spec: the installed OpenClaw variant exposes Plow Hours, its owner tool and its operating skill", () => {
  const cfg = renderConfig(probeIdentity, "http://127.0.0.1:1");
  assert.equal(cfg.agents.entries.main.identity.name, "Plow Hours");
  assert.ok(cfg.tools.alsoAllow.includes("plow_hours"));
  assert.equal(cfg.channels.plow.threadTrust, "untrusted");
  assert.match(readFileSync("/opt/plow/skills/contractor-hours/SKILL.md", "utf8"), /Use `plow_hours` from the owner's main Plow DM/);
  assert.match(readFileSync("/opt/plow/prompt/AGENTS.md", "utf8"), /You are Plow Hours/);
});

test("boot rejects a different volume owner or line and generic shell/file tools stay unavailable", () => {
  const cfg = renderConfig(probeIdentity, "http://127.0.0.1:1");
  for (const tool of ["exec", "read", "write", "edit", "apply_patch"]) assert.ok(cfg.tools.deny.includes(tool));
  assert.deepEqual(cfg.gateway.auth.trustedProxy.allowUsers, ["mem_probe"]);
  const wrongOwner = structuredClone(probeIdentity);
  for (const chat of wrongOwner.chats) for (const participant of chat.participants)
    if (participant.type === "member" && participant.role === "owner") participant.uid = "other-owner";
  assert.throws(() => renderConfig(wrongOwner, "http://127.0.0.1:1"), /different Plow owner or line/);
  assert.throws(() => renderConfig({ ...probeIdentity, line: { uid: "different-line" } }, "http://127.0.0.1:1"), /different Plow owner or line/);
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "plow-hours-spec-"));
  let ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  for (const [id, name, handle] of [["ana", "Ana", "+15550000002"], ["bea", "Bea", "+15550000003"]]) {
    ledger.manage({ action: "contractor", id, name, handle, chat_uid: `cht_${id}`, timezone: "America/Sao_Paulo", rate_cents: 3000 }, `register-${id}`);
    ledger.manage({ action: "demand", id: "landing", contractor_id: id, project: id === "ana" ? "Website" : "QA", summary: `${name}'s assigned work`, references: "https://github.com/example/site/issues/42" }, `demand-${id}`);
  }
  return {
    get ledger() { return ledger; },
    restart() { ledger.close(); ledger = new HoursLedger(directory); },
    clock(id: string, body: string, created_at: string, message_uid: string) {
      return ledger.clock({ line_uid: "line", chat_uid: `cht_${id}`, handle: id === "ana" ? "+15550000002" : "+15550000003", body, created_at, message_uid });
    },
  };
}

test("CEO spec: breaks are excluded, each contractor keeps their assigned work, and the seven-column timesheet and wiki survive restart", t => {
  const f = fixture(t);
  for (const [start, finish, number] of [["09:00:00", "10:30:00", "1"], ["11:00:00", "12:00:00", "2"], ["13:00:00", "14:30:00", "3"]]) {
    assert.match(f.clock("ana", "comecei landing", `2026-10-02T${start}-03:00`, `ana-start-${number}`) ?? "", /Ponto iniciado/);
    assert.match(f.clock("ana", `parei commit abc${number}`, `2026-10-02T${finish}-03:00`, `ana-stop-${number}`) ?? "", /Ponto encerrado/);
  }
  f.clock("bea", "start landing", "2026-10-02T09:00:00-03:00", "bea-start");
  f.clock("bea", "stop reviewed issue 42", "2026-10-02T09:15:00-03:00", "bea-stop");
  f.clock("ana", "/in landing", "2026-10-02T15:00:00-03:00", "ana-open");
  f.restart();
  const ana = f.ledger.report("ana")[0];
  const bea = f.ledger.report("bea")[0];
  assert.ok(ana && bea);
  assert.equal(ana.total_hours, 4, "the 30-minute break, lunch and open session are excluded");
  assert.equal(bea.total_hours, 0.25);
  assert.equal(ana.sheet.values.length, 4);
  assert.deepEqual(ana.sheet.values[0], ["Day", "Start", "Finish", "Total (Hours)", "Rate (USD)", "Project", "Details (github ticket, git commit, etc)"]);
  assert.deepEqual(ana.sheet.values[1], ["2026-10-02", "2026-10-02 09:00:00 GMT-3", "2026-10-02 10:30:00 GMT-3", 1.5, 30, "Website", "landing | Ana's assigned work | https://github.com/example/site/issues/42 | commit abc1"]);
  assert.equal(bea.sheet.values[1]?.[5], "QA");
  assert.ok(ana.entries[0]?.start_message.includes("ana-start-1"));
  assert.ok(ana.open_entry);
  assert.match(ana.wiki.markdown, /Recorded hours: 4/);
  assert.match(ana.wiki.markdown, /https:\/\/github.com\/example\/site\/issues\/42/);
  assert.match(ana.wiki.markdown, /commit abc1/);
  assert.match(ana.wiki.markdown, /open, excluded from totals/);
  assert.ok(!ana.wiki.markdown.includes("Bea's assigned work"));
  assert.equal(ana.wiki.relative_path, "_raw/contractor-hours/ana.md");
  assert.equal(ana.sheet.url, null, "reports work before a Google spreadsheet exists");
});

test("CEO spec: each contractor has a distinct Sheets destination and independent, durable Sheets/wiki synchronization state", t => {
  const f = fixture(t);
  f.ledger.manage({ action: "link_sheet", contractor_id: "ana", sheet_id: "spreadsheet_ana_spec" }, "link-ana");
  assert.throws(() => f.ledger.manage({ action: "link_sheet", contractor_id: "bea", sheet_id: "spreadsheet_ana_spec" }, "duplicate-destination"), /separate spreadsheet/);
  f.ledger.manage({ action: "link_sheet", contractor_id: "bea", sheet_id: "spreadsheet_bea_spec" }, "link-bea");
  const revision = f.ledger.report("ana")[0]?.revision;
  assert.ok(revision);
  f.ledger.manage({ action: "projected", contractor_id: "ana", target: "wiki", revision }, "wiki-readback");
  f.restart();
  let ana = f.ledger.report("ana")[0];
  assert.ok(ana);
  assert.equal(ana.sheet.url, "https://docs.google.com/spreadsheets/d/spreadsheet_ana_spec/edit");
  assert.equal(ana.sheet.pending, true);
  assert.equal(ana.wiki.pending, false);
  f.ledger.manage({ action: "projected", contractor_id: "ana", target: "sheet", sheet_id: "spreadsheet_ana_spec", revision }, "sheet-readback");
  f.clock("ana", "start landing", "2026-10-02T09:00:00-03:00", "new-start");
  ana = f.ledger.report("ana")[0];
  assert.ok(ana);
  assert.equal(ana.sheet.pending, true, "a newer clock needs another sheet write");
  assert.equal(ana.wiki.pending, true, "a newer clock needs another wiki write");
  assert.equal(f.ledger.report("bea")[0]?.sheet.pending, true);
});

test("CEO spec: payments are a future step, and payment requests cannot mutate the hours record", t => {
  const f = fixture(t);
  const before = f.ledger.report();
  assert.throws(() => f.ledger.manage({ action: "pay", contractor_id: "ana", amount_usd: 120 }, "pay"));
  assert.throws(() => f.ledger.manage({ action: "mark_paid", contractor_id: "ana" }, "mark-paid"));
  assert.deepEqual(f.ledger.report(), before);
  assert.match(before[0]?.wiki.markdown ?? "", /No payment has been sent/);
});
