import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { entrySchema, needsReview, periodBounds, periodValue } from "./hours-period.ts";

const text = z.string().trim().min(1).max(2000);
const link = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use a private HTTPS document link without embedded credentials.");
const date = z.iso.date();
const contractorId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const billingRequestSchema = z.object({
  action: z.literal("billing_request"), contractor_id: contractorId, country: z.enum(["BR", "US"]),
  period_start: date, period_end: date, w9_required: z.boolean().default(false),
}).strict();
export const billingReportSchema = z.object({ action: z.literal("billing_report"), contractor_id: contractorId }).strict();
export const billingActions = [
  z.object({ action: z.literal("close_period"), contractor_id: contractorId,
    brl_amount_cents: z.number().int().positive().max(1_000_000_000).optional(), conversion_note: text.optional() }).strict(),
  z.object({ action: z.literal("reopen_period"), contractor_id: contractorId, reason: text }).strict(),
  z.object({ action: z.literal("approve_billing"), contractor_id: contractorId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
] as const;

// Complete instructions stay in a document shared privately with the owner.
export const paymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("pix"), beneficiary: text, document_url: link }).strict(),
  z.object({ method: z.literal("ach"), beneficiary: text, document_url: link, bank: text,
    account_last4: z.string().regex(/^\d{4}$/), account_type: z.enum(["checking", "savings"]) }).strict(),
]);
const legacyPaymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("pix"), beneficiary: text, key: text }).strict(),
  z.object({ method: z.literal("ach"), beneficiary: text, bank: text, routing: z.string(), account: z.string(), account_type: z.enum(["checking", "savings"]) }).strict(),
]);
const storedPaymentSchema = z.union([paymentSchema, legacyPaymentSchema]);
const invoiceSchema = z.object({ number: text, url: link, currency: z.enum(["USD", "BRL"]),
  amount_cents: z.number().int().positive().max(1_000_000_000), period_start: date, period_end: date }).strict();
export const billingSubmissionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invoice"), invoice: invoiceSchema }).strict(),
  z.object({ action: z.literal("payment_details"), payment: paymentSchema }).strict(),
  z.object({ action: z.literal("tax_document"), url: link }).strict(),
]);
export const selfSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("report") }).strict(),
  z.object({ action: z.literal("start"), demand_id: contractorId }).strict(),
  z.object({ action: z.literal("switch"), demand_id: contractorId, details: z.string().max(4000).default("") }).strict(),
  z.object({ action: z.literal("clarify_start") }).strict(),
  z.object({ action: z.literal("confirm_start"), demand_id: contractorId }).strict(),
  z.object({ action: z.literal("cancel_start") }).strict(),
  z.object({ action: z.literal("stop"), details: z.string().max(4000).default("") }).strict(),
  z.object({ action: z.literal("note"), details: z.string().trim().min(1).max(4000) }).strict(),
  ...billingSubmissionSchema.options,
]);
const rowSchema = z.object({ contractor_id: text, country: z.enum(["BR", "US"]), period_start: date,
  period_end: date, invoice_json: z.string().nullable(), payment_json: z.string().nullable(), tax_document_url: z.string().nullable(), w9_required: z.number() });
const valueSchema = z.object({ timezone: text, start_ms: z.number().int(), end_ms: z.number().int(), duration_ms: z.number().int(),
  total_hours: z.number(), amount_usd_cents: z.number().int(), currency: z.enum(["USD", "BRL"]), expected_amount_cents: z.number().int(), conversion_note: z.string().nullable(),
  blocks: z.array(z.object({ entry_id: text, demand_id: text, start_ms: z.number().int(), end_ms: z.number().int(), rate_cents: z.number().int() })) });
const closureSchema = z.object({ id: text, contractor_id: text, start_ms: z.number().int(), end_ms: z.number().int(),
  closed: z.number(), snapshot_json: z.string(), approval_digest: z.string().nullable(), approved_source: z.string().nullable() });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class HoursBilling {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS billing_requests (
      contractor_id TEXT PRIMARY KEY REFERENCES contractors(id), country TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, invoice_json TEXT, payment_json TEXT, tax_document_url TEXT
    );
    CREATE TABLE IF NOT EXISTS billing_history (seq INTEGER PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), invoice_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_changes (seq INTEGER PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), action TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_closures (id TEXT PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL, closed INTEGER NOT NULL, snapshot_json TEXT NOT NULL, approval_digest TEXT, approved_source TEXT);`);
    if (!db.prepare("PRAGMA table_info(billing_requests)").all().some(row => row.name === "w9_required")) db.exec("ALTER TABLE billing_requests ADD COLUMN w9_required INTEGER NOT NULL DEFAULT 0");
  }
  private row(contractorId: string) {
    const row = this.db.prepare("SELECT * FROM billing_requests WHERE contractor_id = ?").get(contractorId);
    return row ? rowSchema.parse(row) : undefined;
  }
  private periodId(row: z.infer<typeof rowSchema>) { return digest([row.contractor_id, row.country, row.period_start, row.period_end]); }
  private closure(row: z.infer<typeof rowSchema>) {
    const closed = this.db.prepare("SELECT * FROM billing_closures WHERE id = ?").get(this.periodId(row));
    return closed ? closureSchema.parse(closed) : undefined;
  }
  hasStoredApproval(contractorId: string) {
    const row = this.row(contractorId);
    return Boolean(row && this.closure(row)?.approval_digest);
  }
  private preview(row: z.infer<typeof rowSchema>) {
    const timezone = z.object({ timezone: text }).parse(this.db.prepare("SELECT timezone FROM contractors WHERE id = ?").get(row.contractor_id)).timezone;
    const bounds = periodBounds(row.period_start, row.period_end, timezone);
    const entries = this.db.prepare("SELECT * FROM entries WHERE contractor_id = ? ORDER BY start_ms, id").all(row.contractor_id).map(value => entrySchema.parse(value));
    return { timezone, ...bounds, ...periodValue(entries, bounds), entries };
  }
  isLocked(contractorId: string, start: number, end: number | null) {
    return Boolean(this.db.prepare("SELECT id FROM billing_closures WHERE contractor_id = ? AND closed = 1 AND start_ms < ? AND end_ms > ?")
      .get(contractorId, end ?? Number.MAX_SAFE_INTEGER, start));
  }
  assertUnlocked(contractorId: string, start: number, end: number | null) {
    if (this.isLocked(contractorId, start, end)) throw new Error("This time belongs to a closed period. The owner must reopen it with a reason before changing hours.");
  }
  invalidateApproval(contractorId: string) {
    this.db.prepare("UPDATE billing_closures SET approval_digest = NULL, approved_source = NULL WHERE contractor_id = ?").run(contractorId);
  }
  private pendingClocks(contractorId: string) {
    return Boolean(this.db.prepare("SELECT contractor_id FROM pending_starts WHERE contractor_id = ?").get(contractorId)
      || this.db.prepare("SELECT contractor_id FROM unmatched_stops WHERE contractor_id = ?").get(contractorId)
      || this.db.prepare("SELECT source FROM clock_inbox WHERE contractor_id = ? AND (complete = 0 OR review_reason != '')").get(contractorId));
  }
  private change(contractorId: string, action: string, before: unknown, after: unknown) {
    this.db.prepare("INSERT INTO billing_changes(contractor_id, action, before_json, after_json) VALUES (?, ?, ?, ?)")
      .run(contractorId, action, before === undefined ? null : JSON.stringify(before), JSON.stringify(after));
    this.invalidateApproval(contractorId);
  }
  request(raw: z.infer<typeof billingRequestSchema>) {
    const input = billingRequestSchema.parse(raw);
    if (input.period_end < input.period_start) throw new Error("The billing period ends before it starts.");
    if (input.w9_required && input.country !== "US") throw new Error("W-9 requests require the owner's US request.");
    const before = this.row(input.contractor_id);
    const samePeriod = before?.country === input.country && before.period_start === input.period_start && before.period_end === input.period_end;
    if (before?.invoice_json && !samePeriod) this.db.prepare("INSERT INTO billing_history(contractor_id, invoice_json) VALUES (?, ?)").run(input.contractor_id, before.invoice_json);
    this.db.prepare(`INSERT INTO billing_requests(contractor_id, country, period_start, period_end, w9_required) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contractor_id) DO UPDATE SET country=excluded.country, period_start=excluded.period_start, period_end=excluded.period_end,
      invoice_json=CASE WHEN ? THEN invoice_json ELSE NULL END,
      payment_json=CASE WHEN country=excluded.country THEN payment_json ELSE NULL END,
      tax_document_url=CASE WHEN country=excluded.country THEN tax_document_url ELSE NULL END, w9_required=excluded.w9_required`)
      .run(input.contractor_id, input.country, input.period_start, input.period_end, Number(input.w9_required), Number(samePeriod));
    if (!samePeriod || before?.w9_required !== Number(input.w9_required)) this.change(input.contractor_id, "request", before ? { country: before.country, period_start: before.period_start, period_end: before.period_end } : undefined, input);
    const period = `${input.period_start} a ${input.period_end}`;
    return { ...this.report(input.contractor_id), request_text: input.country === "BR"
      ? `Pode enviar a nota fiscal de ${period}, com link privado, número, valor e moeda (USD ou BRL conforme o acordo)? Para o Pix, envie o nome do titular e um link para um documento privado com a chave, compartilhado apenas com o dono. Não cole a chave no grupo. O dono vai conferir os dados antes de aprovar; isso não envia um pagamento.`
      : `Please send an invoice for ${period}: a private link, number, amount and currency. For ACH, send the beneficiary, bank name, account type, last four digits and a link to the complete instructions shared privately with the owner. Keep the full account/routing numbers out of this group.${input.w9_required ? " Please also share a private W-9 document link; keep tax IDs out of chat." : ""} The owner will check the documents before approving; this does not send a payment.` };
  }
  submit(contractorId: string, input: z.infer<typeof billingSubmissionSchema>) {
    const row = this.row(contractorId);
    if (!row) throw new Error("The owner must request billing documents and confirm your country and period first.");
    let before: unknown, after: unknown;
    switch (input.action) {
      case "invoice":
        if (input.invoice.period_start !== row.period_start || input.invoice.period_end !== row.period_end) throw new Error("The invoice must cover the requested period.");
        if (row.country === "US" && input.invoice.currency !== "USD") throw new Error("The US request uses USD.");
        before = row.invoice_json ? JSON.parse(row.invoice_json) : undefined; after = input.invoice;
        if (row.invoice_json && row.invoice_json !== JSON.stringify(input.invoice)) this.db.prepare("INSERT INTO billing_history(contractor_id, invoice_json) VALUES (?, ?)").run(contractorId, row.invoice_json);
        this.db.prepare("UPDATE billing_requests SET invoice_json = ? WHERE contractor_id = ?").run(JSON.stringify(input.invoice), contractorId); break;
      case "payment_details":
        if ((row.country === "BR") !== (input.payment.method === "pix")) throw new Error("Use Pix for this BR request or ACH for this US request.");
        if (row.payment_json) {
          const previous = storedPaymentSchema.parse(JSON.parse(row.payment_json));
          before = { fingerprint: digest(previous), beneficiary: previous.beneficiary, method: previous.method,
            ...("document_url" in previous ? { document_url: previous.document_url } : "account" in previous ? { account_last4: previous.account.slice(-4) } : { key_masked: `…${previous.key.slice(-4)}` }) };
        }
        after = { fingerprint: digest(input.payment), ...input.payment };
        this.db.prepare("UPDATE billing_requests SET payment_json = ? WHERE contractor_id = ?").run(JSON.stringify(input.payment), contractorId); break;
      case "tax_document":
        if (row.country !== "US" || !row.w9_required) throw new Error("The owner has not requested a US tax document.");
        before = row.tax_document_url; after = input.url;
        this.db.prepare("UPDATE billing_requests SET tax_document_url = ? WHERE contractor_id = ?").run(input.url, contractorId); break;
      default: { const exhaustive: never = input; return exhaustive; }
    }
    const unchanged = input.action === "payment_details" ? row.payment_json === JSON.stringify(input.payment) : JSON.stringify(before) === JSON.stringify(after);
    if (!unchanged) this.change(contractorId, input.action, before, after);
    return this.report(contractorId);
  }
  closePeriod(input: z.infer<typeof billingActions[0]>) {
    const row = this.row(input.contractor_id);
    if (!row) throw new Error("Request an explicit billing period first.");
    if (this.closure(row)?.closed) return this.report(input.contractor_id);
    const { entries, ...preview } = this.preview(row);
    const relevant = entries.filter(e => !e.voided && e.start_ms < preview.end_ms && (e.end_ms === null || e.end_ms > preview.start_ms));
    if (relevant.some(e => e.end_ms === null || needsReview(e))) throw new Error("Resolve open clocks and review long sessions before closing this period.");
    if (this.pendingClocks(row.contractor_id)) throw new Error("Resolve pending clock messages before closing this period.");
    this.assertUnlocked(row.contractor_id, preview.start_ms, preview.end_ms);
    if ((input.brl_amount_cents !== undefined || input.conversion_note !== undefined) && (row.country !== "BR" || !input.brl_amount_cents || !input.conversion_note)) throw new Error("BRL conversion needs the owner's exact amount and conversion note for a BR period.");
    const snapshot = { ...preview, currency: input.brl_amount_cents ? "BRL" : "USD", expected_amount_cents: input.brl_amount_cents ?? preview.amount_usd_cents, conversion_note: input.conversion_note ?? null };
    this.db.prepare(`INSERT INTO billing_closures(id, contractor_id, start_ms, end_ms, closed, snapshot_json) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, closed=1, snapshot_json=excluded.snapshot_json, approval_digest=NULL, approved_source=NULL`)
      .run(this.periodId(row), row.contractor_id, preview.start_ms, preview.end_ms, JSON.stringify(snapshot));
    return this.report(row.contractor_id);
  }
  reopenPeriod(contractorId: string) {
    const row = this.row(contractorId);
    if (!row || !this.closure(row)?.closed) throw new Error("This period is not closed.");
    this.db.prepare("UPDATE billing_closures SET closed = 0, approval_digest = NULL, approved_source = NULL WHERE id = ?").run(this.periodId(row));
    return this.report(contractorId);
  }
  approve(contractorId: string, fingerprint: string, source: string) {
    const report = this.report(contractorId);
    if (!report.ready_for_owner_review || report.fingerprint !== fingerprint) throw new Error("The billing review changed or still has unresolved items. Review the current fingerprint.");
    const row = this.row(contractorId);
    if (!row) throw new Error("Request a billing period first.");
    this.db.prepare("UPDATE billing_closures SET approval_digest = ?, approved_source = ? WHERE id = ? AND closed = 1").run(fingerprint, source, this.periodId(row));
    return this.report(contractorId);
  }
  secrets(contractorId: string, includeDocuments = false): string[] {
    const row = this.row(contractorId);
    if (!row) return [];
    const payment = row.payment_json ? storedPaymentSchema.parse(JSON.parse(row.payment_json)) : null;
    const values = payment && "key" in payment ? [payment.key] : payment && "account" in payment ? [payment.account, payment.routing] : [];
    if (includeDocuments) {
      if (payment && "document_url" in payment) values.push(payment.document_url);
      if (row.invoice_json) values.push(invoiceSchema.parse(JSON.parse(row.invoice_json)).url);
      if (row.tax_document_url) values.push(row.tax_document_url);
      const previous = this.db.prepare(`
        SELECT json_extract(invoice_json, '$.url') AS url FROM billing_history WHERE contractor_id=:id
        UNION ALL SELECT CASE WHEN action='tax_document' THEN json_extract(before_json, '$')
          ELSE COALESCE(json_extract(before_json, '$.url'), json_extract(before_json, '$.document_url')) END
          FROM billing_changes WHERE contractor_id=:id AND action IN ('invoice','payment_details','tax_document')
        UNION ALL SELECT CASE WHEN action='tax_document' THEN json_extract(after_json, '$')
          ELSE COALESCE(json_extract(after_json, '$.url'), json_extract(after_json, '$.document_url')) END
          FROM billing_changes WHERE contractor_id=:id AND action IN ('invoice','payment_details','tax_document')
      `).all({ id: contractorId });
      values.push(...previous.flatMap(record => typeof record.url === "string" ? [record.url] : []));
    }
    return values;
  }
  report(contractorId: string) {
    const row = this.row(contractorId);
    if (!row) return { contractor_id: contractorId, requested: false, paid: false, invoice: null, payment: null, tax_document_url: null,
      ready_for_owner_review: false, fingerprint: null, approved: false, closed: false, expected: null, discrepancy_cents: null };
    const invoice = row.invoice_json ? invoiceSchema.parse(JSON.parse(row.invoice_json)) : null;
    const stored = row.payment_json ? storedPaymentSchema.parse(JSON.parse(row.payment_json)) : null;
    const payment = stored && "document_url" in stored ? stored : stored?.method === "pix" ? { method: "pix", beneficiary: stored.beneficiary, legacy_details: true }
      : stored ? { method: "ach", beneficiary: stored.beneficiary, bank: stored.bank, account_last4: stored.account.slice(-4), legacy_details: true } : null;
    const closure = this.closure(row), closed = Boolean(closure?.closed);
    const expected = closed && closure ? valueSchema.parse(JSON.parse(closure.snapshot_json)) : null;
    const discrepancy = expected && invoice?.currency === expected.currency ? invoice.amount_cents - expected.expected_amount_cents : null;
    const fingerprint = expected ? digest({ expected, invoice, payment, country: row.country, w9_required: row.w9_required, tax_document_url: row.tax_document_url }) : null;
    const pending = this.pendingClocks(contractorId);
    const ready = Boolean(closed && !pending && invoice && payment && "document_url" in payment && discrepancy === 0 && (!row.w9_required || row.tax_document_url));
    return { contractor_id: contractorId, requested: true, country: row.country, period_start: row.period_start, period_end: row.period_end,
      invoice, payment, tax_document_url: row.tax_document_url, w9_required: Boolean(row.w9_required), closed, expected, discrepancy_cents: discrepancy,
      currency_matches: expected ? invoice?.currency === expected.currency : false, unresolved_clocks: pending, ready_for_owner_review: ready, fingerprint,
      approved: Boolean(ready && fingerprint === closure?.approval_digest),
      approval_scope: "ledger_and_document_references", private_document_contents_locked: false, payment_execution_enabled: false,
      payment_version: Number(this.db.prepare("SELECT COUNT(*) AS count FROM billing_changes WHERE contractor_id = ? AND action = 'payment_details'").get(contractorId)?.count ?? 0), paid: false };
  }
}
