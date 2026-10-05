import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { hoursEnabled, hoursLedger, localTime, type HoursLedger } from "./hours.ts";
import { needsReview, periodBounds } from "./hours-period.ts";

const dateRange = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine(range => !range.from || !range.to || range.from <= range.to, "The end date must be on or after the start date.");

type HoursReport = ReturnType<HoursLedger["report"]>[number];

function webEntries(report: HoursReport, range: z.infer<typeof dateRange>) {
  const from = range.from ? periodBounds(range.from, range.from, report.contractor.timezone).start_ms : -Infinity;
  const to = range.to ? periodBounds(range.to, range.to, report.contractor.timezone).end_ms : Infinity;
  return report.entries.filter(entry => !entry.voided && entry.start_ms < to && (entry.end_ms === null || entry.end_ms > from)).map(entry => {
    const demand = report.demands.find(item => item.id === entry.demand_id);
    if (!demand) throw new Error("Time entry has no demand.");
    const start = entry.end_ms === null ? entry.start_ms : Math.max(entry.start_ms, from);
    const finish = entry.end_ms === null ? null : Math.min(entry.end_ms, to);
    const timezone = range.from || range.to ? report.contractor.timezone : entry.timezone;
    const clipped = start !== entry.start_ms || finish !== entry.end_ms;
    return {
      id: entry.id, demand_id: entry.demand_id, start_ms: start, end_ms: finish,
      timezone, rate_usd: entry.rate_cents / 100, project: demand.project,
      details: [demand.id, demand.summary, demand.references, entry.details,
        clipped ? `Partial session in selected dates. Original: ${localTime(entry.start_ms, entry.timezone)} to ${localTime(entry.end_ms ?? entry.start_ms, entry.timezone)}` : ""].filter(Boolean).join(" | "),
      day: localTime(start, timezone).slice(0, 10),
      start: finish === null ? null : localTime(start, timezone), finish: finish === null ? null : localTime(finish, timezone),
    };
  });
}

export function hoursWebSnapshot(ledger: HoursLedger, rawRange: z.infer<typeof dateRange> = {}) {
  const range = dateRange.parse(rawRange);
  return {
    updated_at: new Date().toISOString(),
    date_range: range,
    contractors: ledger.report().map(report => {
      const { contractor, demands, entries, pending_clock } = report;
      return {
        id: contractor.id, name: contractor.name, timezone: contractor.timezone, rate_usd: contractor.rate_cents / 100,
        projects: [...new Set(demands.map(demand => demand.project))],
        demands: demands.filter(demand => demand.active).map(({ id, project, summary, references }) => ({ id, project, summary, references })),
        active: Boolean(contractor.active), review_needed: entries.some(needsReview) || pending_clock.reviews.length > 0,
        pending_clock: { start: pending_clock.start, timezone: pending_clock.timezone, messages: pending_clock.messages, unmatched_stops: pending_clock.unmatched_stops },
        billing: (() => { const r = ledger.billingReport(contractor.id); return { requested: r.requested, period_start: r.requested ? r.period_start : null, period_end: r.requested ? r.period_end : null, closed: r.closed, approved: r.approved, ready_for_owner_review: r.ready_for_owner_review, unresolved_clocks: Boolean(r.unresolved_clocks), discrepancy_cents: r.discrepancy_cents, expected: r.expected ? { currency: r.expected.currency, amount_cents: r.expected.expected_amount_cents, total_hours: r.expected.total_hours } : null }; })(),
        entries: webEntries(report, range),
      };
    }),
  };
}

function writeHoursData(res: ServerResponse, getLedger: () => HoursLedger, url: URL) {
  try {
    const range = { from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined };
    res.end(JSON.stringify(hoursWebSnapshot(getLedger(), range)));
  } catch (error) {
    res.statusCode = error instanceof z.ZodError ? 400 : 503;
    res.end(JSON.stringify({ error: res.statusCode === 400 ? "Check the date range." : "Timesheet unavailable. Try refreshing again." }));
  }
}

export function createHoursWebHandler(getLedger: () => HoursLedger) {
  const assets = new Map([
    ["/hours", { type: "text/html; charset=utf-8", body: readFileSync(new URL("./hours-web/index.html", import.meta.url)) }],
    ["/hours/app.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("./hours-web/app.js", import.meta.url)) }],
    ["/hours/style.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("./hours-web/style.css", import.meta.url)) }],
    ["/hours/plow-logo.svg", { type: "image/svg+xml", body: readFileSync(new URL("./hours-web/plow-logo.svg", import.meta.url)) }],
    ["/hours/fonts/dm-sans-latin.woff2", { type: "font/woff2", body: readFileSync(new URL("./hours-web/fonts/dm-sans-latin.woff2", import.meta.url)) }],
    ["/hours/fonts/dm-mono-400-latin.woff2", { type: "font/woff2", body: readFileSync(new URL("./hours-web/fonts/dm-mono-400-latin.woff2", import.meta.url)) }],
    ["/hours/fonts/epilogue-latin-500-normal.woff2", { type: "font/woff2", body: readFileSync(new URL("./hours-web/fonts/epilogue-latin-500-normal.woff2", import.meta.url)) }],
  ]);
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Read-only timesheet");
      return;
    }
    const url = new URL(req.url ?? "/", "http://plow.local");
    const path = url.pathname;
    const asset = assets.get(path === "/" || path === "/hours/" ? "/hours" : path);
    if (asset) {
      res.setHeader("Content-Type", asset.type);
      res.end(req.method === "HEAD" ? undefined : asset.body);
    } else if (path === "/hours/data") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (req.method === "HEAD") { res.end(); return; }
      writeHoursData(res, getLedger, url);
    } else { res.statusCode = 404; res.end("Not found"); }
  };
}

export function registerHoursWeb(api: OpenClawPluginApi) {
  if (!hoursEnabled()) return;
  const handler = createHoursWebHandler(hoursLedger);
  api.registerHttpRoute({ path: "/", match: "exact", auth: "gateway", handler });
  api.registerHttpRoute({ path: "/hours", match: "prefix", auth: "gateway", handler });
}
