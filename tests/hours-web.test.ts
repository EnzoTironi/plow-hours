import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HoursLedger } from "../plugin/hours.ts";
import { createHoursWebHandler, hoursWebSnapshot, registerHoursWeb } from "../plugin/hours-web.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "plow-hours-web-"));
  const ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  ledger.manage({ action: "contractor", id: "ana", name: "Ana <script>alert(1)</script>", handle: "+15550000002", chat_uid: "cht_ana", timezone: "America/Sao_Paulo", rate_cents: 3000 }, "profile");
  ledger.manage({ action: "demand", id: "landing", contractor_id: "ana", project: "=1+1", summary: "Landing", references: "https://github.com/example/site/issues/42" }, "demand");
  const clock = (body: string, created_at: string, message_uid: string) => ledger.clock({ line_uid: "line", chat_uid: "cht_ana", handle: "+15550000002", message_uid, body, created_at });
  return { ledger, clock };
}

test("web snapshot keeps captured times and rates while omitting message sources and sender identities", t => {
  const { ledger, clock } = fixture(t);
  clock("comecei landing", "2026-10-02T23:30:00-03:00", "start");
  clock("parei <img src=x onerror=alert(1)>", "2026-10-03T00:30:00-03:00", "stop");
  const snapshot = hoursWebSnapshot(ledger);
  const person = snapshot.contractors[0];
  assert.ok(person);
  assert.equal(person.entries[0]?.day, "2026-10-02");
  assert.equal(person.entries[0]?.finish, "2026-10-03 00:30:00 GMT-3");
  assert.equal(person.entries[0]?.project, "=1+1", "the view uses plain text, not spreadsheet escaping");
  assert.equal(person.entries[0]?.rate_usd, 30);
  assert.match(JSON.stringify(snapshot), /<script>/, "source strings remain data for DOM textContent");
  for (const secret of ["+15550000002", "cht_ana", "start_message", "stop_message", "before_json", "sheet_id"]) assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test("web data reflects a newly closed clock and an owner correction on the next request", async t => {
  const { ledger, clock } = fixture(t);
  const server = createServer(createHoursWebHandler(() => ledger));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  clock("start landing", "2026-10-02T12:00:00Z", "start");
  const open = await fetch(`${base}/hours/data`).then(res => res.json()) as ReturnType<typeof hoursWebSnapshot>;
  assert.equal(open.contractors[0]?.entries[0]?.end_ms, null);
  clock("stop commit abc123", "2026-10-02T14:30:00Z", "stop");
  const response = await fetch(`${base}/hours/data`);
  const closed = await response.json() as ReturnType<typeof hoursWebSnapshot>;
  assert.equal(closed.contractors[0]?.entries[0]?.end_ms, Date.parse("2026-10-02T14:30:00Z"));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const entry = closed.contractors[0]?.entries[0];
  assert.ok(entry);
  ledger.manage({ action: "correct", entry_id: entry.id, start: "2026-10-02T12:00:00Z", finish: "2026-10-02T14:15:00Z", reason: "Owner review" }, "correct");
  const corrected = await fetch(`${base}/hours/data`).then(res => res.json()) as ReturnType<typeof hoursWebSnapshot>;
  assert.equal(corrected.contractors[0]?.entries[0]?.finish, "2026-10-02 11:15:00 GMT-3");
});

test("web routes are read-only, scoped to known assets, and set the browser content policy", async t => {
  const { ledger } = fixture(t);
  const server = createServer(createHoursWebHandler(() => ledger));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ["/hours", "/hours/", "/hours/app.js", "/hours/style.css", "/hours/plow-logo.svg", "/hours/fonts/dm-sans-latin.woff2", "/hours/fonts/dm-mono-400-latin.woff2", "/hours/fonts/epilogue-latin-500-normal.woff2"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    if (path.endsWith(".woff2")) {
      assert.equal(response.headers.get("content-type"), "font/woff2");
      assert.match(response.headers.get("content-security-policy") ?? "", /font-src 'self'/);
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
    }
  }
  const head = await fetch(`${base}/hours/data`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await fetch(`${base}/hours/data`, { method, body: JSON.stringify({ action: "correct" }) });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  assert.equal((await fetch(`${base}/hours/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/hours/../hours.sqlite`)).status, 404);
  assert.equal(ledger.report("ana")[0]?.entries.length, 0);
});

test("the optional timesheet uses gateway authentication for the page, data and assets", () => {
  const previous = process.env.PLOW_HOURS;
  const routes: { auth: string; match: string; path: string }[] = [];
  const api = { registerHttpRoute(route: typeof routes[number]) { routes.push(route); } };
  try {
    delete process.env.PLOW_HOURS;
    registerHoursWeb(api as Parameters<typeof registerHoursWeb>[0]);
    assert.equal(routes.length, 0);
    process.env.PLOW_HOURS = "1";
    registerHoursWeb(api as Parameters<typeof registerHoursWeb>[0]);
    assert.deepEqual(routes.map(({ path, auth, match }) => ({ path, auth, match })), [{ path: "/hours", auth: "gateway", match: "prefix" }]);
  } finally { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; }
});
