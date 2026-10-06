import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { renderConfig, syncConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";
import { identityFromApi } from "../boot/identity.ts";

test("CEO spec: the installed OpenClaw variant exposes Ours, its owner tool and its operating skill", () => {
  const cfg = renderConfig(probeIdentity, "http://127.0.0.1:1");
  assert.equal(cfg.agents.entries.main.identity.name, "Ours");
  assert.ok(cfg.tools.alsoAllow.includes("plow_hours"));
  assert.equal(cfg.channels.plow.threadTrust, "untrusted");
  assert.match(readFileSync("/opt/plow/skills/contractor-hours/SKILL.md", "utf8"), /Use `plow_hours` from the owner's main Plow DM/);
  assert.match(readFileSync("/opt/plow/prompt/AGENTS.md", "utf8"), /You are Ours/);
});

test("boot enables ambient group silence on an existing installation without changing other surfaces", async t => {
  const directory = mkdtempSync(join(tmpdir(), "plow-hours-config-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const configPath = join(directory, "openclaw.json"), includeDirectory = join(directory, "owned");
  const otherSurface = { silentReply: { group: "disallow" } };
  writeFileSync(configPath, JSON.stringify({ surfaces: { plow: otherSurface, webchat: otherSurface } }));
  await syncConfig(renderConfig(probeIdentity, "http://127.0.0.1:1"), configPath, includeDirectory);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  const policyPath = join(includeDirectory, "plow-silent-reply.json5");
  assert.deepEqual(saved.surfaces.plow.silentReply, { $include: policyPath });
  assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf8")), { group: "allow" });
  assert.deepEqual(saved.surfaces.webchat, otherSurface);
});

test("boot rejects a different volume owner or line and generic shell/file tools stay unavailable", () => {
  const cfg = renderConfig(probeIdentity, "http://127.0.0.1:1");
  for (const tool of ["exec", "read", "write", "edit", "apply_patch"]) assert.ok(cfg.tools.deny.includes(tool));
  assert.deepEqual(cfg.gateway.auth.trustedProxy.allowUsers, ["mem_probe"]);
  const wrongOwner = structuredClone(probeIdentity);
  wrongOwner.owner_uid = "other-owner";
  assert.throws(() => renderConfig(wrongOwner, "http://127.0.0.1:1"), /different Plow owner or line/);
  assert.throws(() => renderConfig({ ...probeIdentity, line: { uid: "different-line" } }, "http://127.0.0.1:1"), /different Plow owner or line/);
});

test("boot binds the authenticated account owner, independently of per-chat participant IDs", async t => {
  const identities = structuredClone(probeIdentity);
  identities.chats.push({ ...identities.chats[0]!, uid: "cht_group", participants: [
    { type: "agent", relationship: "self", line: identities.line },
    { type: "member", uid: "different-group-participant", role: "owner" },
  ] });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(url);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-agent-token");
    return Response.json(url.endsWith("/auth/owner-uid") ? { owner_uid: "mem_probe" } : identities);
  });
  const identity = await identityFromApi("http://127.0.0.1:1", "fixture-agent-token");
  assert.equal(identity.owner_uid, "mem_probe");
  assert.deepEqual(requests, ["http://127.0.0.1:1/v1/agents/me", "http://127.0.0.1:1/v1/auth/owner-uid"]);
  assert.deepEqual(renderConfig(identity, "http://127.0.0.1:1").gateway.auth.trustedProxy.allowUsers, ["mem_probe"]);
});

test("boot refuses missing or unavailable account owner identity without trusting a chat participant", async t => {
  assert.throws(() => renderConfig({ ...probeIdentity, owner_uid: undefined }, "http://127.0.0.1:1"), /authenticated account owner/);
  for (const response of [Response.json({}), Response.json({}, { status: 403 })]) {
    t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/agents/me") ? Response.json(probeIdentity) : response);
    await assert.rejects(() => identityFromApi("http://127.0.0.1:1", "fixture-agent-token"), /Owner identity/);
  }
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
