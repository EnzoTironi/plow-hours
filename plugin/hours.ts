import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { billingActions, billingReportSchema, billingRequestSchema, HoursBilling, selfSchema } from "./hours-billing.ts";
import { entrySchema, needsReview, workText } from "./hours-period.ts";

export const hoursEnabled = () => process.env.PLOW_HOURS === "1";
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(2000);
const timestamp = z.iso.datetime({ offset: true });
export const clockSourceSchema = z.object({ line_uid: z.string().min(1), chat_uid: z.string().min(1),
  handle: z.string().min(1), message_uid: z.string().min(1), created_at: timestamp, body: z.string() }).strict();
type ClockSource = z.infer<typeof clockSourceSchema>;
type StartIntent = { kind: "start"; detail: string; description?: string; project?: string } | { kind: "confirm_start"; detail: string; description?: string; project?: string }
  | { kind: "clarify_start" } | { kind: "cancel_start" };
export type ClockIntent = NonNullable<ReturnType<typeof clockCommand>> | StartIntent | { kind: "switch"; detail: string; details: string }
  | { kind: "note"; detail: string; project?: string };
const contractorSchema = z.object({
  id, name: text, handle: text, chat_uid: text, timezone: text,
  rate_cents: z.number().int().min(0).max(100_000_000),
  revision: z.number().int(), sheet_id: z.string().nullable(),
  sheet_revision: z.number().int(), wiki_revision: z.number().int(),
  active: z.number().int().min(0).max(1),
});
const demandSchema = z.object({ id, contractor_id: id, project: text, summary: text, references: z.string(), active: z.number(), reported: z.number().int().min(0).max(1) });
const receiptSchema = z.object({ response: z.string() });
type Contractor = z.infer<typeof contractorSchema>;
type Entry = z.infer<typeof entrySchema>;

export const managementSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("contractor"), id, name: text, handle: text, chat_uid: text, timezone: text, rate_cents: z.number().int().min(0).max(100_000_000) }).strict(),
  z.object({ action: z.literal("demand"), id, contractor_id: id, project: text, summary: text, references: z.string().max(4000).default("") }).strict(),
  z.object({ action: z.literal("correct"), entry_id: text, start: timestamp, finish: timestamp, reason: text, demand_id: id.optional() }).strict(),
  z.object({ action: z.literal("void"), entry_id: text, reason: text }).strict(),
  z.object({ action: z.literal("review_entry"), entry_id: text, reason: text }).strict(),
  z.object({ action: z.literal("resolve_clock"), contractor_id: id, reason: text }).strict(),
  z.object({ action: z.literal("deactivate"), contractor_id: id, reason: text }).strict(),
  z.object({ action: z.literal("archive_demand"), contractor_id: id, demand_id: id, reason: text }).strict(),
  z.object({ action: z.literal("manual"), contractor_id: id, demand_id: id, start: timestamp, finish: timestamp,
    rate_cents: z.number().int().min(0).max(100_000_000), reason: text, details: z.string().max(4000).default("") }).strict(),
  z.object({ action: z.literal("report"), contractor_id: id.optional() }).strict(),
  z.object({ action: z.literal("link_sheet"), contractor_id: id, sheet_id: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/) }).strict(),
  z.object({ action: z.literal("projected"), contractor_id: id, target: z.enum(["sheet", "wiki"]),
    sheet_id: z.string().optional(), revision: z.number().int().min(1) }).strict(),
  billingRequestSchema,
  billingReportSchema,
  ...billingActions,
]);
export type Management = z.infer<typeof managementSchema>;

export function normalizeHandle(handle: string): string {
  const compact = handle.trim().replace(/[\s().-]/g, "");
  return /^\+\d{10,15}$/.test(compact) ? compact : handle.trim().toLowerCase();
}

export function clockCommand(body: string) {
  const match = body.trim().match(/^(comecei|start|\/in|parei|stop|\/out|ponto|\/hours)(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  const verb = match[1]?.toLowerCase();
  const detail = (match[2] ?? "").trim();
  if (verb === "comecei" || verb === "start" || verb === "/in") return { kind: "start", detail } as const;
  if (verb === "parei" || verb === "stop" || verb === "/out") return { kind: "stop", detail } as const;
  return { kind: "status", detail } as const;
}

export function localTime(ms: number, timezone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset",
  }).format(ms).replace("−", "-");
}
const hours = (ms: number) => Math.round(ms / 3_600_000 * 1_000_000) / 1_000_000;
const sheetText = (value: string) => /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
const markdownText = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_\[\]<>#|]/g, "\\$&");
function workRecord(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return workText(value, secrets);
  if (Array.isArray(value)) return value.map(item => workRecord(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workRecord(item, secrets)]));
  return value;
}
export const SHEET_HEADERS = ["Day", "Start", "Finish", "Total (Hours)", "Rate (USD)", "Project", "Details (github ticket, git commit, etc)"];

export class HoursLedger {
  private readonly db: DatabaseSync;
  private readonly billing: HoursBilling;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "hours.sqlite");
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contractors (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, chat_uid TEXT NOT NULL,
        timezone TEXT NOT NULL, rate_cents INTEGER NOT NULL CHECK(rate_cents >= 0), revision INTEGER NOT NULL DEFAULT 1,
        sheet_id TEXT, sheet_revision INTEGER NOT NULL DEFAULT 0, wiki_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS demands (
        id TEXT NOT NULL, contractor_id TEXT NOT NULL REFERENCES contractors(id),
        project TEXT NOT NULL, summary TEXT NOT NULL, "references" TEXT NOT NULL,
        PRIMARY KEY(contractor_id, id)
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), demand_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL, end_ms INTEGER CHECK(end_ms IS NULL OR end_ms > start_ms),
        rate_cents INTEGER NOT NULL CHECK(rate_cents >= 0), timezone TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
        start_message TEXT NOT NULL, stop_message TEXT,
        FOREIGN KEY(contractor_id, demand_id) REFERENCES demands(contractor_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_entry ON entries(contractor_id) WHERE end_ms IS NULL;
      CREATE TABLE IF NOT EXISTS receipts (source TEXT PRIMARY KEY, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_notices (
        source TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id),
        delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS pending_starts (
        contractor_id TEXT PRIMARY KEY REFERENCES contractors(id), source_json TEXT NOT NULL,
        rate_cents INTEGER NOT NULL, timezone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clock_inbox (
        source TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id),
        line_uid TEXT NOT NULL, chat_uid TEXT NOT NULL, source_json TEXT NOT NULL,
        rate_cents INTEGER NOT NULL, timezone TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, source TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), line_uid TEXT NOT NULL, owner_uid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unmatched_stops (source TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), source_json TEXT NOT NULL, details TEXT NOT NULL);
    `);
    this.transaction(() => {
      for (const [table, column] of [["entries", "voided"], ["entries", "reviewed"], ["contractors", "active"], ["demands", "active"], ["demands", "reported"]] as const) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column))
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${column === "active" ? 1 : 0} CHECK(${column} IN (0,1))`);
      }
      if (!this.db.prepare("PRAGMA table_info(clock_inbox)").all().some(row => row.name === "review_reason"))
        this.db.exec("ALTER TABLE clock_inbox ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''");
      this.db.exec("DROP INDEX IF EXISTS one_open_entry; CREATE UNIQUE INDEX one_open_entry ON entries(contractor_id) WHERE end_ms IS NULL AND voided=0;");
      this.db.exec("UPDATE clock_inbox SET source_json=json_set(source_json, '$.body', '') WHERE complete=1;");
    });
    this.billing = new HoursBilling(this.db);
  }

  close() { this.db.close(); }

  bindInstallation(lineUid: string, ownerUid: string) {
    text.parse(lineUid); text.parse(ownerUid);
    this.transaction(() => {
      const current = this.db.prepare("SELECT line_uid, owner_uid FROM installation WHERE singleton=1").get();
      if (current && (current.line_uid !== lineUid || current.owner_uid !== ownerUid)) throw new Error("This hours volume belongs to a different Plow owner or line. Restore it with its original identity; use a new volume for another account.");
      this.db.prepare("INSERT INTO installation(singleton, line_uid, owner_uid) VALUES (1, ?, ?) ON CONFLICT DO NOTHING").run(lineUid, ownerUid);
    });
  }

  assertInstallationLine(lineUid: string) {
    const current = this.db.prepare("SELECT line_uid FROM installation WHERE singleton=1").get();
    if (!current || current.line_uid !== lineUid) throw new Error("This hours volume must boot with its authenticated Plow owner and line before accepting messages.");
  }

  groupContractor(chatUid: string) {
    const row = this.db.prepare("SELECT * FROM contractors WHERE chat_uid = ? AND active=1").get(chatUid);
    return row ? contractorSchema.parse(row) : undefined;
  }

  billingReport(contractorId: string) {
    this.contractor(contractorId);
    return this.billing.report(contractorId);
  }

  self(raw: unknown, contractorId: string, source: string) {
    const input = selfSchema.parse(raw);
    this.contractor(contractorId);
    if (input.action === "start" || input.action === "stop" || input.action === "clarify_start" || input.action === "confirm_start"
      || input.action === "cancel_start" || input.action === "switch" || input.action === "note") throw new Error("Clock actions require a verified inbound contractor message.");
    if (input.action === "report") {
      const report = this.report(contractorId)[0];
      if (!report) throw new Error("Contractor is not registered.");
      return { contractor: { id: report.contractor.id, name: report.contractor.name, timezone: report.contractor.timezone },
        demands: report.demands.filter(d => d.active && !d.reported), total_hours: report.total_hours,
        pending_start: this.pendingStart(contractorId)?.source.created_at ?? null,
        pending_clock: report.pending_clock,
        open_entry: report.open_entry ? { start_ms: report.open_entry.start_ms, details: report.open_entry.details } : null,
        clock_language: "Use start immediately for clear work beginning now, even without a task or description. details records the worker's own overview; project is optional and must come from context. Ask what they are working on after recording the start. Their answer and later activity changes use note, keeping that clock open. Assigned demands are optional context, never required or approved tasks. confirm_start is only for a legacy pending start. Never clock uncertain intent, plans, questions, negations or historical statements.",
        entries: report.entries.filter(e => !e.voided).map(({ demand_id, start_ms, end_ms, details }) => ({ demand_id, start_ms, end_ms, details })),
        review_needed: report.review_needed,
        billing: (() => { const { fingerprint, expected, ...status } = this.billingReport(contractorId); return status; })() };
    }
    return this.transaction(() => {
      const key = `member:${source}`;
      const old = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(key);
      if (old) return JSON.parse(receiptSchema.parse(old).response);
      const approved = this.billing.hasStoredApproval(contractorId);
      const result = this.billing.submit(contractorId, input);
      if (approved && !this.billing.hasStoredApproval(contractorId)) this.db.prepare("INSERT INTO owner_notices(source, contractor_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(key, contractorId);
      this.audit(source, input.action, undefined, { contractor_id: contractorId, action: input.action, received: true });
      this.db.prepare("INSERT INTO receipts(source, response) VALUES (?, ?)").run(key, JSON.stringify(result));
      return result;
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private contractor(contractorId: string): Contractor {
    const row = this.db.prepare("SELECT * FROM contractors WHERE id = ?").get(contractorId);
    if (!row) throw new Error("Contractor is not registered.");
    return contractorSchema.parse(row);
  }

  private open(contractorId: string): Entry | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE contractor_id = ? AND end_ms IS NULL AND voided=0").get(contractorId);
    return row ? entrySchema.parse(row) : undefined;
  }

  private bump(contractorId: string) {
    this.db.prepare("UPDATE contractors SET revision = revision + 1 WHERE id = ?").run(contractorId);
  }

  private audit(source: string, action: string, before: unknown, after: unknown) {
    this.db.prepare("INSERT INTO audit(source, action, before_json, after_json) VALUES (?, ?, ?, ?)")
      .run(source, action, before === undefined ? null : JSON.stringify(before), JSON.stringify(after));
  }

  private overlaps(contractorId: string, start: number, end: number | null, except: string) {
    return this.db.prepare(`SELECT id FROM entries WHERE contractor_id = ? AND id != ?
      AND voided=0 AND start_ms < ? AND (end_ms IS NULL OR end_ms > ?)`).get(contractorId, except, end ?? Number.MAX_SAFE_INTEGER, start);
  }

  private pendingStart(contractorId: string) {
    const row = this.db.prepare("SELECT source_json, rate_cents, timezone FROM pending_starts WHERE contractor_id = ?").get(contractorId);
    if (!row) return undefined;
    const pending = z.object({ source_json: z.string(), rate_cents: z.number().int(), timezone: z.string() }).parse(row);
    return { source: clockSourceSchema.parse(JSON.parse(pending.source_json)), rate_cents: pending.rate_cents, timezone: pending.timezone };
  }

  rememberClockMessage(input: ClockSource) {
    const contractor = this.groupContractor(input.chat_uid);
    if (!contractor || contractor.handle !== normalizeHandle(input.handle)) throw new Error("Unregistered clock source.");
    this.db.prepare(`INSERT INTO clock_inbox(source, contractor_id, line_uid, chat_uid, source_json, rate_cents, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]), contractor.id, input.line_uid, input.chat_uid,
        JSON.stringify({ ...input, body: workText(input.body, this.billing.secrets(contractor.id)) }), contractor.rate_cents, contractor.timezone);
  }

  clockAttempt(input: ClockSource): number {
    this.rememberClockMessage(input);
    return this.transaction(() => {
      const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
      const row = this.db.prepare("UPDATE clock_inbox SET attempts = attempts + 1 WHERE source = ? RETURNING attempts").get(source);
      return z.object({ attempts: z.number().int().positive() }).parse(row).attempts;
    });
  }

  completeClockMessage(lineUid: string, chatUid: string, messageUid: string) {
    this.db.prepare("UPDATE clock_inbox SET complete = 1, source_json=json_set(source_json, '$.body', '') WHERE source = ?").run(JSON.stringify([lineUid, chatUid, messageUid]));
  }

  isPendingClockMessage(lineUid: string, chatUid: string, messageUid: string): boolean {
    return Boolean(this.db.prepare("SELECT source FROM clock_inbox WHERE source = ? AND complete = 0")
      .get(JSON.stringify([lineUid, chatUid, messageUid])));
  }

  pendingClockMessages(lineUid: string, chatUid: string): ClockSource[] {
    return this.db.prepare("SELECT source_json FROM clock_inbox WHERE line_uid = ? AND chat_uid = ? AND complete = 0")
      .all(lineUid, chatUid).map(row => clockSourceSchema.parse(JSON.parse(z.object({ source_json: z.string() }).parse(row).source_json)));
  }

  private recordedClockSource(input: ClockSource) {
    const row = this.db.prepare("SELECT source_json, rate_cents, timezone FROM clock_inbox WHERE source = ?")
      .get(JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]));
    if (!row) return undefined;
    const recorded = z.object({ source_json: z.string(), rate_cents: z.number().int(), timezone: z.string() }).parse(row);
    return { source: clockSourceSchema.parse(JSON.parse(recorded.source_json)), rate_cents: recorded.rate_cents, timezone: recorded.timezone };
  }

  private startClock(contractor: Contractor, input: ClockSource, command: StartIntent): string {
    const pending = this.pendingStart(contractor.id);
    const original = this.recordedClockSource(input) ?? { source: input, rate_cents: contractor.rate_cents, timezone: contractor.timezone };
    const origin = command.kind === "confirm_start" && pending ? pending : original;
    const ms = Date.parse(origin.source.created_at);
    const active = this.open(contractor.id);
    if (active) return ms < active.start_ms && command.kind !== "cancel_start"
      ? this.clockConflict(contractor, origin.source, "Este início chegou atrasado e vem antes do ponto que está aberto.")
      : `Seu ponto já está aberto desde ${localTime(active.start_ms, active.timezone)}. Se mudou de atividade, posso acrescentar uma anotação.`;
    if (command.kind === "cancel_start") {
      this.db.prepare("DELETE FROM pending_starts WHERE contractor_id = ?").run(contractor.id);
      return "Início pendente cancelado. Nenhuma hora foi registrada.";
    }
    if (command.kind === "clarify_start") {
      if (!pending) this.db.prepare("INSERT INTO pending_starts(contractor_id, source_json, rate_cents, timezone) VALUES (?, ?, ?, ?)")
        .run(contractor.id, JSON.stringify(original.source), original.rate_cents, original.timezone);
      const start = pending?.source.created_at ?? original.source.created_at;
      return `Recebi seu início às ${localTime(Date.parse(start), pending?.timezone ?? original.timezone)}. Qual demanda você está fazendo? Vou manter esse horário quando você confirmar.`;
    }
    if (command.kind === "confirm_start" && (!pending || pending.source.line_uid !== input.line_uid
      || pending.source.chat_uid !== input.chat_uid || normalizeHandle(pending.source.handle) !== normalizeHandle(input.handle))) {
      return "Não há um início pendente desta conversa para confirmar. Me diga quando começar uma demanda.";
    }
    if (ms > Date.parse(input.created_at)) return this.clockConflict(contractor, input, "A confirmação veio antes do início pendente.");
    const source = JSON.stringify([origin.source.line_uid, origin.source.chat_uid, origin.source.message_uid]);
    const assigned = this.db.prepare("SELECT * FROM demands WHERE id = ? AND contractor_id = ? AND active=1 AND reported=0").get(command.detail, contractor.id);
    const description = workText(command.description ?? (assigned ? "" : command.detail), this.billing.secrets(contractor.id));
    const demand = assigned ? demandSchema.parse(assigned) : {
      id: `activity_${createHash("sha256").update(source).digest("hex").slice(0,24)}`, contractor_id: contractor.id,
      project: workText(command.project ?? "Uncategorized", this.billing.secrets(contractor.id)),
      summary: description.slice(0,2000) || "Work in progress", references: "", active: 1, reported: 1,
    };
    const waiting = this.db.prepare("SELECT source, source_json, details FROM unmatched_stops WHERE contractor_id=?").all(contractor.id)
      .map(row => z.object({ source: text, source_json: z.string(), details: z.string() }).parse(row))
      .map(row => ({ ...row, message: clockSourceSchema.parse(JSON.parse(row.source_json)) }))
      .filter(row => row.message.line_uid === input.line_uid && row.message.chat_uid === input.chat_uid && Date.parse(row.message.created_at) > ms)
      .sort((a, b) => Date.parse(a.message.created_at) - Date.parse(b.message.created_at))[0];
    const finish = waiting ? Date.parse(waiting.message.created_at) : null;
    if (this.overlaps(contractor.id, ms, finish, source)) return this.clockConflict(contractor, origin.source, "Esse horário cruza um ponto existente.");
    if (this.billing.isLocked(contractor.id, ms, finish)) return this.clockConflict(contractor, origin.source, "Este início chegou depois do fechamento do período.");
    this.billing.assertUnlocked(contractor.id, ms, finish);
    if (!assigned) this.db.prepare('INSERT INTO demands(id, contractor_id, project, summary, "references", reported) VALUES (?, ?, ?, ?, ?, 1)')
      .run(demand.id, contractor.id, demand.project, demand.summary, "");
    const entryId = `hours_${createHash("sha256").update(source).digest("hex").slice(0,24)}`;
    this.db.prepare("INSERT INTO entries(id, contractor_id, demand_id, start_ms, rate_cents, timezone, start_message, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entryId, contractor.id, demand.id, ms, origin.rate_cents, origin.timezone, source, description);
    this.db.prepare("DELETE FROM pending_starts WHERE contractor_id = ?").run(contractor.id);
    this.bump(contractor.id);
    this.audit(source, "start", undefined, { contractor_id: contractor.id, demand_id: demand.id, start_ms: ms, details: description, project: demand.project });
    let response = `Ponto iniciado às ${localTime(ms, origin.timezone)}.${description ? ` Trabalho: ${description}.` : ""}`;
    if (waiting && finish !== null) {
      const stop = this.finishClock(entrySchema.parse(this.db.prepare("SELECT * FROM entries WHERE id=?").get(entryId)), finish, waiting.details, waiting.source);
      this.db.prepare("UPDATE receipts SET response=? WHERE source=?").run(stop, waiting.source);
      this.db.prepare("DELETE FROM unmatched_stops WHERE source=?").run(waiting.source);
      response += ` O encerramento que chegou antes também foi recuperado: ${stop}`;
    }
    if (command.kind === "confirm_start") this.db.prepare("UPDATE receipts SET response = ? WHERE source = ?").run(response, source);
    return response;
  }

  private clockConflict(contractor: Contractor, input: ClockSource, reason: string) {
    this.rememberClockMessage(input);
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason=?, source_json=json_set(source_json, '$.body', '') WHERE source=?").run(reason, source);
    this.billing.invalidateApproval(contractor.id);
    this.bump(contractor.id);
    this.audit(source, "clock_review", undefined, { contractor_id: contractor.id, created_at: input.created_at, reason });
    return `${reason} Guardei a mensagem com seu horário original para o dono revisar. O registro de horas foi preservado; a cobrança aguarda essa revisão.`;
  }

  private finishClock(active: Entry, ms: number, details: string, source: string) {
    this.billing.assertUnlocked(active.contractor_id, active.start_ms, ms);
    const clean = workText([active.details, details].filter(Boolean).join("\n"), this.billing.secrets(active.contractor_id));
    this.db.prepare("UPDATE entries SET end_ms=?, details=?, stop_message=? WHERE id=?").run(ms, clean, source, active.id);
    this.bump(active.contractor_id);
    this.audit(source, "stop", active, { ...active, end_ms: ms, details: clean, stop_message: source });
    return `Ponto encerrado às ${localTime(ms, active.timezone)}. ${hours(ms - active.start_ms)} h registradas.${ms - active.start_ms > 12 * 3_600_000 ? " Esse bloco passou de 12 horas e precisa da revisão do dono antes do fechamento." : ""}`;
  }

  clockReceipt(input: ClockSource): string | undefined {
    const contractor = this.groupContractor(input.chat_uid);
    if (!contractor || contractor.handle !== normalizeHandle(input.handle)) return undefined;
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    const receipt = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(source);
    return receipt ? receiptSchema.parse(receipt).response : undefined;
  }

  pendingOwnerNotices() {
    return this.db.prepare("SELECT source, name FROM owner_notices JOIN contractors ON contractors.id=owner_notices.contractor_id WHERE delivered=0 ORDER BY owner_notices.rowid")
      .all().map(row => z.object({ source: text, name: text }).parse(row));
  }

  completeOwnerNotice(source: string) {
    this.db.prepare("UPDATE owner_notices SET delivered=1 WHERE source=?").run(source);
  }

  clock(input: ClockSource, intent?: ClockIntent): string | undefined {
    const command = intent ?? clockCommand(input.body);
    if (!command) return undefined;
    const bound = this.db.prepare("SELECT line_uid FROM installation WHERE singleton=1").get();
    if (bound && bound.line_uid !== input.line_uid) return undefined;
    // A registration is a narrow grant for this sender in this thread, independent of room trust.
    const row = this.db.prepare("SELECT * FROM contractors WHERE handle = ? AND chat_uid = ?")
      .get(normalizeHandle(input.handle), input.chat_uid);
    if (!row) return undefined;
    const contractor = contractorSchema.parse(row);
    if (!contractor.active) return undefined;
    input = this.recordedClockSource(input)?.source ?? clockSourceSchema.parse(input);
    const ms = Date.parse(input.created_at);
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    return this.transaction(() => {
      const receipt = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(source);
      if (receipt) return receiptSchema.parse(receipt).response;
      let response: string;
      const active = this.open(contractor.id);
      if (command.kind === "status") {
        response = active ? `Ponto aberto desde ${localTime(active.start_ms, active.timezone)}.${active.details ? ` Trabalho: ${active.details}` : ""}`
          : "Nenhum ponto aberto. Me diga quando começar e em qual tarefa.";
      } else if (command.kind === "note") {
        if (!active) response = "Não há um ponto aberto para anotar esse trabalho. Me diga quando começar.";
        else {
          const details = workText([active.details, command.detail].filter(Boolean).join("\n"), this.billing.secrets(contractor.id));
          const demand = demandSchema.parse(this.db.prepare("SELECT * FROM demands WHERE contractor_id=? AND id=?").get(contractor.id, active.demand_id));
          const project = demand.reported && demand.project === "Uncategorized" && command.project
            ? workText(command.project, this.billing.secrets(contractor.id)) : demand.project;
          if (demand.reported) this.db.prepare("UPDATE demands SET summary=?, project=? WHERE contractor_id=? AND id=?")
            .run(active.details ? demand.summary : workText(command.detail, this.billing.secrets(contractor.id)).slice(0,2000),
              project, contractor.id, active.demand_id);
          this.db.prepare("UPDATE entries SET details=? WHERE id=?").run(details, active.id);
          this.bump(contractor.id);
          this.audit(source, "note", active, { ...active, details, project });
          response = "Anotação registrada. Seu ponto continua aberto com o mesmo horário inicial.";
        }
      } else if (command.kind === "switch") {
        if (!active) response = "Não há um ponto aberto para trocar. Me diga quando começar a nova tarefa.";
        else if (active.demand_id === command.detail) response = "Você já está trabalhando nessa tarefa; mantive o horário inicial.";
        else if (ms <= active.start_ms || !this.db.prepare("SELECT id FROM demands WHERE contractor_id=? AND id=? AND active=1").get(contractor.id, command.detail)) response = "Não consegui trocar: confira a tarefa e o horário com o dono. O ponto anterior continua aberto.";
        else {
          const stopped = this.finishClock(active, ms, command.details, source);
          const started = this.startClock(contractor, input, { kind: "start", detail: command.detail });
          if (!started.startsWith("Ponto iniciado")) throw new Error("Could not start the new task; the whole switch was rolled back.");
          response = `${stopped} ${started}`;
        }
      } else if (command.kind !== "stop") {
        response = this.startClock(contractor, input, command);
      } else if (!active) {
        this.db.prepare("INSERT INTO unmatched_stops(source, contractor_id, source_json, details) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(source, contractor.id, JSON.stringify({ ...input, body: "" }), workText(command.detail, this.billing.secrets(contractor.id)));
        this.billing.invalidateApproval(contractor.id);
        response = "Você não tem ponto aberto. Guardei este encerramento com seu horário original para recuperar um início atrasado. O dono pode revisar se faltou o início.";
      }
      else if (ms <= active.start_ms || this.overlaps(contractor.id, active.start_ms, ms, active.id)) {
        response = this.clockConflict(contractor, input, "Esse encerramento cruza outro ponto ou vem antes do início.");
      } else if (command.detail.length > 4000) response = "Envie os detalhes em até 4.000 caracteres.";
      else {
        response = this.finishClock(active, ms, command.detail, source);
      }
      this.db.prepare("INSERT INTO receipts(source, response) VALUES (?, ?)").run(source, response);
      return response;
    });
  }

  manage(raw: unknown, source: string) {
    const input = managementSchema.parse(raw);
    if (input.action === "report") return this.report(input.contractor_id);
    if (input.action === "billing_report") return this.billingReport(input.contractor_id);
    return this.transaction(() => {
      const receiptKey = `owner:${source}`;
      const receipt = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(receiptKey);
      if (receipt) {
        if (input.action === "approve_billing") return this.billingReport(input.contractor_id);
        const response: unknown = JSON.parse(receiptSchema.parse(receipt).response);
        return response;
      }
      const apply = () => { switch (input.action) {
        case "billing_request": {
          this.contractor(input.contractor_id);
          const result = this.billing.request(input);
          this.audit(source, input.action, undefined, input);
          return { ...result, chat_uid: this.contractor(input.contractor_id).chat_uid };
        }
        case "close_period": {
          this.contractor(input.contractor_id);
          const result = this.billing.closePeriod(input);
          this.audit(source, input.action, undefined, { contractor_id: input.contractor_id, expected: result.expected, fingerprint: result.fingerprint });
          return result;
        }
        case "reopen_period": {
          const before = this.billingReport(input.contractor_id);
          const result = this.billing.reopenPeriod(input.contractor_id);
          this.audit(source, input.action, { closed: before.closed, fingerprint: before.fingerprint }, input);
          return result;
        }
        case "approve_billing": {
          const result = this.billing.approve(input.contractor_id, input.fingerprint, source);
          this.audit(source, input.action, undefined, { ...input, approved: true, paid: false });
          return result;
        }
        case "resolve_clock": {
          const before = { pending_start: this.pendingStart(input.contractor_id),
            stops: this.db.prepare("SELECT source, source_json FROM unmatched_stops WHERE contractor_id=?").all(input.contractor_id),
            inbox: this.pendingClockMessagesForContractor(input.contractor_id) };
          this.contractor(input.contractor_id);
          const sources = [...before.inbox.map(row => String(row.source)), ...before.stops.map(row => String(row.source))];
          if (before.pending_start) sources.push(JSON.stringify([before.pending_start.source.line_uid, before.pending_start.source.chat_uid, before.pending_start.source.message_uid]));
          for (const key of sources) this.db.prepare("INSERT INTO receipts(source, response) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET response=excluded.response")
            .run(key, "O dono revisou e encerrou esta pendência; nenhuma hora foi acrescentada por esta mensagem.");
          this.db.prepare("DELETE FROM pending_starts WHERE contractor_id=?").run(input.contractor_id);
          this.db.prepare("DELETE FROM unmatched_stops WHERE contractor_id=?").run(input.contractor_id);
          this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason='', source_json=json_set(source_json, '$.body', '') WHERE contractor_id=?").run(input.contractor_id);
          this.audit(source, input.action, before, input);
          return { resolved: true, contractor_id: input.contractor_id, reason: input.reason };
        }
        case "deactivate": {
          const before = this.contractor(input.contractor_id);
          if (this.open(before.id) || this.pendingStart(before.id) || this.pendingClockMessagesForContractor(before.id).length
            || this.db.prepare("SELECT source FROM unmatched_stops WHERE contractor_id=?").get(before.id)) throw new Error("Resolve open and pending clocks before deactivating this contractor.");
          this.db.prepare("UPDATE contractors SET active=0, revision=revision+1 WHERE id=?").run(before.id);
          this.audit(source, input.action, before, input);
          return { contractor_id: before.id, active: false };
        }
        case "archive_demand": {
          if (this.open(input.contractor_id)?.demand_id === input.demand_id) throw new Error("Stop or correct the open clock before archiving its demand.");
          const changed = this.db.prepare("UPDATE demands SET active=0 WHERE contractor_id=? AND id=? AND active=1").run(input.contractor_id, input.demand_id);
          if (!changed.changes) throw new Error("The demand is not active.");
          this.bump(input.contractor_id); this.audit(source, input.action, undefined, input);
          return { demand_id: input.demand_id, active: false };
        }
        case "contractor": {
          new Intl.DateTimeFormat("en", { timeZone: input.timezone });
          const handle = normalizeHandle(input.handle);
          if (!/^\+\d{10,15}$/.test(handle) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle)) throw new Error("Use an international phone number or an iMessage email handle.");
          const oldRow = this.db.prepare("SELECT * FROM contractors WHERE id = ?").get(input.id);
          const before = oldRow ? contractorSchema.parse(oldRow) : undefined;
          if (before && (before.handle !== handle || before.chat_uid !== input.chat_uid)) throw new Error("A contractor's sender and thread binding cannot be reassigned.");
          if (before?.active && before.name === input.name && before.timezone === input.timezone && before.rate_cents === input.rate_cents) return { contractor_id: input.id, registered: true };
          this.db.prepare(`INSERT INTO contractors(id, name, handle, chat_uid, timezone, rate_cents) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, timezone=excluded.timezone, rate_cents=excluded.rate_cents, active=1, revision=contractors.revision+1`)
            .run(input.id, input.name, handle, input.chat_uid, input.timezone, input.rate_cents);
          this.audit(source, input.action, before, this.contractor(input.id));
          return { contractor_id: input.id, registered: true };
        }
        case "demand": {
          this.contractor(input.contractor_id);
          const before = this.db.prepare("SELECT * FROM demands WHERE id = ? AND contractor_id = ?").get(input.id, input.contractor_id);
          if (before) {
            const existing = demandSchema.parse(before);
            if (existing.project === input.project && existing.summary === input.summary && existing.references === input.references) return { demand_id: input.id, registered: true };
            throw new Error("Demand already exists. Register a new demand to preserve past attribution.");
          }
          this.db.prepare('INSERT INTO demands(id, contractor_id, project, summary, "references") VALUES (?, ?, ?, ?, ?)')
            .run(input.id, input.contractor_id, input.project, input.summary, input.references);
          this.bump(input.contractor_id);
          this.audit(source, input.action, undefined, input);
          return { demand_id: input.id, registered: true };
        }
        case "correct": {
          const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(input.entry_id);
          if (!row) throw new Error("Time entry is not registered.");
          const before = entrySchema.parse(row);
          if (before.voided) throw new Error("A voided entry cannot be corrected. Record a new manual entry with a reason.");
          const start = Date.parse(input.start), finish = Date.parse(input.finish);
          if (finish <= start) throw new Error("Finish must be after start.");
          const demandId = input.demand_id ?? before.demand_id;
          if (!this.db.prepare("SELECT id FROM demands WHERE contractor_id=? AND id=?").get(before.contractor_id, demandId)) throw new Error("Demand is not assigned to this contractor.");
          this.billing.assertUnlocked(before.contractor_id, before.start_ms, before.end_ms);
          this.billing.assertUnlocked(before.contractor_id, start, finish);
          if (this.overlaps(before.contractor_id, start, finish, before.id)) throw new Error("Correction overlaps another time entry.");
          this.db.prepare("UPDATE entries SET start_ms = ?, end_ms = ?, demand_id=?, reviewed=0 WHERE id = ?").run(start, finish, demandId, before.id);
          this.bump(before.contractor_id);
          this.audit(source, input.action, before, { ...before, start_ms: start, end_ms: finish, demand_id: demandId, reviewed: 0, reason: input.reason });
          return { entry_id: before.id, corrected: true, reason: input.reason };
        }
        case "void":
        case "review_entry": {
          const row = this.db.prepare("SELECT * FROM entries WHERE id=?").get(input.entry_id);
          if (!row) throw new Error("Time entry is not registered.");
          const before = entrySchema.parse(row);
          if (before.voided) throw new Error("This entry has already been voided.");
          this.billing.assertUnlocked(before.contractor_id, before.start_ms, before.end_ms);
          if (input.action === "review_entry" && before.end_ms === null) throw new Error("Close or correct this session before reviewing it.");
          const column = input.action === "void" ? "voided" : "reviewed";
          this.db.prepare(`UPDATE entries SET ${column}=1 WHERE id=?`).run(before.id);
          this.bump(before.contractor_id);
          this.audit(source, input.action, before, { contractor_id: before.contractor_id, entry_id: before.id, reason: input.reason, [column]: 1 });
          if (input.action === "void") this.db.prepare("UPDATE receipts SET response='Esse registro foi anulado pelo dono; não conta nas horas.' WHERE source IN (?, ?)").run(before.start_message, before.stop_message);
          return { entry_id: before.id, [column]: true, reason: input.reason };
        }
        case "manual": {
          const contractor = this.contractor(input.contractor_id);
          if (!this.db.prepare("SELECT id FROM demands WHERE id = ? AND contractor_id = ?").get(input.demand_id, contractor.id)) throw new Error("Demand is not assigned to this contractor.");
          const start = Date.parse(input.start), finish = Date.parse(input.finish);
          const entryId = `hours_${createHash("sha256").update(receiptKey).digest("hex").slice(0,24)}`;
          if (finish <= start) throw new Error("Finish must be after start.");
          this.billing.assertUnlocked(contractor.id, start, finish);
          if (this.overlaps(contractor.id, start, finish, entryId)) throw new Error("Manual entry overlaps another time entry.");
          this.db.prepare("INSERT INTO entries(id, contractor_id, demand_id, start_ms, end_ms, rate_cents, timezone, details, start_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(entryId, contractor.id, input.demand_id, start, finish, input.rate_cents, contractor.timezone, workText(input.details, this.billing.secrets(contractor.id)), receiptKey);
          this.bump(contractor.id);
          this.audit(source, input.action, undefined, { ...input, entry_id: entryId });
          return { entry_id: entryId, recorded: true };
        }
        case "link_sheet": {
          const contractor = this.contractor(input.contractor_id);
          if (contractor.sheet_id === input.sheet_id) return { linked: true };
          const duplicate = this.db.prepare("SELECT id FROM contractors WHERE sheet_id = ? AND id != ?").get(input.sheet_id, input.contractor_id);
          if (duplicate) throw new Error("Use a separate spreadsheet for each contractor.");
          this.db.prepare("UPDATE contractors SET sheet_id = ?, sheet_revision = 0 WHERE id = ?").run(input.sheet_id, input.contractor_id);
          this.audit(source, input.action, undefined, input);
          return { linked: true };
        }
        case "projected": {
          const contractor = this.contractor(input.contractor_id);
          if (input.revision > contractor.revision) throw new Error("Projection revision is newer than the ledger.");
          if (input.target === "sheet" && (!contractor.sheet_id || input.sheet_id !== contractor.sheet_id)) throw new Error("Projection must confirm the current spreadsheet id.");
          // Record only the exported revision. A clock arriving during sync stays pending.
          const column = input.target === "sheet" ? "sheet_revision" : "wiki_revision";
          this.db.prepare(`UPDATE contractors SET ${column} = MAX(${column}, ?) WHERE id = ?`).run(input.revision, input.contractor_id);
          this.audit(source, input.action, undefined, input);
          return { target: input.target, pending: input.revision < contractor.revision };
        }
        default: {
          const exhaustive: never = input;
          return exhaustive;
        }
      } };
      const result = apply();
      this.db.prepare("INSERT INTO receipts(source, response) VALUES (?, ?)").run(receiptKey, JSON.stringify(result));
      return result;
    });
  }

  report(contractorId?: string) {
    return this.transaction(() => this.reportSnapshot(contractorId));
  }

  private pendingClockMessagesForContractor(contractorId: string) {
    return this.db.prepare("SELECT source, review_reason FROM clock_inbox WHERE contractor_id=? AND (complete=0 OR review_reason!='')").all(contractorId);
  }

  private reportSnapshot(contractorId?: string) {
    const contractors = contractorId ? [this.contractor(contractorId)]
      : this.db.prepare("SELECT * FROM contractors ORDER BY id").all().map(row => contractorSchema.parse(row));
    return contractors.map(contractor => {
      const secrets = this.billing.secrets(contractor.id, true);
      const demands = this.db.prepare("SELECT * FROM demands WHERE contractor_id = ? ORDER BY id").all(contractor.id).map(row => demandSchema.parse(row))
        .map(d => ({ ...d, project: workText(d.project, secrets), summary: workText(d.summary, secrets), references: workText(d.references, secrets) }));
      const entries = this.db.prepare("SELECT * FROM entries WHERE contractor_id = ? ORDER BY start_ms, id").all(contractor.id).map(row => entrySchema.parse(row))
        .map(e => ({ ...e, details: workText(e.details, secrets) }));
      const rows: (string | number)[][] = [SHEET_HEADERS];
      let duration = 0;
      for (const entry of entries) {
        if (entry.end_ms === null || entry.voided) continue;
        const demand = demands.find(item => item.id === entry.demand_id);
        if (!demand) throw new Error("Time entry has no demand.");
        duration += entry.end_ms - entry.start_ms;
        const start = localTime(entry.start_ms, entry.timezone);
        rows.push([
          start.slice(0, 10), start, localTime(entry.end_ms, entry.timezone), hours(entry.end_ms - entry.start_ms),
          entry.rate_cents / 100, sheetText(demand.project),
          sheetText([demand.reported ? "" : demand.id, demand.reported ? "" : demand.summary, demand.references, entry.details].filter(Boolean).join(" | ")),
        ]);
      }
      const tsv = rows.map(row => row.map(cell => String(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
      const active = entries.find(entry => entry.end_ms === null && !entry.voided);
      const wiki = [
        `# ${markdownText(contractor.name)}`, "", `Contractor ID: ${contractor.id}`,
        `Timezone: ${contractor.timezone}`, `Current rate: USD ${(contractor.rate_cents / 100).toFixed(2)}/h`,
        `Recorded hours: ${hours(duration)}`, `Open time entry: ${active ? active.id : "none"}`, `Revision: ${contractor.revision}`,
        "", "## Demands", "", ...demands.map(d => `- ${d.id}: ${markdownText(d.project)}. ${markdownText(d.summary)}. ${markdownText(d.references)}`),
        "", "## Time entries", "", ...entries.map(e => `- ${markdownText(e.id)}: ${localTime(e.start_ms, e.timezone)} to ${e.voided ? "voided, excluded from totals" : e.end_ms === null ? "open, excluded from totals" : localTime(e.end_ms, e.timezone)}; ${e.demand_id}; ${markdownText(e.details)}`),
        "", "Generated from the hours ledger. Closed entries only count toward totals. No payment has been sent.",
      ].join("\n");
      return {
        contractor, demands, entries, total_hours: hours(duration), open_entry: active ?? null,
        review_needed: entries.filter(needsReview).map(e => e.id),
        pending_clock: { start: this.pendingStart(contractor.id)?.source.created_at ?? null, timezone: this.pendingStart(contractor.id)?.timezone ?? null, unmatched_stops: Number(this.db.prepare("SELECT COUNT(*) AS count FROM unmatched_stops WHERE contractor_id=?").get(contractor.id)?.count ?? 0), messages: this.pendingClockMessagesForContractor(contractor.id).length,
          reviews: this.db.prepare("SELECT source, json_extract(source_json, '$.created_at') AS created_at, review_reason FROM clock_inbox WHERE contractor_id=? AND review_reason!='' ORDER BY created_at").all(contractor.id) },
        audit: this.db.prepare("SELECT * FROM audit WHERE COALESCE(json_extract(after_json, '$.contractor_id'), json_extract(after_json, '$.id')) = ? ORDER BY seq").all(contractor.id)
          .map(row => ({ ...row, before_json: row.before_json === null ? null : JSON.stringify(workRecord(JSON.parse(String(row.before_json)), secrets)), after_json: JSON.stringify(workRecord(JSON.parse(String(row.after_json)), secrets)) })),
        revision: contractor.revision,
        sheet: { url: contractor.sheet_id ? `https://docs.google.com/spreadsheets/d/${contractor.sheet_id}/edit` : null, tab: "Hours", range: "Hours!A1:G", values: rows, tsv, pending: contractor.sheet_revision < contractor.revision },
        wiki: { relative_path: `_raw/contractor-hours/${contractor.id}.md`, markdown: wiki, pending: contractor.wiki_revision < contractor.revision },
      };
    });
  }
}

let ledger: { directory: string; instance: HoursLedger } | undefined;
export function hoursLedger(): HoursLedger {
  const directory = join(process.env.OPENCLAW_STATE_DIR ?? "/var/lib/plow", "plow-hours");
  if (ledger?.directory !== directory) {
    ledger?.instance.close();
    ledger = { directory, instance: new HoursLedger(directory) };
  }
  return ledger.instance;
}
