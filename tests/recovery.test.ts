import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { createBackup, restoreBackup } from "../hours-source/backup.mjs";

test("v4 database upgrades preserve sources, captured rates, invoices and legacy payment instructions", async t => {
  const root = await mkdtemp(join(tmpdir(), "hours-v4-upgrade-"));
  t.after(() => rm(root, { recursive: true }));
  const db = new DatabaseSync(join(root, "hours.sqlite"));
  db.exec(`CREATE TABLE contractors(id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, chat_uid TEXT NOT NULL,
    timezone TEXT NOT NULL, rate_cents INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, sheet_id TEXT, sheet_revision INTEGER NOT NULL DEFAULT 0, wiki_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE demands(id TEXT NOT NULL, contractor_id TEXT NOT NULL REFERENCES contractors(id), project TEXT NOT NULL, summary TEXT NOT NULL, "references" TEXT NOT NULL, PRIMARY KEY(contractor_id,id));
    CREATE TABLE entries(id TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), demand_id TEXT NOT NULL, start_ms INTEGER NOT NULL,
      end_ms INTEGER CHECK(end_ms IS NULL OR end_ms>start_ms), rate_cents INTEGER NOT NULL, timezone TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', start_message TEXT NOT NULL, stop_message TEXT,
      FOREIGN KEY(contractor_id,demand_id) REFERENCES demands(contractor_id,id));
    CREATE UNIQUE INDEX one_open_entry ON entries(contractor_id) WHERE end_ms IS NULL;
    CREATE TABLE billing_requests(contractor_id TEXT PRIMARY KEY REFERENCES contractors(id), country TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, invoice_json TEXT, payment_json TEXT, tax_document_url TEXT);
    INSERT INTO contractors(id,name,handle,chat_uid,timezone,rate_cents) VALUES('ana','Ana','ana@example.test','cht_ana','UTC',5000);
    INSERT INTO demands VALUES('work','ana','Website','Landing','https://github.com/example/work/42');`);
  const start = Date.parse("2026-10-02T09:00:00Z"), end = Date.parse("2026-10-02T11:00:00Z");
  db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)").run("old-entry", "ana", "work", start, end, 3000, "UTC", "commit abc123", "original-start", "original-stop");
  db.prepare("INSERT INTO billing_requests VALUES(?,?,?,?,?,?,?)").run("ana", "BR", "2026-10-02", "2026-10-02", JSON.stringify({ number: "NF-OLD", url: "https://private.example.test/old.pdf", currency: "USD", amount_cents: 6000, period_start: "2026-10-02", period_end: "2026-10-02" }), JSON.stringify({ method: "pix", beneficiary: "Ana", key: "private-old-key" }), null);
  db.close();
  let ledger = new HoursLedger(root);
  try {
    ledger.bindInstallation("line-original", "owner-original");
    assert.throws(() => ledger.bindInstallation("line-other", "owner-original"), /different Plow owner or line/);
    assert.throws(() => ledger.bindInstallation("line-original", "owner-other"), /different Plow owner or line/);
    const report = ledger.report("ana")[0]!;
    assert.equal(report.total_hours, 2); assert.equal(report.entries[0]?.rate_cents, 3000); assert.equal(report.entries[0]?.start_message, "original-start");
    assert.equal(ledger.billingReport("ana").invoice?.number, "NF-OLD");
    assert.deepEqual(ledger.billingReport("ana").payment, { method: "pix", beneficiary: "Ana", key: "private-old-key" });
    ledger.close(); ledger = new HoursLedger(root);
    ledger.bindInstallation("line-original", "owner-original");
    assert.equal(ledger.report("ana")[0]?.entries.length, 1);
    assert.equal(ledger.billingReport("ana").payment?.method, "pix");
    assert.equal((await stat(join(root, "hours.sqlite"))).mode & 0o777, 0o600);
  } finally { ledger.close(); }
});

test("encrypted live backup restores open clocks, pending delivery and owner binding without duplicating hours", async t => {
  const root = await mkdtemp(join(tmpdir(), "hours-backup-"));
  t.after(() => rm(root, { recursive: true }));
  const live = join(root, "live"), ledger = new HoursLedger(live);
  t.after(() => ledger.close());
  ledger.bindInstallation("line", "owner");
  ledger.manage({ action: "contractor", id: "ana", name: "Ana", handle: "ana@example.test", chat_uid: "cht_ana", timezone: "UTC", rate_cents: 3000 }, "profile");
  ledger.manage({ action: "demand", contractor_id: "ana", id: "work", project: "Website", summary: "Landing" }, "demand");
  const start = { line_uid: "line", chat_uid: "cht_ana", handle: "ana@example.test", message_uid: "start", created_at: "2026-10-02T09:00:00Z", body: "Starting now" };
  const stop = { ...start, message_uid: "stop", created_at: "2026-10-02T11:00:00Z", body: "Finished now" };
  ledger.clock(start, { kind: "start", detail: "work" }); ledger.clockAttempt(stop);
  const directory = join(root, "encrypted"), keyPath = join(root, "keys", "backup.key");
  const file = await createBackup({ database: join(live, "hours.sqlite"), directory, keyPath });
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file)).includes(Buffer.from("ana@example.test")));
  const restoredDir = join(root, "restored");
  await restoreBackup({ file, keyPath, directory: restoredDir });
  const restored = new HoursLedger(restoredDir);
  try {
    restored.bindInstallation("line", "owner");
    assert.throws(() => restored.bindInstallation("line", "other-owner"));
    assert.equal(restored.pendingClockMessages("line", "cht_ana").length, 1);
    restored.clock(stop, { kind: "stop", detail: "commit abc" }); restored.clock(stop, { kind: "stop", detail: "duplicate" });
    restored.completeClockMessage("line", "cht_ana", "stop");
    assert.equal(restored.report("ana")[0]?.total_hours, 2); assert.equal(restored.report("ana")[0]?.entries.length, 1);
    assert.deepEqual(restored.pendingClockMessages("line", "cht_ana"), []);
    const restoredDb = new DatabaseSync(join(restoredDir, "hours.sqlite"), { readOnly: true });
    try { assert.equal(JSON.parse(String(restoredDb.prepare("SELECT source_json FROM clock_inbox WHERE source LIKE '%stop%'").get()?.source_json)).body, ""); }
    finally { restoredDb.close(); }
  } finally { restored.close(); }
  await assert.rejects(() => restoreBackup({ file, keyPath, directory: restoredDir }), /new, empty/);
  const corrupt = join(root, "corrupt.enc"), content = await readFile(file); content[content.length - 1] ^= 1; await writeFile(corrupt, content);
  const failedDir = join(root, "failed");
  await assert.rejects(() => restoreBackup({ file: corrupt, keyPath, directory: failedDir }));
  assert.deepEqual(await readdir(failedDir), []);
  for (let i = 0; i < 8; i++) await createBackup({ database: join(live, "hours.sqlite"), directory, keyPath });
  assert.equal((await readdir(directory)).filter(name => name.endsWith(".enc")).length, 7);
  assert.ok((await readdir(directory)).every(name => !name.endsWith(".sqlite")), "temporary plaintext backups are removed");
});
