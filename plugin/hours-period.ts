import { z } from "zod";

export const entrySchema = z.object({
  id: z.string(), contractor_id: z.string(), demand_id: z.string(), start_ms: z.number().int(), end_ms: z.number().int().nullable(),
  rate_cents: z.number().int(), timezone: z.string(), details: z.string(), start_message: z.string(), stop_message: z.string().nullable(),
  voided: z.number().int().min(0).max(1), reviewed: z.number().int().min(0).max(1),
});
export const LONG_SESSION_MS = 12 * 3_600_000;
export const needsReview = (entry: z.infer<typeof entrySchema>) => !entry.voided && !entry.reviewed
  && (entry.end_ms ?? Date.now()) - entry.start_ms > LONG_SESSION_MS;

// Banking instructions belong in a private document, never in work exports.
export function workText(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(/\b(?:chave\s+pix|pix(?:\s+key)?|routing(?:\s+number)?|(?:bank\s+)?account(?:\s+number)?|conta(?:\s+banc[aá]ria)?|ssn|cpf|tax\s+id)\s*[:=][^\r\n]*/gi, "[financial details omitted]")
    .replace(/\b(chave\s+pix|pix\s+key)\s+(?:[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d .()-]{8,20}|[a-f0-9]{8}-[a-f0-9-]{27,})/gi, "$1 [private]")
    .replace(/\b(routing\s+number|account\s+number|ssn|cpf|tax\s+id)\s+\d[\d .-]{3,20}/gi, "$1 [private]");
  for (const secret of secrets) if (secret.length >= 4) result = result.replaceAll(secret, "[private]");
  return result;
}

function dayAt(ms: number, timezone: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function dayBoundary(date: string, timezone: string, mustExist = true): number {
  const center = Date.parse(`${date}T00:00:00Z`);
  let low = center - 36 * 3_600_000, high = center + 36 * 3_600_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dayAt(mid, timezone) < date) low = mid + 1;
    else high = mid;
  }
  if (mustExist && dayAt(low, timezone) !== date) throw new Error("This local calendar date does not exist in the billing timezone.");
  return low;
}

export function periodBounds(start: string, end: string, timezone: string) {
  z.iso.date().parse(start); z.iso.date().parse(end);
  if (end < start) throw new Error("The billing period ends before it starts.");
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start_ms: dayBoundary(start, timezone), end_ms: dayBoundary(next, timezone, false) };
}

export function periodValue(entries: readonly z.infer<typeof entrySchema>[], bounds: { start_ms: number; end_ms: number }) {
  let duration = 0, numerator = 0n;
  const blocks = [];
  for (const entry of entries) {
    if (entry.voided || entry.end_ms === null) continue;
    const start = Math.max(entry.start_ms, bounds.start_ms), end = Math.min(entry.end_ms, bounds.end_ms);
    if (end <= start) continue;
    duration += end - start;
    numerator += BigInt(end - start) * BigInt(entry.rate_cents);
    blocks.push({ entry_id: entry.id, demand_id: entry.demand_id, start_ms: start, end_ms: end, rate_cents: entry.rate_cents });
  }
  // Round cents once, after summing every exact elapsed millisecond in the period.
  const amount = (numerator + 1_800_000n) / 3_600_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(duration)) throw new Error("Billing total exceeds the supported range.");
  return { duration_ms: duration, total_hours: duration / 3_600_000, amount_usd_cents: Number(amount), blocks };
}
