# plow-pattern-upgrade

Ours moved to the latest Plow OpenClaw base and the Plow agent pattern, then was
reconsidered from first principles.

- **Kept:** the proven core (the clock ledger, per-worker privacy, billing review, the
  tuned prompt).
- **Fixed:** two dogfooding issues and a live swipe-reply crash.
- **Added:** a proactive loop.
- **Removed:** what owner turns could never do.

Closes #30. Closes #32.

## Closes #30 / #32

**#30: a new contractor's intro promised a setup message that never came.**
- **Status on `main`.** v5.7.11 had already fixed the owner half (the receipt carries
  the hours link and "delivery is unconfirmed"). The contractor half was still open:
  nothing told a new contractor how to log time, so it depended on whatever the model
  wrote in the intro.
- **The fix.**
  - Registration claims one welcome in the same ledger transaction. Ours then posts a
    fixed message in the contractor's language, covering start, break, finish, asking
    for hours, and `/in` and `/out`. It promises nothing further.
  - At most one attempt per group: replays and rate changes send nothing, and an
    uncertain delivery is never resent.
  - Groups that existed before the upgrade are never welcomed.
  - The prompt now keeps the intro to who and why, and promises no other message.
- **Evidence.** Three tests in `tests/hours-delivery.test.ts` (content and language,
  replay, update, a 503, the upgrade path, a new registration in an old group). All
  fail without the change (mutation table below).

**#32: owner-DM replies called routed group context "fake injected text" and
misstated the ledger.**
- **Status on `main`.** v5.7.8 and v5.7.11 had already moved owner-group turns into
  their own session, with a system-level routing prompt and an eval replaying the
  issue's inputs. Only the prompt stood between the model and that commentary.
- **The fix.**
  - The reply guard now recognises commentary on the turn's own context. Such a final
    ends the turn silently, and an explicit send of it is refused.
  - Four of the five replies quoted in the issue passed the old guard. They are now
    tests, verbatim, alongside false-positive cases that must still be delivered (a
    fake invoice, a block of time).
  - A pipeline scenario feeds that reply as the model's final on the owner DM,
    owner-group and contractor routes, and asserts nothing is posted.
  - The owner report now lists `voided_entries`, with the reason and the exact restore
    call. "No open clock" is no longer read as "never clocked in", and the prompt says
    to mention voided entries.
- **Evidence.**
  - `tests/hours-reply.test.ts` (2 tests).
  - `tests/message-delivery.test.ts` (3 route scenarios).
  - `tests/clock-integrity.test.ts` (voided entries and restore).

## First principles: what we kept, what we changed, why

**The job.** The owner has two to five contractors. They need:
- hours they can trust without chasing anyone;
- paperwork ready on payday;
- nothing private crossing between workers.

For the contractor, logging time must cost one text.

**The evidence** (Agent Index, 2026-10-16):
- Ours has 3 users (4 more on the duplicate `plow-hours` listing).
- Measured usage fell from about 4.0M tokens a day (10-07 to 10-10) to 1.8M on 10-14.
- One owner accounts for most of it.
- Meetly, the steadiest agent on the Index, is a proactive loop with runtime-gated
  actions.

Ours, by contrast, only ever answered. It already had a 30-second transport heartbeat
and a ledger with every fact a daily check-in needs.

**Kept, because it is proven** (tested badge, 145 tests at the start, all still passing):
- the SQLite ledger with receipts, audit and recovery;
- the clock flow, including shortcuts;
- one group per worker, with tools scoped to the runtime sender;
- billing approval bound to a fingerprint of exactly what was reviewed;
- money never moves;
- the eval-tuned prompt, with each base safety rule kept as a tested equivalent.

**Changed:**
- **Proactive care, from the ledger, with no model call.** Two messages, both
  deterministic, at most once, and quiet when there is nothing to say:
  - **A nudge for a forgotten clock.** Sent in the contractor's group after ten open
    hours, in their daytime. The evidence is the amount of after-the-fact machinery
    Ours already carries for this problem: unmatched stops, 12-hour reviews and
    reconciliation.
  - **An evening summary in the owner's DM at 19:00.** Today's hours and value, open
    clocks, and what waits on the owner. It is the daily reason to open the chat, and
    the owner can turn it off.
- **The contractor's first message is deterministic** (#30). It is the moment setup
  succeeds or fails.
- **Commentary on routed context can't reach anyone** (#32), and voided entries are
  explicit.
- **Removed what owner turns can't do.** Owner phone turns may only use the hours,
  thread and reply tools, so the advertised Sheets and wiki copies could never be
  written from them. `link_sheet` and `projected` are hidden from the model; the data
  is kept. The README and listing stop promising them.
- **First contact.** When the owner's first text asks for nothing, Ours says in one
  line what to send to add a first worker. This is prompt-only and unverified here.
- **Base `3102992` → `ddbaa6b`.** Brings the base's swipe-reply crash fix. Ours had the
  same crash in its own attention step, which could wedge a contractor's group in a
  replay loop; that is fixed too. Contractor clock messages skip the new burst debounce
  and still run one ordered turn each.

**Not changed, on purpose:**
- **The prompt's wording.** It is tuned by the live-model evals; churning it without
  them would trade proven behaviour for taste.
- **The `plow_hours` description.** About 4,000 characters, sent every turn. Trimming
  it is a proposal below.
- **Assigned work ("demands").** Optional context that some owners use.

**Proposals, argued but not built:**
- **Payday autopilot.** A billing cadence per contractor. On the day, Ours closes the
  period, posts the paperwork request in the group and tells the owner "ready to pay"
  when documents match. It is the highest-value next step. It is not built because it
  changes the billing state machine (closing rules, BR and US documents) and needs owner
  consent and live evals.
- **Owner time zone and language at onboarding.** Instead of the São Paulo default for
  the summary.
- **Move most of the `plow_hours` description into the guide skill.** Prove it with the
  evaluator first.
- **A Friday weekly summary.** Week totals per contractor.

## Changes by area

- **Runtime**
  - `install.mjs` is re-anchored to the new base.
  - Burst-debounce exemption and ordered contractor turns.
  - Null-safe, fail-closed handle checks (`sameHandle`).
  - The swipe-reply shape (`reply_to.message`).
- **New behaviour**
  - `plugin/hours-schedule.ts`: the nudge and the summary, on the heartbeat.
    `PLOW_HOURS_PROACTIVE=0` turns it off.
  - The `settings` owner action.
  - The contractor welcome.
  - The context-commentary guard.
  - `voided_entries` in the owner report.
- **State.** New tables `group_welcomes`, `settings` and `schedule_log`, created on
  boot. Existing volumes are kept and existing groups are marked as already welcomed.
  No existing table changes.
- **Harness.** `npm run check` assembles the image's `/opt/plow` from the pinned base
  source and runs the CI typecheck and the full image suite without Docker.
  `scripts/harness-lib.mjs` holds its pure helpers.
- **Contract** (`tests/repo-contract.test.mjs`, a CI step):
  - The base pin and the prompt and boot fixtures match the pinned commit.
  - The base rules keep their Ours equivalents.
  - Tool names exist.
  - The skill's frontmatter matches its install directory.
  - The image declares its identity.
  - No credentials in Git or the build context.
  - Boot parity with the base.
- **Image.** Explicit `AGENT_RUNTIME`, comments on the pin and bump steps, the trust
  rationale, `USER` before `CMD`, and the license label. `.env` is ignored.
- **Docs.**
  - README: one-tap install first, the "On its own, every day" section, Known
    limitations, the no-Docker check, and the base-bump steps.
  - `REVIEW.md`.
  - `checks/manual-scenarios.md` (24 scenarios).
  - `docs/agent-index.md`.

## Validation

### a. Plow pattern scorecard (PLOW-PATTERN.md §8)

| # | Item | Grade | Evidence |
|---|---|---|---|
| 1 | Base pinned by tag + digest; build downloads pinned and checksummed | PARTIAL | The base pin is enforced by `tests/repo-contract.test.mjs`. `zod@4.6.5` is installed at build by exact version, with no lockfile checksum. |
| 2 | Content only; boot and reporter inherited, or a fixture test keeps the wrapper in step | PASS | Boot-parity test against `tests/fixtures/base-main.ts.txt`. `install.mjs` anchors fail the build when the base moves. The reporter is `startAgentIndex` in `boot/preboot.ts`. |
| 3 | Identity, runtime and trust mode in the image, with the reason | PASS | `Dockerfile` ENV and comment; contract test "the image declares its Index identity…". |
| 4 | Prompt opens with identity; one-line first contact; base contract word for word | PARTIAL | Identity and first contact are in `AGENTS.md`. The base rules are kept as tested equivalents, not word for word: "every base rule Ours relies on…". |
| 5 | One skill per turn type; frontmatter tested | PASS | `skill/SKILL.md` frontmatter is tested. Per-route framing lives in the plugin's system prompts. Proactive turns need no model. |
| 6 | Deterministic logic; atomic, locked, private state; corrupt state throws | PASS | `BEGIN IMMEDIATE` transactions, a 0600 SQLite file, zod-validated rows. `tests/clock-integrity.test.ts`, `tests/recovery.test.ts`. |
| 7 | Untrusted text reaches scripts via files only | N/A | No scripts or shell. Inbound text reaches tools through runtime bindings (`plowHoursClock`), never argv. |
| 8 | Owner gates from runtime context; approvals bound to exact content | PASS | `authorizeHoursOwner` and tool bindings. The billing fingerprint is revoked on any change (`tests/billing-review.test.ts`), and nothing executes on approval. |
| 9 | Uncertain sends never resent; idempotency keys; bounded retries | PASS | The group-creation idempotency key; `DeliveryUnknownError`. The welcome and proactive sends are at most once (`tests/hours-delivery.test.ts`, `tests/proactive.test.ts`). |
| 10 | Latch: discover, retry, one link, never the container | N/A | Ours uses no Mac. The unreachable Sheets and wiki path is removed. |
| 11 | Offline hermetic tests and prompt contract; CI runs them | PASS | `npm run check` (the harness strips ambient `AGENT_*`, `PLOW_*` and `OPENCLAW_*`). CI runs the contract and the in-image suite. |
| 12 | `checks/manual-scenarios.md` | PASS | 24 numbered real-line scenarios. |
| 13 | README order and known limitations; `REVIEW.md` | PASS | `README.md`, `REVIEW.md`. |
| 14 | No secrets or personal data; English; MIT | PASS | Contract test "credentials … never enter Git". English docs. MIT `LICENSE`. The eval QA handles are noted below. |
| 15 | Listing complete and out of WIP | PARTIAL | `ours` is out of WIP. Its `latch` says optional although Ours uses no Mac, and the duplicate `plow-hours` listing still exists (see b). |

**Score: 10 PASS, 3 PARTIAL (items 1, 4 and 15), 2 N/A, 0 FAIL.**

### b. Agent Index publish requirements (§7), read 2026-10-16 with `fresh=1`

| Requirement | `ours` | `plow-hours` | What Enzo must do |
|---|---|---|---|
| MIT license | MIT | same repo | Nothing. |
| Usage reporting | Works: 30.5M tokens, 3 users. `AGENT_ID=ours` is in the image, and boot parity keeps the base reporter. | 25.0M tokens, 4 users, from older images registered under this id. | Nothing. New installs report to `ours`. |
| Out-of-WIP inputs: blessed, video, at least one image, 1-click or install URL | Blessed, deployable and tested (2026-10-06). Video `TLfrcTrz52c`, 4 images. | Not blessed or deployable, so it stays WIP. | Retire `plow-hours`, or point its install URL at the `ours` page. |
| Exactly 4 capabilities | 4 | 4 | Optional: swap "Live timesheet" for the evening summary (see `docs/agent-index.md`). |
| Tools | Plow Chat | Plow Chat | Keep Plow Chat only. |
| Latch | `optional` | `optional` | Set `latch` to `none` on `ours` with the agent-index-client (check its `--help` for the flag). |
| Stories | 3, written about features | 3 | Add first-person stories from real use when you have them, such as the first evening summary or the first payday without digging through messages. |
| Install URL | `#run-locally` | `#run-locally` | Point it at `#install`, which now leads with the one-tap flow. |

**Retire `plow-hours`. Keep `ours`.**

### c. Unverified, and how to verify

| Check | Why it didn't run here | How to verify | Expected |
|---|---|---|---|
| Docker build and in-image suite on Node 26 | No Docker on this Mac. The harness ran the same suite on Node 24.21. | `npm ci --ignore-scripts --no-audit --no-fund && docker build -t plow-hours:test .`, then the `docker run … tsc --noEmit … && node --test /opt/plow/tests/*.test.ts` command from README "Image checks" | tsc clean; 167/167 |
| Offline gateway probe | It needs the real gateway. I tried running it locally: config includes, URI and SQL-parameter paths were mapped, but OpenClaw's SQLite maintenance runs where a preload can't follow. | `docker run --rm --network none plow-hours:test /opt/plow/probe` | Prints `PLOW_HOURS_PROBE_OK`, exit 0 |
| `tests/dev-boundaries.mjs` | It drives Docker containers. | `PLOW_HOURS_TEST_IMAGE=plow-hours:test node tests/dev-boundaries.mjs` | JSON with `"passed":true` for the proxy cases and the evaluator network check; exit 0 |
| No-model evals (`clock_confirmation`, `group_failure`, `tool_protocol`, `routing_regression`) | They boot the real gateway, as the probe does. | `docker run --rm --user root --network none -e PLOW_AGENT_TOKEN=fixture-only -e EVAL_PHASE=clock_confirmation -e EVAL_OUTPUT=/tmp/evidence -v "$PWD/evals:/opt/plow/evals:ro" plow-hours:test node /opt/plow/evals/conversation.mjs`, then the same with each other phase | Exit 0 for each phase |
| Live-model evals, including the new prompt lines (#30 intro, first-contact hint, voided entries, "stop the daily summary") | They need a model credential and usage. | `PLOW_AGENT_TOKEN=… python3 evals/run-suite.py --image plow-hours:test --output ../ours-e2e` | Every phase passes |
| 24 manual scenarios on a real line | They need a line, two phones and a full day (section 6). | `checks/manual-scenarios.md` | Every box checked |
| CI on GitHub | Not pushed (by rule). | Push the branch and open the PR | `image.yml` green on amd64 and arm64: contract, in-image tests, probe, `clock_confirmation`, dev boundaries |
| Tag, release and publish | Not pushed or published (by rule). | `git tag v5.8.0 && git push origin v5.8.0`, then `plow-agents image promote ours ghcr.io/enzotironi/plow-hours@sha256:<digest>` and `plow-agents image show ours` | The release workflow publishes the multi-arch manifest, and `image show` reports the new digest. Bump `compose.yml`'s `v5.7.11` tag in the same release. |

### d. Test inventory

| Suite | Command | Before (`main`'s code, base 3102992) | After |
|---|---|---|---|
| Typecheck (CI's `tsc` on the base tsconfig) | inside `npm test` | clean | clean |
| Image suite (`tests/*.test.ts`) | `npm test` (`node scripts/test-local.mjs`) | 145/145, 17 files | 167/167, 18 files |
| Host suite (`tests/*.test.mjs`: repo contract, harness) | `npm run test:repo` | none | 10/10, 2 files |
| Everything above | `npm run check` | n/a | green |
| `tests/dev-boundaries.mjs` | see c | not run | not run |
| Conversation evaluator | see c | not run | not run |

Where the 22 new image tests are:

| Change | Tests added |
|---|---|
| Swipe-reply and handle-less roster | 1 |
| Debounce and ordering | 1 |
| #30 welcome and upgrade | 3 |
| #32 guard | 2 |
| #32 route scenarios | 3 |
| #32 voided entries | 1 |
| Proactive loop and settings | 10 |
| Fail-closed handles | 1 |

All runs used `env -u AGENT_ID -u BOSS_ID` on Node 24.21, macOS arm64. The "before" column
is `main`'s code run through the harness at commit `8675c8b`.

### Mutation check: every change has a test that fails without it

Each mutation reverts or weakens one change. The named test must fail; the file is then
restored from git. 20/20 were caught.

| Mutation | Caught by |
|---|---|
| Read `reply_to` as the message (the old shape) | group attention uses source participants… |
| `sameHandle` treats a missing handle as comparable | a roster member without a handle matches no one… |
| Contractor messages debounced again | burst debounce merges owner DM bubbles… |
| Contractor turns not awaited | burst debounce merges owner DM bubbles… |
| Harness: builtin SQLite not mapped | the path map puts the image's files… |
| Harness: unpinned base accepted | the harness tests the base the Dockerfile pins… |
| Contract: a base rule's equivalent dropped from `AGENTS.md` | every base rule Ours relies on… |
| Contract: `FROM` pinned by digest only | the base is pinned by immutable tag… |
| Contract: a base boot step removed from `preboot.ts` | Ours' boot keeps every step… |
| #30 welcome never claimed | a new contractor's group gets one how-to… |
| #30 claim not marked as sending | a new contractor's group gets one how-to… |
| #30 upgrade backfill removed | a group set up before the welcome existed… |
| #32 commentary guard removed | owner-group/owner-dm/contractor-group context-commentary |
| #32 `voided_entries` removed | the owner report names voided entries… |
| Proactive claim always succeeds | an open clock is nudged once… |
| Proactive roster check removed | a changed roster gets no nudge… |
| Nudge daytime window removed | an open clock is nudged once… |
| Kill switch removed | PLOW_HOURS_PROACTIVE=0 stops a nudge… |
| Transient failure not released | a server error on the summary… a network failure is retried |
| `link_sheet` offered to the model again | the owner tool offers the summary settings… |

The first run caught 16 of 19, and each survivor had a different cause:

- **At-most-once claim.** The mutation was caught, but by a test named differently from
  the one the runner looked for.
- **Kill switch.** The test passed for the wrong reason: the roster check also blocked
  the send.
- **Upgrade backfill.** It had no test for a new registration in a pre-upgrade group.

The last two were fixed in `9b4d464`. The runner is a local script, not committed.

## Needs Enzo's decision

1. **Release.** Tag v5.8.0 so CI builds, tests and publishes. Then promote the digest
   to `ours`. Running agents stay on the old base and code until then.
2. **The proactive defaults.**
   - The summary is on by default at 19:00 São Paulo time, in the contractors'
     majority language.
   - The nudge comes after 10 hours, between 8:00 and 21:00 local.
   - Existing owners will start getting the summary after upgrading; the first one
     explains how to stop it. Say if you want it off by default instead.
3. **Listing.**
   - Retire `plow-hours`.
   - Set `latch` to `none` on `ours`.
   - Point `install_url` at `#install`.
   - Consider the summary as a capability.
4. **Fallback model cap.** The new base adds `compat.maxTokensField: "max_tokens"` to
   its own models. Ours' GPT 6 Sol fallback has no such compat, so its 128k cap may not
   reach Plow's proxy. I left it unchanged because I couldn't verify how the proxy
   treats `max_tokens` for that reasoning model.
5. **Eval handles.** The evaluator uses `ours-qa-*@icloud.com` handles inside an
   isolated transport. Switch them to `example.test` if they aren't your QA accounts.
6. **Payday autopilot.** The next big step, if you agree with the argument above.
