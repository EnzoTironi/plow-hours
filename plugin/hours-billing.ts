import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const link = z.url().refine(value => new URL(value).protocol === "https:", "Use a private HTTPS document link.");
const date = z.iso.date();
export const billingRequestSchema = z.object({
  action: z.literal("billing_request"), contractor_id: text, country: z.enum(["BR", "US"]),
  period_start: date, period_end: date,
}).strict();
export const billingReportSchema = z.object({ action: z.literal("billing_report"), contractor_id: text }).strict();
export const paymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("pix"), beneficiary: text, key: z.string().trim().min(3).max(140) }).strict(),
  z.object({ method: z.literal("ach"), beneficiary: text, bank: text, routing: z.string().regex(/^\d{9}$/),
    account: z.string().regex(/^\d{4,17}$/), account_type: z.enum(["checking", "savings"]) }).strict(),
]);
const invoiceSchema = z.object({ number: text, url: link, currency: z.enum(["USD", "BRL"]),
  amount_cents: z.number().int().positive().max(1_000_000_000), period_start: date, period_end: date }).strict();
export const billingSubmissionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invoice"), invoice: invoiceSchema }).strict(),
  z.object({ action: z.literal("payment_details"), payment: paymentSchema }).strict(),
  z.object({ action: z.literal("tax_document"), url: link }).strict(),
]);
export const selfSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("report") }).strict(),
  z.object({ action: z.literal("start"), demand_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(),
  z.object({ action: z.literal("clarify_start") }).strict(),
  z.object({ action: z.literal("confirm_start"), demand_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(),
  z.object({ action: z.literal("cancel_start") }).strict(),
  z.object({ action: z.literal("stop"), details: z.string().max(4000).default("") }).strict(),
  ...billingSubmissionSchema.options,
]);
const rowSchema = z.object({ contractor_id: text, country: z.enum(["BR", "US"]), period_start: date,
  period_end: date, invoice_json: z.string().nullable(), payment_json: z.string().nullable(), tax_document_url: z.string().nullable() });

export class HoursBilling {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS billing_requests (
      contractor_id TEXT PRIMARY KEY REFERENCES contractors(id), country TEXT NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, invoice_json TEXT, payment_json TEXT, tax_document_url TEXT
    );
    CREATE TABLE IF NOT EXISTS billing_history (
      seq INTEGER PRIMARY KEY, contractor_id TEXT NOT NULL REFERENCES contractors(id), invoice_json TEXT NOT NULL
    );`);
  }

  private row(contractorId: string) {
    const row = this.db.prepare("SELECT * FROM billing_requests WHERE contractor_id = ?").get(contractorId);
    return row ? rowSchema.parse(row) : undefined;
  }

  request(raw: z.infer<typeof billingRequestSchema>) {
    const input = billingRequestSchema.parse(raw);
    if (input.period_end < input.period_start) throw new Error("The billing period ends before it starts.");
    const before = this.row(input.contractor_id);
    const samePeriod = before?.country === input.country && before.period_start === input.period_start && before.period_end === input.period_end;
    if (before?.invoice_json && !samePeriod) this.db.prepare("INSERT INTO billing_history(contractor_id, invoice_json) VALUES (?, ?)").run(input.contractor_id, before.invoice_json);
    this.db.prepare(`INSERT INTO billing_requests(contractor_id, country, period_start, period_end) VALUES (?, ?, ?, ?)
      ON CONFLICT(contractor_id) DO UPDATE SET country=excluded.country, period_start=excluded.period_start, period_end=excluded.period_end,
      invoice_json=CASE WHEN ? THEN invoice_json ELSE NULL END,
      payment_json=CASE WHEN country=excluded.country THEN payment_json ELSE NULL END`)
      .run(input.contractor_id, input.country, input.period_start, input.period_end, Number(samePeriod));
    const period = `${input.period_start} a ${input.period_end}`;
    return { ...this.report(input.contractor_id), request_text: input.country === "BR"
      ? `Por favor, emita a nota fiscal do período ${period} e envie neste grupo um link privado do documento, número, valor e moeda. Informe também o nome do titular e a chave Pix para preparar o pagamento. Os dados ficam restritos a este colaborador e ao dono. Nenhum pagamento será executado agora.`
      : `Please issue an invoice for ${period} and send a private document link, invoice number, amount and currency in this group. For ACH, provide the beneficiary name, bank name, 9-digit routing number, account number and checking/savings account type. If a W-9 is required, provide a private document link; do not paste a tax ID or SSN into chat. Details are restricted to this contractor and the owner. No payment will be executed yet.` };
  }

  submit(contractorId: string, input: z.infer<typeof billingSubmissionSchema>) {
    const row = this.row(contractorId);
    if (!row) throw new Error("The owner must request billing documents and confirm your country and period first.");
    switch (input.action) {
      case "invoice":
        if (input.invoice.period_start !== row.period_start || input.invoice.period_end !== row.period_end) throw new Error("The invoice must cover the requested period.");
        if (row.country === "US" && input.invoice.currency !== "USD") throw new Error("The US request uses USD.");
        if (row.invoice_json && row.invoice_json !== JSON.stringify(input.invoice)) this.db.prepare("INSERT INTO billing_history(contractor_id, invoice_json) VALUES (?, ?)").run(contractorId, row.invoice_json);
        this.db.prepare("UPDATE billing_requests SET invoice_json = ? WHERE contractor_id = ?").run(JSON.stringify(input.invoice), contractorId);
        break;
      case "payment_details":
        if ((row.country === "BR") !== (input.payment.method === "pix")) throw new Error("Use Pix for this BR request or ACH for this US request.");
        this.db.prepare("UPDATE billing_requests SET payment_json = ? WHERE contractor_id = ?").run(JSON.stringify(input.payment), contractorId);
        break;
      case "tax_document":
        if (row.country !== "US") throw new Error("This request does not ask for a US tax document.");
        this.db.prepare("UPDATE billing_requests SET tax_document_url = ? WHERE contractor_id = ?").run(input.url, contractorId);
        break;
      default: { const exhaustive: never = input; return exhaustive; }
    }
    return this.report(contractorId);
  }

  report(contractorId: string) {
    const row = this.row(contractorId);
    if (!row) return { contractor_id: contractorId, requested: false, paid: false };
    const invoice = row.invoice_json ? invoiceSchema.parse(JSON.parse(row.invoice_json)) : null;
    const payment = row.payment_json ? paymentSchema.parse(JSON.parse(row.payment_json)) : null;
    // Account details never enter model tool results, timesheets or wiki exports.
    const masked = payment?.method === "pix" ? { method: payment.method, beneficiary: payment.beneficiary, key_masked: `…${payment.key.slice(-4)}` }
      : payment ? { method: payment.method, beneficiary: payment.beneficiary, bank: payment.bank, account_type: payment.account_type, account_last4: payment.account.slice(-4) } : null;
    return { contractor_id: contractorId, requested: true, country: row.country, period_start: row.period_start, period_end: row.period_end,
      invoice, payment: masked, tax_document_url: row.tax_document_url, ready_for_owner_review: Boolean(invoice && payment), paid: false };
  }
}
