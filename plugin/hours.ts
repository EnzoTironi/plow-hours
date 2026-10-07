import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { billingActions, billingReportSchema, billingRequestSchema, HoursBilling, selfSchema } from "./hours-billing.ts";
import { entrySchema, needsReview, periodBounds, periodValue } from "./hours-period.ts";

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
  rate_cents: z.number().int().min(0).max(100_000_000), language: z.enum(["en", "pt"]),
  revision: z.number().int(), sheet_id: z.string().nullable(),
  sheet_revision: z.number().int(), wiki_revision: z.number().int(),
  active: z.number().int().min(0).max(1),
});
const demandSchema = z.object({ id, contractor_id: id, project: text, summary: text, references: z.string(), active: z.number(), reported: z.number().int().min(0).max(1) });
const receiptSchema = z.object({ response: z.string() });
const ownerNoticeSchema = z.object({ source: text, name: text,
  kind: z.enum(["approval_revoked", "clock_review"]), body: z.string() });
type Contractor = z.infer<typeof contractorSchema>;
type Entry = z.infer<typeof entrySchema>;

export const managementSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("contractor"), id, name: text, handle: text, chat_uid: text.describe("Required contractor group containing the owner, this agent and exactly this worker. Use the chat_uid returned by plow_start_thread, never the owner DM."), timezone: text, rate_cents: z.number().int().min(0).max(100_000_000),
    language: z.enum(["en", "pt"]).default("pt") }).strict(),
  z.object({ action: z.literal("demand"), id, contractor_id: id, project: text, summary: text, references: z.string().max(4000).default("") }).strict(),
  z.object({ action: z.literal("correct"), entry_id: text, start: timestamp.optional().describe("Correct the start in place. For an open clock, omit finish to keep it running."), finish: timestamp.optional().describe("Omit to preserve the current finish, including an open clock."), reason: text, demand_id: id.optional(), restore: z.boolean().optional().describe("True only when the owner authorizes restoring an accidentally voided entry. Restores and corrects atomically.") }).strict(),
  z.object({ action: z.literal("void"), entry_id: text, reason: text }).strict(),
  z.object({ action: z.literal("review_entry"), entry_id: text, reason: text }).strict(),
  z.object({ action: z.literal("resolve_clock"), contractor_id: id, reason: text }).strict(),
  z.object({ action: z.literal("reconcile_stop"), contractor_id: id, stop_message_uid: text, start: timestamp, reason: text,
    demand_id: id.optional(), details: z.string().max(4000).default(""), project: text.optional() }).strict(),
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
type Language = "en" | "pt";
/** A local receipt time with the date when it is not today. */
export function clockTime(ms: number, timezone: string, language: Language) {
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const saoPaulo = timezone === "America/Sao_Paulo";
  const label = saoPaulo ? language === "pt" ? " (horário de São Paulo)" : " (São Paulo time)" : "";
  return new Intl.DateTimeFormat(language === "pt" ? "pt-BR" : "en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit",
    ...(saoPaulo ? {} : { timeZoneName: "short" as const }), ...(day(ms) === day(Date.now()) ? {} : { month: "short", day: "numeric" }) }).format(ms) + label;
}
/** Human duration without rounding partial minutes into extra recorded work. */
export function duration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : ""].filter(Boolean).join(" ") || (ms > 0 ? "<1 s" : "0 min");
}
/** Every clock receipt a contractor reads, in the language they were registered with. Shortcut commands send these
 * without a model turn, so they must already be in the contractor's language. Owner notices keep their own copy. */
const RECEIPTS = {
  pt: {
    lateStart: "Este início chegou atrasado e vem antes do ponto que está aberto.",
    confirmBeforeStart: "A confirmação veio antes do início pendente.",
    overlaps: "Esse horário cruza um ponto existente.",
    afterClose: "Este início chegou depois do fechamento do período.",
    stopCrosses: "Esse encerramento cruza outro ponto ou vem antes do início.",
    conflict: (reason: string) => `${reason} Guardei a mensagem com seu horário original para o dono revisar. O registro de horas foi preservado; a cobrança aguarda essa revisão.`,
    alreadyOpen: (at: string) => `Seu ponto já está aberto desde ${at}. Se mudou de atividade, posso acrescentar uma anotação.`,
    pendingCancelled: "Início pendente cancelado. Nenhuma hora foi registrada.",
    clarifyStart: (at: string) => `Recebi seu início às ${at}. Qual demanda você está fazendo? Vou manter esse horário quando você confirmar.`,
    noPendingStart: "Não há um início pendente desta conversa para confirmar. Me diga quando começar uma demanda.",
    started: (at: string, work: string) => `Ponto iniciado às ${at}.${work ? ` Trabalho: ${work}.` : " O que você está fazendo?"}`,
    recoveredStop: (stop: string) => ` O encerramento que chegou antes também foi recuperado: ${stop}`,
    stopped: (at: string, total: string, long: boolean) => `Ponto encerrado às ${at}. Total: ${total}.${long ? " Esse bloco passou de 12 horas e precisa da revisão do dono antes do fechamento." : ""}`,
    statusOpen: (at: string, work: string) => `Ponto aberto desde ${at}.${work ? ` Trabalho: ${work}` : ""}`,
    statusNone: "Nenhum ponto aberto. Me diga quando começar e em qual tarefa.",
    noteNoClock: "Não há um ponto aberto para anotar esse trabalho. Me diga quando começar.",
    noted: "Anotação registrada. Seu ponto continua aberto com o mesmo horário inicial.",
    switchNoClock: "Não há um ponto aberto para trocar. Me diga quando começar a nova tarefa.",
    switchSame: "Você já está trabalhando nessa tarefa; mantive o horário inicial.",
    switchFailed: "Não consegui trocar: confira a tarefa e o horário com o dono. O ponto anterior continua aberto.",
    stopNoClock: "Você não tem ponto aberto. Guardei este encerramento com seu horário original para recuperar um início atrasado. O dono pode revisar se faltou o início.",
    tooLong: "Envie os detalhes em até 4.000 caracteres.",
    ownerClosed: "O dono revisou e encerrou esta pendência; nenhuma hora foi acrescentada por esta mensagem.",
    ownerConfirmed: (start: string, finish: string, total: string) => `O dono confirmou o início às ${start}. Ponto encerrado às ${finish}. Total: ${total}.`,
    voided: "Esse registro foi anulado pelo dono; não conta nas horas.",
  },
  en: {
    lateStart: "This start arrived late and comes before the clock that is already running.",
    confirmBeforeStart: "The confirmation came before the pending start.",
    overlaps: "That time overlaps a clock already recorded.",
    afterClose: "This start arrived after the billing period closed.",
    stopCrosses: "That stop overlaps another clock or comes before the start.",
    conflict: (reason: string) => `${reason} I saved your message with its original time for the owner to review. Your hours are preserved; billing waits for that review.`,
    alreadyOpen: (at: string) => `Your clock has been running since ${at}. If you switched tasks, I can add a note.`,
    pendingCancelled: "Pending start cancelled. No hours were recorded.",
    clarifyStart: (at: string) => `Got your start at ${at}. What are you working on? I'll keep that start time when you confirm.`,
    noPendingStart: "There's no pending start in this conversation to confirm. Tell me when you start working.",
    started: (at: string, work: string) => `Clock started at ${at}.${work ? ` Work: ${work}.` : " What are you working on?"}`,
    recoveredStop: (stop: string) => ` The stop that arrived earlier was recovered too: ${stop}`,
    stopped: (at: string, total: string, long: boolean) => `Clock stopped at ${at}. Total: ${total}.${long ? " This block is over 12 hours and needs the owner's review before it closes." : ""}`,
    statusOpen: (at: string, work: string) => `Clock running since ${at}.${work ? ` Work: ${work}` : ""}`,
    statusNone: "No clock running. Tell me when you start and what you're working on.",
    noteNoClock: "There's no clock running to add that note to. Tell me when you start.",
    noted: "Noted. Your clock is still running from the same start time.",
    switchNoClock: "There's no clock running to switch. Tell me when you start the new task.",
    switchSame: "You're already on that task; I kept the original start time.",
    switchFailed: "I couldn't switch: check the task and time with the owner. The previous clock is still running.",
    stopNoClock: "You don't have a clock running. I saved this stop with its original time in case a late start arrives; the owner can review a missing start.",
    tooLong: "Please send details in 4,000 characters or fewer.",
    ownerClosed: "The owner reviewed and closed this item; no hours were added from this message.",
    ownerConfirmed: (start: string, finish: string, total: string) => `The owner confirmed the start at ${start}. Clock stopped at ${finish}. Total: ${total}.`,
    voided: "The owner voided this record; it doesn't count toward hours.",
  },
} satisfies Record<Language, Record<string, string | ((...args: never[]) => string)>>;
type ConflictReason = "lateStart" | "confirmBeforeStart" | "overlaps" | "afterClose" | "stopCrosses";
const sheetText = (value: string) => /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
const markdownText = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_\[\]<>#|]/g, "\\$&");
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
        timezone TEXT NOT NULL, rate_cents INTEGER NOT NULL CHECK(rate_cents >= 0),
        language TEXT NOT NULL DEFAULT 'pt' CHECK(language IN ('en','pt')), revision INTEGER NOT NULL DEFAULT 1,
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
      if (!this.db.prepare("PRAGMA table_info(contractors)").all().some(row => row.name === "language"))
        this.db.exec("ALTER TABLE contractors ADD COLUMN language TEXT NOT NULL DEFAULT 'pt' CHECK(language IN ('en','pt'))");
      if (!this.db.prepare("PRAGMA table_info(clock_inbox)").all().some(row => row.name === "review_reason"))
        this.db.exec("ALTER TABLE clock_inbox ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''");
      if (!this.db.prepare("PRAGMA table_info(owner_notices)").all().some(row => row.name === "kind"))
        this.db.exec("ALTER TABLE owner_notices ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval_revoked' CHECK(kind IN ('approval_revoked','clock_review'))");
      if (!this.db.prepare("PRAGMA table_info(owner_notices)").all().some(row => row.name === "body"))
        this.db.exec("ALTER TABLE owner_notices ADD COLUMN body TEXT NOT NULL DEFAULT ''");
      this.db.exec("DROP INDEX IF EXISTS one_open_entry; CREATE UNIQUE INDEX one_open_entry ON entries(contractor_id) WHERE end_ms IS NULL AND voided=0;");
      this.db.exec("UPDATE clock_inbox SET source_json=json_set(source_json, '$.body', '') WHERE complete=1;");
      // Old work-note receipts must not consume a start/stop from the same message.
      this.db.exec(`UPDATE receipts SET source='note:' || source
        WHERE EXISTS (SELECT 1 FROM audit WHERE audit.source=receipts.source AND action='note')
        AND NOT EXISTS (SELECT 1 FROM entries WHERE start_message=receipts.source OR stop_message=receipts.source)
        AND NOT EXISTS (SELECT 1 FROM receipts AS notes WHERE notes.source='note:' || receipts.source);`);
      for (const row of this.db.prepare("SELECT DISTINCT contractor_id FROM unmatched_stops").all()) {
        const contractor = this.contractor(z.object({ contractor_id: id }).parse(row).contractor_id);
        for (const stop of this.unmatchedStops(contractor.id)) this.queueStopNotice(contractor, stop.message);
      }
      for (const row of this.db.prepare("SELECT source_json, contractor_id, review_reason FROM clock_inbox WHERE review_reason != ''").all()) {
        const review = z.object({ source_json: z.string(), contractor_id: id, review_reason: text }).parse(row);
        this.queueClockReviewNotice(this.contractor(review.contractor_id), clockSourceSchema.parse(JSON.parse(review.source_json)), review.review_reason);
      }
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
      if ((input.period_start === undefined) !== (input.period_end === undefined)) throw new Error("Provide both period_start and period_end for a date-filtered report.");
      const bounds = input.period_start && input.period_end ? periodBounds(input.period_start, input.period_end, report.contractor.timezone)
        : { start_ms: Number.MIN_SAFE_INTEGER, end_ms: Number.MAX_SAFE_INTEGER };
      const value = periodValue(report.entries, bounds);
      return { contractor: { id: report.contractor.id, name: report.contractor.name, timezone: report.contractor.timezone,
          local_date: localTime(Date.now(), report.contractor.timezone).slice(0, 10), rate_cents: report.contractor.rate_cents },
        demands: report.demands.filter(d => d.active && !d.reported), total_hours: value.total_hours,
        earnings: { currency: "USD", amount_usd_cents: value.amount_usd_cents, duration_ms: value.duration_ms, duration_text: duration(value.duration_ms),
          period_start: input.period_start ?? null, period_end: input.period_end ?? null, timezone: report.contractor.timezone,
          basis: "Closed recorded intervals at their captured rates; excludes open, unmatched and voided time. Not approval or payment." },
        pending_start: this.pendingStart(contractorId)?.source.created_at ?? null,
        pending_clock: report.pending_clock,
        open_entry: report.open_entry ? { start_ms: report.open_entry.start_ms, details: report.open_entry.details, rate_cents: report.open_entry.rate_cents, timezone: report.open_entry.timezone } : null,
        clock_language: "Use start immediately for clear work beginning now, even without a task or description. details records the worker's own overview; project is optional and must come from context. Ask what they are working on after recording the start. Their answer and later activity changes use note, keeping that clock open. Assigned demands are optional context, never required or approved tasks. confirm_start is only for a legacy pending start. Never clock uncertain intent, plans, questions, negations or historical statements.",
        entries: report.entries.filter(e => !e.voided && e.start_ms < bounds.end_ms && (e.end_ms ?? Number.MAX_SAFE_INTEGER) > bounds.start_ms)
          .map(({ demand_id, start_ms, end_ms, details, rate_cents, timezone }) => ({ demand_id, start_ms, end_ms, details, rate_cents, timezone })),
        review_needed: report.review_needed,
        billing: (() => { const { fingerprint, expected, ...status } = this.billingReport(contractorId); return status; })() };
    }
    return this.transaction(() => {
      const key = `member:${source}`;
      const old = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(key);
      if (old) return JSON.parse(receiptSchema.parse(old).response);
      const approved = this.billing.hasStoredApproval(contractorId);
      const result = this.billing.submit(contractorId, input);
      if (approved && !this.billing.hasStoredApproval(contractorId)) this.queueOwnerNotice(key, contractorId, "approval_revoked");
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
        JSON.stringify(input), contractor.rate_cents, contractor.timezone);
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

  private unmatchedStops(contractorId: string) {
    return this.db.prepare("SELECT source, source_json, details FROM unmatched_stops WHERE contractor_id=?").all(contractorId)
      .map(row => z.object({ source: text, source_json: z.string(), details: z.string() }).parse(row))
      .map(row => {
        const message = clockSourceSchema.parse(JSON.parse(row.source_json));
        const captured = this.recordedClockSource(message);
        return { source: row.source, message, details: row.details,
          rate_cents: captured?.rate_cents ?? null, timezone: captured?.timezone ?? null };
      }).sort((a, b) => Date.parse(a.message.created_at) - Date.parse(b.message.created_at));
  }

  private startClock(contractor: Contractor, input: ClockSource, command: StartIntent): string {
    const pending = this.pendingStart(contractor.id);
    const original = this.recordedClockSource(input) ?? { source: input, rate_cents: contractor.rate_cents, timezone: contractor.timezone };
    const origin = command.kind === "confirm_start" && pending ? pending : original;
    const ms = Date.parse(origin.source.created_at);
    const active = this.open(contractor.id);
    const say = RECEIPTS[contractor.language];
    if (active) return ms < active.start_ms && command.kind !== "cancel_start"
      ? this.clockConflict(contractor, origin.source, "lateStart")
      : say.alreadyOpen(clockTime(active.start_ms, active.timezone, contractor.language));
    if (command.kind === "cancel_start") {
      this.db.prepare("DELETE FROM pending_starts WHERE contractor_id = ?").run(contractor.id);
      return say.pendingCancelled;
    }
    if (command.kind === "clarify_start") {
      if (!pending) this.db.prepare("INSERT INTO pending_starts(contractor_id, source_json, rate_cents, timezone) VALUES (?, ?, ?, ?)")
        .run(contractor.id, JSON.stringify(original.source), original.rate_cents, original.timezone);
      const start = pending?.source.created_at ?? original.source.created_at;
      return say.clarifyStart(clockTime(Date.parse(start), pending?.timezone ?? original.timezone, contractor.language));
    }
    if (command.kind === "confirm_start" && (!pending || pending.source.line_uid !== input.line_uid
      || pending.source.chat_uid !== input.chat_uid || normalizeHandle(pending.source.handle) !== normalizeHandle(input.handle))) {
      return say.noPendingStart;
    }
    if (ms > Date.parse(input.created_at)) return this.clockConflict(contractor, input, "confirmBeforeStart");
    const source = JSON.stringify([origin.source.line_uid, origin.source.chat_uid, origin.source.message_uid]);
    const assigned = this.db.prepare("SELECT * FROM demands WHERE id = ? AND contractor_id = ? AND active=1 AND reported=0").get(command.detail, contractor.id);
    const description = command.description ?? (assigned ? "" : command.detail);
    const demand = assigned ? demandSchema.parse(assigned) : {
      id: `activity_${createHash("sha256").update(source).digest("hex").slice(0,24)}`, contractor_id: contractor.id,
      project: command.project ?? "Uncategorized",
      summary: description.slice(0,2000) || "Work in progress", references: "", active: 1, reported: 1,
    };
    const waiting = this.unmatchedStops(contractor.id)
      .find(row => row.message.line_uid === input.line_uid && row.message.chat_uid === input.chat_uid && Date.parse(row.message.created_at) > ms);
    const finish = waiting ? Date.parse(waiting.message.created_at) : null;
    if (this.overlaps(contractor.id, ms, finish, source)) return this.clockConflict(contractor, origin.source, "overlaps");
    if (this.billing.isLocked(contractor.id, ms, finish)) return this.clockConflict(contractor, origin.source, "afterClose");
    this.billing.assertUnlocked(contractor.id, ms, finish);
    if (!assigned) this.db.prepare('INSERT INTO demands(id, contractor_id, project, summary, "references", reported) VALUES (?, ?, ?, ?, ?, 1)')
      .run(demand.id, contractor.id, demand.project, demand.summary, "");
    const entryId = `hours_${createHash("sha256").update(source).digest("hex").slice(0,24)}`;
    this.db.prepare("INSERT INTO entries(id, contractor_id, demand_id, start_ms, rate_cents, timezone, start_message, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entryId, contractor.id, demand.id, ms, origin.rate_cents, origin.timezone, source, description);
    this.db.prepare("DELETE FROM pending_starts WHERE contractor_id = ?").run(contractor.id);
    this.bump(contractor.id);
    this.audit(source, "start", undefined, { contractor_id: contractor.id, demand_id: demand.id, start_ms: ms, details: description, project: demand.project });
    let response = say.started(clockTime(ms, origin.timezone, contractor.language), description);
    if (waiting && finish !== null) {
      const stop = this.finishClock(entrySchema.parse(this.db.prepare("SELECT * FROM entries WHERE id=?").get(entryId)), finish, waiting.details, waiting.source);
      this.db.prepare("UPDATE receipts SET response=? WHERE source=?").run(stop, waiting.source);
      this.db.prepare("DELETE FROM unmatched_stops WHERE source=?").run(waiting.source);
      this.completeOwnerNotice(waiting.source);
      response += say.recoveredStop(stop);
    }
    if (command.kind === "confirm_start") this.db.prepare("UPDATE receipts SET response = ? WHERE source = ?").run(response, source);
    return response;
  }

  private clockConflict(contractor: Contractor, input: ClockSource, why: ConflictReason) {
    const reason = RECEIPTS.pt[why];
    this.rememberClockMessage(input);
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason=?, source_json=json_set(source_json, '$.body', '') WHERE source=?").run(reason, source);
    this.billing.invalidateApproval(contractor.id);
    this.bump(contractor.id);
    this.audit(source, "clock_review", undefined, { contractor_id: contractor.id, created_at: input.created_at, reason });
    this.queueClockReviewNotice(contractor, input, reason);
    const say = RECEIPTS[contractor.language];
    return say.conflict(say[why]);
  }

  private finishClock(active: Entry, ms: number, details: string, source: string) {
    this.billing.assertUnlocked(active.contractor_id, active.start_ms, ms);
    const recordedDetails = [active.details, details].filter(Boolean).join("\n");
    this.db.prepare("UPDATE entries SET end_ms=?, details=?, stop_message=? WHERE id=?").run(ms, recordedDetails, source, active.id);
    this.bump(active.contractor_id);
    this.audit(source, "stop", active, { ...active, end_ms: ms, details: recordedDetails, stop_message: source });
    const language = this.contractor(active.contractor_id).language;
    return RECEIPTS[language].stopped(clockTime(ms, active.timezone, language), duration(ms - active.start_ms), ms - active.start_ms > 12 * 3_600_000);
  }

  /** The last clock receipts sent in a contractor's group, oldest first. Shortcut commands are answered by the channel
   * without a model turn, so the group prompt carries these for a follow-up like "what did you say?". */
  recentReceipts(contractorId: string, limit = 3) {
    const chat = this.contractor(contractorId).chat_uid;
    return this.db.prepare("SELECT response FROM receipts WHERE CASE WHEN json_valid(source) THEN json_extract(source, '$[1]') END = ? ORDER BY rowid DESC LIMIT ?").all(chat, limit)
      .map(row => receiptSchema.parse(row).response).reverse();
  }

  clockReceipt(input: ClockSource): string | undefined {
    const contractor = this.groupContractor(input.chat_uid);
    if (!contractor || contractor.handle !== normalizeHandle(input.handle)) return undefined;
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    const receipt = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(source);
    return receipt ? receiptSchema.parse(receipt).response : undefined;
  }

  clockChangeReceipt(input: ClockSource): string | undefined {
    const receipt = this.clockReceipt(input);
    if (!receipt) return undefined;
    const source = JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]);
    const changed = this.db.prepare("SELECT 1 FROM audit WHERE source=? AND action IN ('start', 'stop', 'clock_review') UNION ALL SELECT 1 FROM owner_notices WHERE source=? AND kind='clock_review' LIMIT 1").get(source, source);
    return changed ? receipt : undefined;
  }

  pendingOwnerNotices() {
    return this.db.prepare("SELECT source, name, kind, body FROM owner_notices JOIN contractors ON contractors.id=owner_notices.contractor_id WHERE delivered=0 ORDER BY owner_notices.rowid")
      .all().map(row => ownerNoticeSchema.parse(row));
  }

  private queueOwnerNotice(source: string, contractorId: string, kind: z.infer<typeof ownerNoticeSchema>["kind"], body = "") {
    this.db.prepare("INSERT INTO owner_notices(source, contractor_id, kind, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(source, contractorId, kind, body);
  }

  private queueClockReviewNotice(contractor: Contractor, input: ClockSource, reason: string) {
    const timezone = this.recordedClockSource(input)?.timezone ?? contractor.timezone;
    this.queueOwnerNotice(JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]), contractor.id, "clock_review",
      `${contractor.name} tem um registro de horas pendente de revisão em ${clockTime(Date.parse(input.created_at), timezone, "pt")}. ${reason} Confirme os horários corretos aqui no privado para eu ajustar o registro.`);
  }

  private queueStopNotice(contractor: Contractor, input: ClockSource) {
    const pending = this.pendingStart(contractor.id), finish = Date.parse(input.created_at);
    const timezone = this.recordedClockSource(input)?.timezone ?? contractor.timezone;
    const question = pending && Date.parse(pending.source.created_at) < finish
      ? `Há também um início pendente em ${clockTime(Date.parse(pending.source.created_at), pending.timezone, "pt")}. Confirma que esses registros formam o mesmo período de trabalho?`
      : "Qual foi o horário de entrada? Confirme aqui no privado para eu consolidar esse período.";
    this.queueOwnerNotice(JSON.stringify([input.line_uid, input.chat_uid, input.message_uid]), contractor.id, "clock_review",
      `${contractor.name} registrou uma saída em ${clockTime(finish, timezone, "pt")}, mas não há um ponto de entrada aberto. ${question} As horas desse período ainda não foram contabilizadas.`);
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
    const receiptSource = command.kind === "note" ? `note:${source}` : source;
    return this.transaction(() => {
      const receipt = this.db.prepare("SELECT response FROM receipts WHERE source = ?").get(receiptSource);
      if (receipt) return receiptSchema.parse(receipt).response;
      let response: string;
      const active = this.open(contractor.id), say = RECEIPTS[contractor.language];
      if (command.kind === "status") {
        response = active ? say.statusOpen(clockTime(active.start_ms, active.timezone, contractor.language), active.details) : say.statusNone;
      } else if (command.kind === "note") {
        if (!active) response = say.noteNoClock;
        else {
          const details = [active.details, command.detail].filter(Boolean).join("\n");
          const demand = demandSchema.parse(this.db.prepare("SELECT * FROM demands WHERE contractor_id=? AND id=?").get(contractor.id, active.demand_id));
          const project = demand.reported && demand.project === "Uncategorized" && command.project
            ? command.project : demand.project;
          if (demand.reported) this.db.prepare("UPDATE demands SET summary=?, project=? WHERE contractor_id=? AND id=?")
            .run(active.details ? demand.summary : command.detail.slice(0,2000),
              project, contractor.id, active.demand_id);
          this.db.prepare("UPDATE entries SET details=? WHERE id=?").run(details, active.id);
          this.bump(contractor.id);
          this.audit(source, "note", active, { ...active, details, project });
          response = say.noted;
        }
      } else if (command.kind === "switch") {
        if (!active) response = say.switchNoClock;
        else if (active.demand_id === command.detail) response = say.switchSame;
        else if (ms <= active.start_ms || !this.db.prepare("SELECT id FROM demands WHERE contractor_id=? AND id=? AND active=1").get(contractor.id, command.detail)) response = say.switchFailed;
        else {
          const stopped = this.finishClock(active, ms, command.details, source);
          const started = this.startClock(contractor, input, { kind: "start", detail: command.detail });
          if (!this.open(contractor.id)) throw new Error("Could not start the new task; the whole switch was rolled back.");
          response = `${stopped} ${started}`;
        }
      } else if (command.kind !== "stop") {
        response = this.startClock(contractor, input, command);
      } else if (!active) {
        this.db.prepare("INSERT INTO unmatched_stops(source, contractor_id, source_json, details) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(source, contractor.id, JSON.stringify({ ...input, body: "" }), command.detail);
        this.billing.invalidateApproval(contractor.id);
        this.queueStopNotice(contractor, input);
        response = say.stopNoClock;
      }
      else if (ms <= active.start_ms || this.overlaps(contractor.id, active.start_ms, ms, active.id)) {
        response = this.clockConflict(contractor, input, "stopCrosses");
      } else if (command.detail.length > 4000) response = say.tooLong;
      else {
        response = this.finishClock(active, ms, command.detail, source);
      }
      this.db.prepare("INSERT INTO receipts(source, response) VALUES (?, ?)").run(receiptSource, response);
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
            .run(key, RECEIPTS[this.contractor(input.contractor_id).language].ownerClosed);
          this.db.prepare("DELETE FROM pending_starts WHERE contractor_id=?").run(input.contractor_id);
          this.db.prepare("DELETE FROM unmatched_stops WHERE contractor_id=?").run(input.contractor_id);
          this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason='', source_json=json_set(source_json, '$.body', '') WHERE contractor_id=?").run(input.contractor_id);
          this.db.prepare("UPDATE owner_notices SET delivered=1 WHERE contractor_id=? AND kind='clock_review'").run(input.contractor_id);
          this.audit(source, input.action, before, input);
          return { resolved: true, contractor_id: input.contractor_id, reason: input.reason };
        }
        case "reconcile_stop": {
          const contractor = this.contractor(input.contractor_id);
          const stop = this.unmatchedStops(contractor.id).find(s => s.message.message_uid === input.stop_message_uid);
          if (!stop) throw new Error("That unmatched stop is unavailable for this contractor. Read the report before changing an existing entry.");
          const start = Date.parse(input.start), finish = Date.parse(stop.message.created_at);
          if (finish <= start) throw new Error("The confirmed start must be before the saved stop.");
          const pending = this.pendingStart(contractor.id);
          const paired = pending && pending.source.line_uid === stop.message.line_uid && pending.source.chat_uid === stop.message.chat_uid
            && normalizeHandle(pending.source.handle) === normalizeHandle(stop.message.handle) && Date.parse(pending.source.created_at) < finish ? pending : undefined;
          const rate = paired?.rate_cents ?? stop.rate_cents, timezone = paired?.timezone ?? stop.timezone;
          if (rate === null || timezone === null) throw new Error("The stop timestamp is saved, but its historical rate or timezone is unavailable. The owner must confirm them for a manual correction.");
          const pendingSource = paired ? JSON.stringify([paired.source.line_uid, paired.source.chat_uid, paired.source.message_uid]) : undefined;
          const entryId = `hours_${createHash("sha256").update(stop.source).digest("hex").slice(0,24)}`;
          this.billing.assertUnlocked(contractor.id, start, finish);
          if (this.overlaps(contractor.id, start, finish, entryId)) throw new Error("The correction overlaps another time entry.");
          const assigned = input.demand_id ? this.db.prepare("SELECT * FROM demands WHERE id=? AND contractor_id=?").get(input.demand_id, contractor.id) : undefined;
          if (input.demand_id && !assigned) throw new Error("The referenced demand does not belong to this contractor.");
          const details = [input.details, stop.details].filter(Boolean).join("\n");
          const demand = assigned ? demandSchema.parse(assigned) : {
            id: `activity_${createHash("sha256").update(stop.source).digest("hex").slice(0,24)}`,
            project: input.project ?? "Uncategorized", summary: details.slice(0,2000) || "Work session",
          };
          if (!assigned) this.db.prepare('INSERT INTO demands(id, contractor_id, project, summary, "references", reported) VALUES (?, ?, ?, ?, ?, 1)')
            .run(demand.id, contractor.id, demand.project, demand.summary, "");
          this.db.prepare("INSERT INTO entries(id, contractor_id, demand_id, start_ms, end_ms, rate_cents, timezone, details, start_message, stop_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(entryId, contractor.id, demand.id, start, finish, rate, timezone, details, pendingSource ?? receiptKey, stop.source);
          this.db.prepare("DELETE FROM unmatched_stops WHERE source=?").run(stop.source);
          this.completeOwnerNotice(stop.source);
          if (paired && pendingSource) {
            this.db.prepare("DELETE FROM pending_starts WHERE contractor_id=?").run(contractor.id);
            this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason='', source_json=json_set(source_json, '$.body', '') WHERE source=?").run(pendingSource);
          }
          this.db.prepare("UPDATE clock_inbox SET complete=1, review_reason='', source_json=json_set(source_json, '$.body', '') WHERE source=?").run(stop.source);
          const confirmation = RECEIPTS[contractor.language].ownerConfirmed(clockTime(start, timezone, contractor.language), clockTime(finish, timezone, contractor.language), duration(finish - start));
          this.db.prepare("UPDATE receipts SET response=? WHERE source=?").run(confirmation, stop.source);
          if (pendingSource) this.db.prepare("UPDATE receipts SET response=? WHERE source=?").run(confirmation, pendingSource);
          this.bump(contractor.id);
          this.audit(source, input.action, { stop, pending_start: paired }, { ...input, entry_id: entryId, start_ms: start, end_ms: finish, rate_cents: rate, timezone });
          return { recorded: true, entry_id: entryId, start_ms: start, end_ms: finish, hours: hours(finish - start), rate_cents: rate, timezone, stop_message_uid: stop.message.message_uid };
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
          if (before?.active && before.name === input.name && before.timezone === input.timezone && before.rate_cents === input.rate_cents
            && before.language === input.language) return { contractor_id: input.id, registered: true };
          this.db.prepare(`INSERT INTO contractors(id, name, handle, chat_uid, timezone, rate_cents, language) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, timezone=excluded.timezone, rate_cents=excluded.rate_cents, language=excluded.language, active=1, revision=contractors.revision+1`)
            .run(input.id, input.name, handle, input.chat_uid, input.timezone, input.rate_cents, input.language);
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
          if (before.voided && !input.restore) throw new Error("Use correct with restore=true only when the owner authorizes restoring this voided entry.");
          if (!input.start && !input.finish && !input.demand_id && !input.restore) throw new Error("Specify the correction to apply.");
          const start = input.start ? Date.parse(input.start) : before.start_ms;
          const finish = input.finish ? Date.parse(input.finish) : before.end_ms;
          if (finish !== null && finish <= start) throw new Error("Finish must be after start.");
          if (finish === null && start > Date.now()) throw new Error("An open clock cannot start in the future.");
          const demandId = input.demand_id ?? before.demand_id;
          if (!this.db.prepare("SELECT id FROM demands WHERE contractor_id=? AND id=?").get(before.contractor_id, demandId)) throw new Error("Demand is not assigned to this contractor.");
          this.billing.assertUnlocked(before.contractor_id, before.start_ms, before.end_ms);
          this.billing.assertUnlocked(before.contractor_id, start, finish);
          if (this.overlaps(before.contractor_id, start, finish, before.id)) throw new Error("Correction overlaps another time entry.");
          this.db.prepare("UPDATE entries SET start_ms = ?, end_ms = ?, demand_id=?, reviewed=0, voided=0 WHERE id = ?").run(start, finish, demandId, before.id);
          this.bump(before.contractor_id);
          this.audit(source, input.action, before, { ...before, start_ms: start, end_ms: finish, demand_id: demandId, reviewed: 0, voided: 0, reason: input.reason });
          const contractor = this.contractor(before.contractor_id);
          const say = RECEIPTS[contractor.language];
          const confirmation = finish === null ? say.started(clockTime(start, before.timezone, contractor.language), before.details)
            : say.ownerConfirmed(clockTime(start, before.timezone, contractor.language), clockTime(finish, before.timezone, contractor.language), duration(finish - start));
          this.db.prepare("UPDATE receipts SET response=? WHERE source IN (?, ?)").run(confirmation, before.start_message, before.stop_message);
          return { entry_id: before.id, corrected: true, restored: Boolean(before.voided), status: finish === null ? "open" : "closed",
            start: new Date(start).toISOString(), finish: finish === null ? null : new Date(finish).toISOString(), confirmation, reason: input.reason };
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
          if (input.action === "void") this.db.prepare("UPDATE receipts SET response=? WHERE source IN (?, ?)").run(RECEIPTS[this.contractor(before.contractor_id).language].voided, before.start_message, before.stop_message);
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
            .run(entryId, contractor.id, input.demand_id, start, finish, input.rate_cents, contractor.timezone, input.details, receiptKey);
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
      const demands = this.db.prepare("SELECT * FROM demands WHERE contractor_id = ? ORDER BY id").all(contractor.id).map(row => demandSchema.parse(row));
      const entries = this.db.prepare("SELECT * FROM entries WHERE contractor_id = ? ORDER BY start_ms, id").all(contractor.id).map(row => entrySchema.parse(row));
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
      const stops = this.unmatchedStops(contractor.id);
      return {
        contractor, demands, entries, total_hours: hours(duration), open_entry: active ?? null,
        review_needed: entries.filter(needsReview).map(e => e.id),
        pending_clock: { start: this.pendingStart(contractor.id)?.source.created_at ?? null, timezone: this.pendingStart(contractor.id)?.timezone ?? null, unmatched_stops: stops.length, messages: this.pendingClockMessagesForContractor(contractor.id).length,
          stops: stops.map(stop => ({ message_uid: stop.message.message_uid, created_at: stop.message.created_at,
            timezone: stop.timezone, details: stop.details })),
          reviews: this.db.prepare("SELECT source, json_extract(source_json, '$.created_at') AS created_at, review_reason FROM clock_inbox WHERE contractor_id=? AND review_reason!='' ORDER BY created_at").all(contractor.id) },
        audit: this.db.prepare("SELECT * FROM audit WHERE COALESCE(json_extract(after_json, '$.contractor_id'), json_extract(after_json, '$.id')) = ? ORDER BY seq").all(contractor.id),
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
