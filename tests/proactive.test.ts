import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HoursLedger, OPEN_CLOCK_NUDGE_MS } from "../plugin/hours.ts";

// Proactive care is computed from the ledger with an explicit clock, so these tests never
// depend on when they run.
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hours-proactive-"));
  const ledger = new HoursLedger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  const register = (id: string, timezone: string, language: "en" | "pt" = "en", rate_cents = 3000) =>
    ledger.manage({ action: "contractor", id, name: id[0]!.toUpperCase() + id.slice(1), handle: `${id}@example.test`, chat_uid: `cht_${id}`, timezone, rate_cents, language }, `register-${id}`);
  const clock = (id: string, uid: string, at: string, kind: "start" | "stop", detail = "") =>
    ledger.clock({ line_uid: "ln_test", chat_uid: `cht_${id}`, handle: `${id}@example.test`, message_uid: uid, created_at: at, body: "" }, { kind, detail });
  return { ledger, register, clock };
}

test("an open clock is nudged once, after ten hours, only in the contractor's daytime", t => {
  const { ledger, register, clock } = fixture(t);
  register("ana", "America/Sao_Paulo");
  clock("ana", "start", "2026-10-02T09:00:00-03:00", "start", "landing");
  const start = Date.parse("2026-10-02T09:00:00-03:00");
  assert.deepEqual(ledger.dueOpenClockNudges(start + OPEN_CLOCK_NUDGE_MS - 60_000), [], "Not before ten hours");
  const due = ledger.dueOpenClockNudges(start + OPEN_CLOCK_NUDGE_MS);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.contractor.id, "ana");
  assert.equal(due[0]!.start_ms, start);
  // 19:00 in São Paulo is daytime; 23:30 is not, and the nudge waits for the morning.
  assert.deepEqual(ledger.dueOpenClockNudges(Date.parse("2026-10-02T23:30:00-03:00")), []);
  assert.equal(ledger.dueOpenClockNudges(Date.parse("2026-10-03T08:00:00-03:00")).length, 1);
  assert.equal(ledger.claimScheduled("open_clock", due[0]!.entry_id), true);
  assert.equal(ledger.claimScheduled("open_clock", due[0]!.entry_id), false, "At most one nudge per entry");
  assert.deepEqual(ledger.dueOpenClockNudges(start + OPEN_CLOCK_NUDGE_MS), []);
});

test("closed, voided and deactivated clocks are never nudged", t => {
  const { ledger, register, clock } = fixture(t);
  register("ana", "UTC"); register("ben", "UTC"); register("cid", "UTC");
  clock("ana", "a1", "2026-10-02T08:00:00Z", "start"); clock("ana", "a2", "2026-10-02T09:00:00Z", "stop");
  clock("ben", "b1", "2026-10-02T08:00:00Z", "start");
  ledger.manage({ action: "void", entry_id: ledger.report("ben")[0]!.open_entry!.id, reason: "Started by mistake" }, "void-ben");
  clock("cid", "c1", "2026-10-02T08:00:00Z", "start"); clock("cid", "c2", "2026-10-02T08:30:00Z", "stop");
  ledger.manage({ action: "deactivate", contractor_id: "cid", reason: "Contract ended" }, "deactivate-cid");
  assert.deepEqual(ledger.dueOpenClockNudges(Date.parse("2026-10-02T20:00:00Z")), []);
});

test("the nudge text is truthful in the contractor's language and promises nothing Ours cannot do", t => {
  const { ledger, register, clock } = fixture(t);
  register("ana", "America/Sao_Paulo", "pt");
  register("ben", "America/New_York", "en");
  clock("ana", "a1", "2026-10-02T08:05:00-03:00", "start");
  clock("ben", "b1", "2026-10-02T08:05:00-04:00", "start");
  const now = Date.parse("2026-10-02T18:30:00-03:00");
  const pt = ledger.openClockNudgeText("ana", "Dane", now);
  assert.match(pt, /desde 8:05/); assert.match(pt, /10 h 25 min/); assert.match(pt, /Dane/); assert.match(pt, /\/out/);
  const en = ledger.openClockNudgeText("ben", "Dane", now);
  assert.match(en, /since 8:05/); assert.match(en, /9 h 25 min/); assert.match(en, /\/out/);
  for (const text of [pt, en]) assert.doesNotMatch(text, /I'll ask|vou pedir|I will ask/i, "Ours cannot message the owner from a contractor turn");
});

test("the owner's daily summary arrives once each evening, with today's hours, open clocks and what needs them", t => {
  const { ledger, register, clock } = fixture(t);
  register("ana", "America/Sao_Paulo", "en", 2000);
  register("ben", "America/Sao_Paulo", "en", 3000);
  clock("ana", "a1", "2026-10-02T09:00:00-03:00", "start", "landing");
  clock("ana", "a2", "2026-10-02T12:30:00-03:00", "stop");
  clock("ben", "b1", "2026-10-02T14:10:00-03:00", "start", "checkout");
  clock("ben", "b-stray", "2026-10-02T15:00:00-03:00", "stop");
  clock("ben", "b-unmatched", "2026-10-02T16:00:00-03:00", "stop");
  assert.equal(ledger.dailySummary(Date.parse("2026-10-02T18:59:00-03:00")), undefined, "Not before 19:00 in the summary timezone");
  const summary = ledger.dailySummary(Date.parse("2026-10-02T19:05:00-03:00"));
  assert.ok(summary?.text);
  assert.equal(summary.key, "2026-10-02");
  assert.match(summary.text, /Ana: 3 h 30 min \(USD 70\.00\)/);
  assert.match(summary.text, /Ben: 50 min \(USD 25\.00\)/);
  assert.match(summary.text, /finish without a start/);
  assert.match(summary.text, /stop the daily summary/, "The first summary says how to turn it off");
  assert.equal(ledger.claimScheduled("summary", summary.key), true);
  assert.equal(ledger.dailySummary(Date.parse("2026-10-02T21:00:00-03:00")), undefined, "Once a day");
  clock("ben", "b2", "2026-10-03T10:00:00-03:00", "start");
  const next = ledger.dailySummary(Date.parse("2026-10-03T19:30:00-03:00"));
  assert.match(next?.text ?? "", /Ben: clock running since/);
  assert.doesNotMatch(next?.text ?? "", /stop the daily summary/, "The off switch is explained once");
});

test("a quiet day sends nothing, Portuguese teams get Portuguese, and the owner can turn it off or move it", t => {
  const { ledger, register, clock } = fixture(t);
  register("ana", "America/Sao_Paulo", "pt");
  assert.deepEqual(ledger.dailySummary(Date.parse("2026-10-02T19:05:00-03:00")), { key: "2026-10-02" }, "Nothing to say: no text");
  clock("ana", "a1", "2026-10-03T09:00:00-03:00", "start");
  clock("ana", "a2", "2026-10-03T10:00:00-03:00", "stop");
  assert.match(ledger.dailySummary(Date.parse("2026-10-03T19:05:00-03:00"))?.text ?? "", /Horas de hoje/);
  ledger.manage({ action: "settings", summary_language: "en", summary_timezone: "America/New_York" }, "settings-move");
  assert.equal(ledger.dailySummary(Date.parse("2026-10-03T19:05:00-03:00")), undefined, "18:05 in New York is not evening yet");
  assert.match(ledger.dailySummary(Date.parse("2026-10-03T19:05:00-04:00"))?.text ?? "", /Today's hours/);
  ledger.manage({ action: "settings", daily_summary: false }, "settings-off");
  assert.equal(ledger.dailySummary(Date.parse("2026-10-04T20:00:00-04:00")), undefined);
  assert.deepEqual(ledger.settings(), { daily_summary: false, summary_timezone: "America/New_York", summary_language: "en" });
  assert.throws(() => ledger.manage({ action: "settings", summary_timezone: "Mars/Olympus" }, "settings-bad"), /time zone/);
});

import { hoursLedger } from "../plugin/hours.ts";
import { runHoursSchedule } from "../plugin/hours-schedule.ts";
import { websocketFixture } from "./ws-fixture.ts";

const owner = { type: "member", uid: "owner", role: "owner", display_name: "Dane", provider_key: "+15550000001" };
const ana = { type: "member", uid: "ana", role: "member", display_name: "Ana", provider_key: "ana@example.test" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const home = { uid: "cht_home", status: "active", trusted: false, participants: [owner, self] };
const group = { uid: "cht_ana", status: "active", trusted: false, participants: [owner, ana, self] };
const account = { accountId: "chat", apiBase: "http://fixture", lineUid: "line" };

async function heartbeatFixture(t: TestContext, roster = group, failPosts: number[] = []) {
  await websocketFixture(t);
  const previous = process.env.PLOW_HOURS;
  process.env.PLOW_HOURS = "1";
  t.after(() => { if (previous === undefined) delete process.env.PLOW_HOURS; else process.env.PLOW_HOURS = previous; });
  hoursLedger().manage({ action: "contractor", id: "ana", name: "Ana", handle: ana.provider_key, chat_uid: group.uid, timezone: "America/Sao_Paulo", rate_cents: 3000, language: "en" }, "register");
  hoursLedger().clock({ line_uid: "line", chat_uid: group.uid, handle: ana.provider_key, message_uid: "start", created_at: "2026-10-02T08:30:00-03:00", body: "" }, { kind: "start", detail: "landing" });
  const posts: { chat: string; body: string }[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls++;
    const posted = path.match(/^\/v1\/chats\/([^/]+)\/messages$/);
    if (posted && init.method === "POST") {
      posts.push({ chat: posted[1]!, body: JSON.parse(String(init.body)).body });
      const status = failPosts.shift();
      return status ? new Response("unavailable", { status }) : Response.json({ uid: `msg_${posts.length}` });
    }
    if (path === "/v1/agents/me") return Response.json({ line: { uid: "line" } });
    if (path === "/v1/auth/owner-uid") return Response.json({ owner_uid: "owner-account" });
    if (path === "/v1/chats") return Response.json({ data: [home, roster], has_more: false });
    if (path === `/v1/chats/${home.uid}`) return Response.json(home);
    if (path === `/v1/chats/${group.uid}`) return Response.json(roster);
    assert.fail("Unexpected provider request: " + url);
  });
  return { posts, calls: () => calls };
}

test("the heartbeat nudges in the contractor's own group and summarises in the owner DM, each exactly once", async t => {
  const { posts, calls } = await heartbeatFixture(t);
  const evening = Date.parse("2026-10-02T19:10:00-03:00");
  await runHoursSchedule(account, evening);
  assert.deepEqual(posts.map(post => post.chat), [group.uid, home.uid]);
  assert.match(posts[0]!.body, /running since 8:30/); assert.match(posts[0]!.body, /Dane/);
  assert.match(posts[1]!.body, /Ana: clock running since 8:30/);
  assert.doesNotMatch(posts[1]!.body, /ana@example\.test/, "The summary names people, not their handles");
  const before = calls();
  await Promise.all([runHoursSchedule(account, evening + 30_000), runHoursSchedule(account, evening + 30_000)]);
  assert.equal(posts.length, 2, "Nothing is sent twice, even by overlapping heartbeats");
  assert.equal(calls(), before, "A heartbeat with nothing due makes no request");
});

test("a changed roster gets no nudge, and a refused nudge is not retried", async t => {
  const crowded = { ...group, participants: [owner, ana, { ...ana, uid: "eve", display_name: "Eve", provider_key: "eve@example.test" }, self] };
  const { posts } = await heartbeatFixture(t, crowded);
  const morning = Date.parse("2026-10-02T18:40:00-03:00");
  await runHoursSchedule(account, morning);
  assert.equal(posts.length, 0, "Nobody else in the group may see the contractor's clock");
  await runHoursSchedule(account, morning + 60_000);
  assert.equal(posts.length, 0, "A refused nudge is not retried");
});

test("a server error on the summary is recorded as uncertain and not resent; a network failure is retried", async t => {
  const { posts } = await heartbeatFixture(t, group, [503]);
  hoursLedger().clock({ line_uid: "line", chat_uid: group.uid, handle: ana.provider_key, message_uid: "stop", created_at: "2026-10-02T12:00:00-03:00", body: "" }, { kind: "stop", detail: "" });
  const evening = Date.parse("2026-10-02T19:10:00-03:00");
  await runHoursSchedule(account, evening);
  assert.equal(posts.length, 1, "Only the summary was due, and its POST failed with 503");
  assert.equal(hoursLedger().claimScheduled("summary", "2026-10-02"), false, "The 503 left the day's summary recorded, not released");
  await runHoursSchedule(account, evening + 30_000);
  assert.equal(posts.length, 1, "An uncertain summary is never sent again");
  const fetches = (globalThis.fetch as unknown as { mock: { restore(): void } }).mock;
  fetches.restore();
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  hoursLedger().clock({ line_uid: "line", chat_uid: group.uid, handle: ana.provider_key, message_uid: "start-2", created_at: "2026-10-03T09:00:00-03:00", body: "" }, { kind: "start", detail: "" });
  await runHoursSchedule(account, Date.parse("2026-10-03T19:10:00-03:00"));
  assert.ok(hoursLedger().claimScheduled("summary", "2026-10-03"), "A network failure before sending leaves the day's summary unclaimed for the next heartbeat");
});

test("the owner tool offers the summary settings and never the unreachable sheet projections", async t => {
  await heartbeatFixture(t);
  const { default: entry } = await import("./ours-entry.ts");
  let parameters: unknown;
  entry.register({ registrationMode: "full", on() {}, logger: { info() {} }, registerChannel() {}, registerHttpRoute() {}, runtime: {},
    registerTool(factory: (context: object) => { name: string; parameters: typeof parameters }) {
      const tool = factory({ sessionKey: "agent:main:main", messageChannel: "plow", agentAccountId: "chat", senderIsOwner: true });
      if (tool.name === "plow_hours") parameters = tool.parameters;
    } } as never);
  const actions = [...JSON.stringify(parameters).matchAll(/"action":\{"type":"string","const":"([a-z_]+)"\}/g)].map(match => match[1]);
  assert.ok(actions.length > 10, JSON.stringify(parameters).slice(0, 300));
  assert.ok(actions.includes("settings") && actions.includes("contractor"));
  assert.ok(!actions.includes("link_sheet") && !actions.includes("projected"));
});

test("PLOW_HOURS_PROACTIVE=0 stops a nudge that would otherwise go out", async t => {
  const { posts } = await heartbeatFixture(t);
  const due = Date.parse("2026-10-02T18:40:00-03:00");
  process.env.PLOW_HOURS_PROACTIVE = "0";
  t.after(() => { delete process.env.PLOW_HOURS_PROACTIVE; });
  await runHoursSchedule(account, due);
  assert.equal(posts.length, 0, "The kill switch sends nothing");
  delete process.env.PLOW_HOURS_PROACTIVE;
  await runHoursSchedule(account, due);
  assert.equal(posts.length, 1, "The same nudge goes out once the switch is off");
});
