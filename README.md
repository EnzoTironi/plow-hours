# Plow Hours

Track contractor hours in the iMessage conversations you already have.

Each contractor gets a group with you and Plow Hours. They tell the agent when
they start, take a break, switch tasks or finish. You get a private view of the
team's hours, the work behind them and the paperwork needed before payday.

[Set up Plow Hours](https://aiworthusing.com/agent-index/plow-hours) ·
[Watch it work](https://youtu.be/hNcJ6omYnWU) ·
[Latest release](https://github.com/EnzoTironi/plow-hours/releases/latest)

**Payments stay manual.** The agent collects documents, checks invoice amounts
against recorded hours and records your approval. It does not move money or mark
an invoice paid.

## A typical workday

Start in your private conversation with the agent:

> Add Alex, alex@example.com, to work on the website's landing page and checkout.
> Create a group with us.

The agent asks for the missing hourly rate and timezone and requests the group.
Assigned work is optional context. Phone numbers and iMessage email
addresses both work. You can include everything upfront, or answer the questions
as they come. Country and billing dates can wait until you want to collect invoices.

Alex records work in that group:

| Message | What happens |
| --- | --- |
| “Starting work now.” | Opens a session immediately and asks for a short overview. |
| “Making an animation for Rowan.” | Records the overview under the original start time. No task approval or prior registration is needed. |
| “Taking a break.” | Closes that session. Break time does not count. |
| “Back on the landing page.” | Opens a new session. |
| “Also fixed checkout validation. Commit abc123.” | Adds a note, keeping the current task and clock open. |
| “Now I'm working on checkout.” | Adds an update to the same open session. |
| “Finished for today.” | Closes the current session and adds its time to recorded hours. |
| “Plow Hours, how many hours have I logged?” | Reports Alex's own recorded work. |

Nobody needs to learn task IDs or a command syntax. Starting work opens the
clock immediately. The description can arrive later without moving its start.
Activity changes add updates to that session; breaks and finishing close it.
The owner reviews hours and billing, without approving each task.

The group is still a place for people to talk. “Alex, can you check the landing
page?” is a message to Alex. The agent stays quiet. It participates when called,
when someone answers its question, or when the contractor clearly submits their
own work or requested documents for recording. Plans, questions and quoted
examples do not start a clock.

Repeat the setup for each contractor. One bot serves the team, with a separate
three-person group for each worker.

The agent tells you when Plow accepts a group or message request and says when
delivery is unconfirmed. A Plow conversation ID does not prove an address has
iMessage or that someone received the introduction. The current integration
does not expose an iMessage availability check or delivery receipts. If a group
does not appear, give the agent the correct iMessage contact or explicitly ask
it to retry. A corrected contact gets a new registration; earlier hours and
billing stay with their original sender.

## Who can see and change what

| Access | Owner, in the private conversation | Contractor, in their own group |
| --- | --- | --- |
| Hours and assigned work | All contractors | Their own records only |
| Clocking and work notes | Reviews records; can correct missed work | Starts, pauses, switches and finishes their own work |
| Rates, tasks and corrections | Sets rates, assigns work and makes corrections with a reason | Cannot change rates or correct recorded intervals |
| Dashboard | Receives the private hours dashboard link | No owner dashboard access |
| Billing | Requests paperwork, closes periods and approves after review | Submits their invoice and requested document references |

Contractors use the agent through their registered group. Administration happens
in the owner's private conversation. If the owner asks for a report, dashboard
or administrative action in a group, the agent handles it in their private
session, posts a short "I'll reply privately" notice in that source group, and
answers in their DM. Private results stay out of the contractor's
conversation and agent history. Human conversation still gets no interruption.
Public guidance for a contractor goes to their group. The owner can ask for it
in that group or privately, and the agent sends it to the intended conversation.
Group messages keep their original chat identity even when private tools process
them, so the agent can distinguish where a request arrived from where it replied.
Live clock reports belong to the worker. The owner can correct their records,
including a missed start, without asking the worker to repeat the clock. If the
worker already sent a finish, the agent uses that saved timestamp and its captured
rate and timezone. The owner only needs to supply the missing start. Corrections
keep their source and reason in the history and never count the same stop twice.
If a stop has no open start or a clock record conflicts, the agent sends the owner
a private request to reconcile it. A saved start and stop can be consolidated
after the owner's confirmation, preserving the original rate and timestamps.
Billing approval requires their review and an actual approval message in the
private conversation.

The tools check the live participants before accessing records. A group must
contain exactly the owner, the registered contractor and the agent, with normal
group permissions. Adding another participant blocks recording until the group
is restored. If a finish was rejected, the clock may still be open. The owner
can correct the actual finish time privately.

## Your team's hours, in one place

Ask “Send me the dashboard” in your private conversation. The agent retrieves
your installation's address and sends the hours panel at `/hours` first. It also
mentions the OpenClaw panel at `/openclaw/`. The root address opens the hours panel.

![The owner timesheet, with contractor and project filters, recorded hours, assigned work and billing status](https://github.com/EnzoTironi/plow-hours/releases/download/v5.6.1/closed-billing-timezone.jpg)

The dashboard is read-only and refreshes every 15 seconds. Filter by contractor,
project and inclusive dates. Running clocks and starts awaiting a task appear
separately from completed hours. Select a contractor to download their timesheet
as a TSV with seven columns:

`Day` · `Start` · `Finish` · `Total (Hours)` · `Rate (USD)` · `Project` · `Details`

Projects, work descriptions, reference links, commits and notes stay with the
entries. Archived tasks leave the assigned work list; their recorded hours and
project filters remain available.

Dates, seconds and timezone offsets are preserved. A date filter counts only
the part of a session inside those dates, using the same calendar boundaries as
billing. Partial sessions retain their original times in Details. A closed
billing period keeps its saved timezone even if the contractor's profile changes.

## From hours to invoice review

When you are ready to bill, tell the agent who the period is for, the inclusive
dates and the contractor's country. It sends the paperwork request in that
person's group.

| Country | Paperwork | Payment instructions |
| --- | --- | --- |
| Brazil | Nota fiscal number, amount, currency and private document link | Beneficiary and a private document containing the Pix key |
| United States | Invoice number, amount, currency and private document link | Beneficiary, bank, account type, last four digits and a private document with full ACH instructions |

Share those documents privately with the owner. Full Pix keys, bank account and
routing numbers, and tax IDs belong in the documents, not the group. A W-9 is
requested only when the owner explicitly asks for it.

Closing the period freezes its hours and value. Open clocks, unresolved clock
events and sessions over 12 hours needing review must be resolved first. Billing
uses exact elapsed time and the rate saved when each session started, rounding
to cents once after adding the period's work. Sessions crossing a date boundary
contribute only the time inside the period.

Rates are set in USD. USD invoices work for both countries. For a Brazilian
invoice in BRL, the owner supplies the converted amount and a conversion note;
the agent does not choose an exchange rate.

The agent compares the invoice amount and currency with the closed value.
Matching metadata and required document references make it ready for your
review. You check document access, contents, beneficiary and payment destination
privately, then explicitly approve in your private conversation.

Approval is tied to that version of the hours and document references. Changing
the invoice, payment instructions or requirements revokes it. If a contractor
changes approved paperwork, the agent queues a private alert for you and retries
failed delivery. Changing closed hours requires reopening the period with a reason.

A saved document link does not verify the document or lock its contents. Check
the instructions again before paying manually, even if the URL stayed the same.

## How the agent works

Plow Hours builds on [Plow OpenClaw](https://github.com/plow-pbc/plow-openclaw-agent).
Plow provides the iMessage line and message transport. The model interprets the
conversation and selects a tool; the tools enforce access and save the records.

```text
iMessage → verified sender and group → model chooses an hours action
                                           ↓
                                  audited SQLite ledger
                                           ↓
                           private reports and web timesheet
```

The ledger is the source of truth. Clock actions use the provider's original
message timestamp and verified sender, not a time or identity chosen by the
model. Records commit before confirmation. Replayed messages and repeated tool
calls cannot create a second entry for the same clock event.

Each contractor has one open session. Activity changes add notes to that session.
An explicit request to split recorded blocks closes one block and opens
the next in one transaction. Work notes preserve the current task and start
time. Rate and timezone changes affect future starts; existing sessions keep
their captured values.

The durable inbox preserves pending messages across restart and retries after
a model outage. A delayed start can pair with an earlier-delivered stop;
conflicting events need owner review. A failed recording is never reported as
saved. Missing historical work requires exact times, the actual historical rate
and an owner correction with a reason. Voiding mistakes retains the audit history.

Owner turns use the management tool; contractor groups receive only the tool
scoped to that person. Generic shell and filesystem tools are disabled. The
agent reads its fixed [operating instructions](skill/SKILL.md) through the guide
action instead of editing records directly.

Time tracking and the web view need neither a connected Mac nor Google Sheets.
Optional Sheets and wiki projections use the owner's Mac through
[Latch](https://github.com/plow-pbc/latch), with a write and readback before a
projection is marked current. Sheets API creation is not included; it needs
backend OAuth permissions outside this repository. Work exports omit stored
financial document links and redact known banking details, but arbitrary
sensitive prose cannot all be recognized. Redaction does not erase messages
already sent. Use private documents from the start.

## Install

For a hosted installation, open [Plow Hours on the Agent Index](https://aiworthusing.com/agent-index/plow-hours)
and use its setup flow. Once it is running, text your agent's line and start with
the first contractor. Ask for the dashboard in your private conversation.

### Run locally

For local development, install Docker with Compose 2.24+, Git, Python 3.11+ and
the [Plow CLI](https://github.com/plow-pbc/plow-agents#1-install-and-log-in).

```sh
git clone https://github.com/EnzoTironi/plow-hours.git
cd plow-hours
plow-agents login
plow-agents profile --show
plow-agents lines
plow-agents deploy --local --line ln_xxx
```

Check that `profile --show` displays the intended account. Replace `ln_xxx` with
a free line from `lines`. Local deploy writes the line-scoped `plow-credentials`
and builds and starts this checkout's Compose stack. `AGENT_ID=plow-hours` is
already set by the image and Compose configuration. Model requests require
available usage on the configured provider.

Text the line, then open [the local timesheet](http://localhost:3331/hours).
The public image supports native AMD64 and ARM64, including Apple Silicon.

**Keep the local dashboard on loopback.** Everyone who can reach it receives
local owner access. Hosted installations use Plow's authenticated owner proxy
on port 3000. The hours volume is bound to its first account owner and line;
another installation needs a fresh volume rather than reusing someone else's records.

## Keep the records safe

The SQLite ledger lives at `/var/lib/plow/plow-hours/hours.sqlite` in the
persistent volume. Keep that volume when restarting or redeploying.

Startup and daily backups use SQLite's live backup API, encrypt snapshots with
AES-256-GCM and retain the latest seven. The default directory is
`/var/lib/plow/plow-hours/backups`; the key is
`/var/lib/plow/plow-hours/backup.key`. Files have private permissions.

Create an additional snapshot:

```sh
docker compose exec agent /opt/plow/hours-backup create \
  /var/lib/plow/plow-hours/backups /var/lib/plow/plow-hours/backup.key \
  /var/lib/plow/plow-hours/hours.sqlite
```

Restore a chosen snapshot to a new, empty directory for recovery:

```sh
docker compose exec agent /opt/plow/hours-backup restore \
  /var/lib/plow/restored-hours /var/lib/plow/plow-hours/backup.key \
  /var/lib/plow/plow-hours/backups/HOURS_SNAPSHOT.enc
```

Replace `HOURS_SNAPSHOT.enc` with the actual filename. Restore does not replace
the live ledger. Copy encrypted snapshots off the host and keep a separate,
protected copy of the key. Local backups cannot recover a lost host or volume;
no off-host destination is configured automatically. Set
`PLOW_HOURS_BACKUP_DIR` to use another mounted backup location.

## Develop and validate

The [image workflow](.github/workflows/image.yml) builds the pinned base, tests
the installed plugin and probes the actual gateway on native AMD64 and ARM64.
Use Node.js 26 for development. To run the installed-image checks locally:

```sh
npm ci --ignore-scripts --no-audit --no-fund
docker build -t plow-hours:test .
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" \
  -v "$PWD/tests:/opt/plow/tests:ro" \
  plow-hours:test sh -c \
  '/opt/plow/node_modules/.bin/tsc --noEmit -p /opt/plow/tsconfig.json && mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test --test-timeout=180000 /opt/plow/tests/*.test.ts'
docker run --rm --network none plow-hours:test /opt/plow/probe
PLOW_HOURS_TEST_IMAGE=plow-hours:test node tests/dev-boundaries.mjs
```

The [tests](tests/) cover identities and permissions, concurrent contractors,
clock replay and recovery, task switches, date boundaries, billing cents,
approval changes and encrypted backup restore. The probe checks authenticated
access to the timesheet, data and assets. Network checks cover the local proxy
and evaluator listener.

The [conversation evaluator](evals/conversation.mjs) exercises the agent with
a real model, its actual tools and an isolated Plow transport and ledger:

```sh
mkdir -p work/evidence
docker run --rm --env-file plow-credentials \
  -v "$PWD/evals:/evals:ro" -v "$PWD/work/evidence:/evidence" \
  --entrypoint node plow-hours:test /evals/conversation.mjs
```

It requires provider credentials and consumes model usage. Add
`-e EVAL_PHASE=group_attention` to test when the agent should reply or stay quiet.
`-e EVAL_PHASE=onboarding_delivery` tests rejected contacts, unconfirmed sends,
missing groups and contact correction through a real model and isolated transport.
`-e EVAL_PHASE=work_overview` tests immediate starts, free-form descriptions,
activity updates and billing without predefined tasks or task approval.
`-e EVAL_PHASE=alder_attention` tests a configured Alder persona with owner and
contractor conversations, quiet human requests, private owner replies and natural clocks.
`-e EVAL_PHASE=alder_reconciliation` tests a worker's stop without a start,
an owner correction using its saved finish, and both people's corrected reports.
`-e EVAL_PHASE=group_failure` tests outage recovery through the actual gateway
using a controlled local model fixture, without external model usage.
These evaluations send no production messages. Live Apple iMessage delivery,
hosted deployment and the chosen off-host backup destination need separate checks.

## Release and publish

This is a Build on Plow agent. The base image's Agent Index client registers the
installation and reports actual OpenClaw usage every five minutes.

A `v*` Git tag triggers the release workflow. After both native platforms pass,
the workflow pushes their images through the official Plow CLI and publishes a
shared public GHCR manifest. Promote that manifest's immutable digest:

```sh
plow-agents image promote plow-hours \
  ghcr.io/enzotironi/plow-hours@sha256:YOUR_RELEASE_DIGEST
plow-agents image show plow-hours
```

Use the real 64-character digest for the release. Promotion updates the image
for new installations; running agents keep their current images. Keep the GHCR
package public. The [Agent Index publishing guide](https://aiworthusing.com/agent-index/publish)
covers initial admission, listing media and hackathon review.

## License and credits

The custom agent code is [MIT licensed](LICENSE). The Plow base and other
dependencies retain their own licenses. [NOTICE](NOTICE) covers the original
Plow logo and trademark.
