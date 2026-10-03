import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { hoursEnabled, hoursLedger, type HoursLedger } from "./hours.ts";

export function hoursWebSnapshot(ledger: HoursLedger) {
  return {
    updated_at: new Date().toISOString(),
    contractors: ledger.report().map(({ contractor, demands, entries, sheet }) => {
      let closedIndex = 0;
      return {
        id: contractor.id, name: contractor.name, timezone: contractor.timezone, rate_usd: contractor.rate_cents / 100,
        demands: demands.map(({ id, project, summary, references }) => ({ id, project, summary, references })),
        entries: entries.map(entry => {
          const demand = demands.find(item => item.id === entry.demand_id);
          if (!demand) throw new Error("Time entry has no demand.");
          const row = entry.end_ms === null ? null : sheet.values[++closedIndex];
          return {
            id: entry.id, demand_id: entry.demand_id, start_ms: entry.start_ms, end_ms: entry.end_ms,
            timezone: entry.timezone, rate_usd: entry.rate_cents / 100, project: demand.project,
            details: [demand.id, demand.summary, demand.references, entry.details].filter(Boolean).join(" | "),
            day: row ? String(row[0]) : new Intl.DateTimeFormat("sv-SE", { timeZone: entry.timezone }).format(entry.start_ms),
            start: row ? String(row[1]) : null, finish: row ? String(row[2]) : null,
          };
        }),
      };
    }),
  };
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
    const path = new URL(req.url ?? "/", "http://plow.local").pathname;
    const asset = assets.get(path === "/hours/" ? "/hours" : path);
    if (asset) {
      res.setHeader("Content-Type", asset.type);
      res.end(req.method === "HEAD" ? undefined : asset.body);
    } else if (path === "/hours/data") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (req.method === "HEAD") { res.end(); return; }
      try { res.end(JSON.stringify(hoursWebSnapshot(getLedger()))); }
      catch { res.statusCode = 503; res.end(JSON.stringify({ error: "Timesheet unavailable. Try refreshing again." })); }
    } else { res.statusCode = 404; res.end("Not found"); }
  };
}

export function registerHoursWeb(api: OpenClawPluginApi) {
  if (!hoursEnabled()) return;
  api.registerHttpRoute({ path: "/hours", match: "prefix", auth: "gateway", handler: createHoursWebHandler(hoursLedger) });
}
