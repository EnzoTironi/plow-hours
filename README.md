# Plow Hours

Contractor time tracking through iMessage, with a live timesheet linked to assigned work.

[View the recorded demo and evaluation evidence](https://github.com/EnzoTironi/plow-hours/releases/tag/v2).

Each contractor has a normal iMessage group with the owner and the agent. They
say things like "I’m starting the landing page now", "taking a break" and
"finished for today". The agent identifies the intent and assigned work, asks
when something is ambiguous, and calls the scoped clock tool. Plow Hours saves
the original message timestamp before confirming. No connected Mac is needed. The owner reviews the same durable record at `/hours` on the agent's web
address. Google Sheets and R2 are optional; the web view needs neither.

## Run locally

You need Docker, Git, Python 3.11+ and the
[plow-agents CLI](https://github.com/plow-pbc/plow-agents).

```sh
git clone https://github.com/EnzoTironi/plow-hours.git
cd plow-hours
plow-agents login
plow-agents lines
plow-agents deploy --local --line ln_xxx
```

Choose a free line from `plow-agents lines`; replace `ln_xxx` with its actual ID.
Text that line to check the agent answers. Open
[the local timesheet](http://localhost:3331/hours). Local access is for development:
anyone who can reach this loopback port has the owner's access. Cloud deployments
use Plow's existing authenticated owner proxy on port 3000.

The image includes `AGENT_ID=plow-hours`, the approved name/blurb, and the base
Agent Index reporter. The boot process registers this install and reports actual
OpenClaw token usage every five minutes. Natural conversations use model tokens; optional clock shortcuts do not. Registration and usage reporting require real Plow credentials and an
online connection; the offline probe does not register a fake install.

## Onboard a contractor

In the owner's main Plow DM, provide the contractor's name, international phone
number or iMessage email, timezone, hourly USD rate and assigned work. The agent
verifies the actual thread and sender before registering them. Each assigned
demand has an ID, project, summary and references to tickets or commits.

```text
Ana: Comecei a trabalhar na landing agora
Agent: Ponto iniciado às 2026-10-02 09:00:00 GMT-3, demanda landing. Envie parei quando terminar.
Ana: Terminei por hoje, commit abc123
Agent: Ponto encerrado às 2026-10-02 11:30:00 GMT-3. 2.5 h na demanda landing.
```

Natural language works in Portuguese and English. The agent matches work to
registered demands and asks before an ambiguous start. Negations, questions,
future plans and historical claims do not record hours. Optional `/in <ID>`,
`/out <details>` and `/hours` shortcuts bypass the model. Breaks require stopping
and starting again. A second start or an invalid stop leaves the record unchanged.

The owner can correct a session with exact start/finish times and a reason, or
manually record a missed session with its actual historical rate. Previous values
and original message identities remain in the audit history. Registered clock
messages do not grant contractors general tools or access to other contractors.

The same bot manages many contractors. Each has their own group; the owner has
the consolidated view in the private DM. Natural questions in a group use only
`plow_hours_self` for that contractor's actual demands, hours and document status.
Even the owner has only this scoped access when speaking in a contractor group.
Changing rates, corrections and reports across contractors require the owner's DM.

## Invoices and payment instructions

Confirm each contractor's country and billing period with the owner. Plow Hours
requests documents in that contractor's group: nota fiscal and beneficiary/Pix
key in Brazil; invoice and ACH beneficiary, bank, routing/account numbers and
account type in the US. W-9 information is supplied as a private document link;
the agent does not ask for an SSN in chat.

Collaborators submit their own documents and payment instructions through the
group. The agent records those receipts and returns masked payment details. The
owner can inspect each contractor's billing readiness privately. Financial data
stays outside the hours dashboard, Sheets and wiki. Document links and banking
details are collected for owner review; they are not independently verified.
BRL invoices require the owner's currency/amount review because hourly rates are
in USD. No payment is executed and no invoice is marked paid.

## Timesheet and state

The web view refreshes every 15 seconds. Filter by contractor, project and
inclusive dates; dates use each session's local start date. Closed sessions count
toward recorded totals. Open clocks are shown separately. Each session preserves
the timezone and hourly rate at its start, including rate changes and daylight
saving transitions. Replays and retries cannot create duplicate sessions.

Select a contractor to download their filtered TSV. It has exactly seven columns:
Day, Start, Finish, Total (Hours), Rate (USD), Project and
Details (github ticket, git commit, etc). Start/finish retain dates, seconds and
offsets. Hour exports use six decimal places; totals sum elapsed time before
rounding. There are no billing increment or overtime rules.

The SQLite database is in `/var/lib/plow/plow-hours/hours.sqlite`, within the
existing persistent volume. Back up using SQLite's backup API or while the agent
is stopped, including its WAL. Redeploy without deleting the volume. R2 can be an
off-host backup destination later. The live record stays on the persistent volume.

The operating [skill](skill/SKILL.md) also generates contractor wiki sources and
optional Sheets projections through Latch. It requires write/readback before
marking a destination current. Native Sheets API creation requires backend OAuth
scopes outside this project. Payments remain a later phase.

## Build, check and publish

The Dockerfile pins the official Plow OpenClaw base by digest. `install.mjs`
adds this repository's modules to that exact base and checks each integration
point before patching it. Keep the base boot, owner proxy and usage reporter.

```sh
docker build -t plow-hours:test .
docker run --rm --network none plow-hours:test /opt/plow/probe
npm ci --ignore-scripts --no-audit --no-fund
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" \
  -v "$PWD/tests:/opt/plow/tests:ro" plow-hours:test sh -c \
  '/opt/plow/node_modules/.bin/tsc --noEmit -p /opt/plow/tsconfig.json && mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test --test-timeout=180000 /opt/plow/tests/*.test.ts'
plow-agents image build ghcr.io/enzotironi/plow-hours:v2
plow-agents image push ghcr.io/enzotironi/plow-hours:v2
plow-agents profile --show
```

Make the GHCR package public. Use the digest printed by push, your Plow account
UID and `plow-hours` for the admin's initial one-click admission. Once admitted,
updates use `plow-agents image push ghcr.io/enzotironi/plow-hours:v3 --promote plow-hours`.
Follow the [Agent Index publishing guide](https://aiworthusing.com/agent-index/publish)
for media registration and WIP review.

The published demo and evaluation evidence use fictional contractors and simulated events against
the real ledger/web code. They do not establish live iMessage delivery, actual
Google Sheets/wiki publication or payments. The offline image probe checks the
actual gateway's anonymous rejection, authenticated page/data/assets and rejected
writes. Local clock integration tests use a real SQLite file and transport fixture.

## Evaluate actual conversations

The conversation evaluator boots the built gateway with a simulated Plow
iMessage provider over HTTP/WebSocket, forwards model requests to the real Plow
model API, and runs the actual tools against an isolated database. It sends no
production iMessages and does not register a synthetic Agent Index install.
This requires real Plow credentials and consumes model usage.

```sh
mkdir -p work/evidence
chmod 777 work/evidence
docker run --rm --env-file plow-credentials \
  -v "$PWD/evals:/evals:ro" -v "$PWD/work/evidence:/evidence" \
  --entrypoint node plow-hours:test /evals/conversation.mjs
```

The JSON transcript records real responses, tool calls and assertions for owner
onboarding, two isolated groups, point clocks, unauthorized access, retroactive
corrections, BR/US document collection, payment refusal and unavailable projections.
It validates agent behavior. Delivery through Apple's live iMessage service is
a separate check and needs a sender recognized by the connected Plow account.

Two known clock issues remain: a start clarified in a later message records the
clarification time, and a model API failure can leave a clock message unrecorded
without retry after restart. These need correction before production use.

## License

Custom code in this repository is [MIT licensed](LICENSE). The Plow and OpenClaw
base dependencies retain their own licenses. See [NOTICE](NOTICE) for the original
Plow logo and trademark attribution.
