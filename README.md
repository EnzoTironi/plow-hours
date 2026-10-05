# Plow Hours

Contractor time tracking through iMessage, with a live timesheet linked to assigned work.

[Watch Plow Hours](https://youtu.be/hNcJ6omYnWU) · [Agent Index](https://aiworthusing.com/agent-index/plow-hours)

Each contractor has a group with you and the agent. They say “starting the landing
page now”, “taking a break” or “finished for today”. The LLM understands the
intention and chooses the hours tool. The tool verifies the sender, saves the
original message time and commits the record before confirming. You get the
consolidated view in your private conversation and at `/hours`.

No connected Mac is needed for time tracking. The web view needs neither Google
Sheets nor R2. Sheets and a wiki are optional projections through Latch.

## What you can use it for

- **Clock in without another app.** Start, pause and finish in the group you already use.
- **Keep a few contractors organized.** Each person sees their own work; you see everyone.
- **Remember what the hours were for.** Projects, tickets, commits and notes stay with the time entry.
- **Get the paperwork before payday.** Collect a nota fiscal and private Pix instructions in Brazil, or an invoice and private ACH instructions in the US. Review them before paying.

## Run locally

You need Docker, Git, Python 3.11+ and the [Plow CLI](https://github.com/plow-pbc/plow-agents).

```sh
git clone https://github.com/EnzoTironi/plow-hours.git
cd plow-hours
plow-agents login
plow-agents profile --show
plow-agents lines
plow-agents deploy --local --line ln_xxx
printf '\nAGENT_ID=plow-hours\n' >> plow-credentials
docker compose up -d
```

Choose a free line from `plow-agents lines` and replace `ln_xxx` with its ID. Check
the account shown by `profile --show` before deploying. Text the line, then open
[the local timesheet](http://localhost:3331/hours). This loopback address grants
owner access to local visitors and is for development. Keep it bound to loopback.
Cloud deployments use Plow’s authenticated owner proxy on port 3000; the image
accepts only the installation’s owner identity.
Ask for the dashboard in your private conversation. The agent sends your hours
panel at `/hours` first and mentions the OpenClaw panel available at `/openclaw/`.
It gets both addresses from your current installation. The root address also
opens the hours panel.

The persistent hours volume is bound to its first Plow owner and line. Boot
refuses a different account or line rather than sharing the old owner’s records.
Use a new volume for another installation; preserve the original for recovery.

## Onboard and record work

Send the owner DM a name, international phone number or iMessage email, timezone,
hourly USD rate and assigned work. The agent creates or verifies a normal group
containing exactly you, that contractor and the agent. Each contractor gets their
own group. Their requests cannot change rates, correct hours, approve invoices,
see other contractors or open your dashboard. Owner messages in a contractor
group can only read that person’s report; administration belongs in the private DM.

Portuguese and English work naturally. Nobody needs to memorize task IDs or
commands. Clear starts and stops change the clock. Work updates use an annotation:
“also fixed the checkout, commit abc123” preserves the running clock’s time and
task. Mentioning another task alone does not stop it or block billing. An explicit
switch ends the old task and starts the new one atomically at the same time.
Breaks close one block; resuming opens another.

When a start needs a task clarification, the first message’s time and rate are
saved before the question. The answer selects the task without moving the start
forward. Questions, negations, plans, quotations and historical claims do not
clock work. Optional `/in <task>`, `/out <notes>` and `/hours` shortcuts skip the
model. All routes share the same verified identities and replay protection.

An early-delivered stop can pair with its delayed start. Conflicting timestamps
are preserved for owner review rather than silently inventing an interval. If the
model fails, the durable inbox survives restart and retries with the original
sender, time and rate after the provider cooldown. A failure notice never claims
that hours were recorded.

In the private DM, you can correct times or the task, void an accidental entry,
record a missed session with its actual historical rate, archive a task or
deactivate a departed contractor. Changes require a reason and retain the old
record in the audit history. Sessions over 12 hours require owner review before
billing. These actions never run a payment.

## Review billing

Tell the agent the contractor’s country and inclusive billing dates. It requests
the invoice/nota fiscal and a link to private payment instructions shared with
you. Pix uses the beneficiary and document link. ACH also records the bank,
account type and last four digits. Full Pix keys, account/routing numbers and tax
IDs stay in the private document. W-9 is requested only when you explicitly ask
for it; nationality does not determine a tax requirement.

Close the period after resolving open clocks and pending time issues. The ledger
splits blocks at period boundaries in the contractor’s timezone, uses each
block’s captured rate and rounds cents once after adding the exact elapsed time.
Closed hours cannot change until you reopen the period with a reason. A BRL
amount requires your explicit converted amount and a conversion note; the agent
does not invent an exchange rate.

The agent compares the invoice’s amount and currency with that closed value.
Matching metadata and required document links make it ready for your review.
Check document access, contents, beneficiary and destination privately, then say
that you approve in your private conversation. The LLM selects the approval tool;
the tool binds approval to the unchanged ledger and document references. Any
change to invoice, payment instructions or requirements revokes the approval.
Late conflicting clock events also require review before approval.

Document links are receipts, not independent verification. Their contents can
change without the URL changing: check the instructions again when paying
manually. Automated transfers will need an immutable provider-verified payee and
an approval bound to the exact transfer. This version neither sends money nor
marks an invoice paid. Generic shell and filesystem tools are disabled in the
agent, including owner turns; operating instructions use the fixed `guide` action.

## Timesheet and recovery

The read-only dashboard refreshes every 15 seconds. Filter by person, project and
inclusive session-start dates, then download a TSV. It retains the seven columns:
Day, Start, Finish, Total (Hours), Rate (USD), Project and Details. Dates, seconds
and offsets are preserved. Closed, non-voided entries count toward totals;
open clocks are separate. Billing periods use elapsed-time clipping, while the
dashboard’s date filter uses each session’s local start date.

Rate and timezone changes affect future starts. Work exports omit known banking
values and financial document references; labelled banking notes are redacted.
This precaution cannot recognize all sensitive prose, and messages can remain in
the provider’s history. Use private documents from the beginning.

The ledger lives at `/var/lib/plow/plow-hours/hours.sqlite` in the existing volume.
Redeploy without deleting that volume. Startup and daily backups use SQLite’s live
backup API, encrypt with AES-256-GCM and retain seven snapshots. Defaults are
`plow-hours/backups/` and `plow-hours/backup.key`, with private permissions.

```sh
docker compose exec agent /opt/plow/hours-backup create \
  /var/lib/plow/plow-hours/backups /var/lib/plow/plow-hours/backup.key \
  /var/lib/plow/plow-hours/hours.sqlite
# Restore to a new, empty directory; never overwrite a running ledger.
docker compose exec agent /opt/plow/hours-backup restore \
  /var/lib/plow/restored-hours /var/lib/plow/plow-hours/backup.key \
  /var/lib/plow/plow-hours/backups/HOURS_SNAPSHOT.enc
```

Local snapshots do not protect against losing the host or volume. Copy encrypted
snapshots off-host and keep a separate protected copy of the key; losing the key
makes recovery impossible. `PLOW_HOURS_BACKUP_DIR` can target another mounted
location. No cloud backup destination is configured automatically.

The [operating skill](skill/SKILL.md) covers optional Sheets/wiki synchronization.
Neither projection is declared complete before actual write and readback.
Google Sheets API creation still depends on backend OAuth permissions outside
this repository.

## Validate and publish

```sh
npm ci --ignore-scripts --no-audit --no-fund
docker build -t plow-hours:test .
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" -v "$PWD/tests:/opt/plow/tests:ro" \
  plow-hours:test sh -c '/opt/plow/node_modules/.bin/tsc --noEmit -p /opt/plow/tsconfig.json && mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test --test-timeout=180000 /opt/plow/tests/*.test.ts'
docker run --rm --network none plow-hours:test /opt/plow/probe
PLOW_HOURS_TEST_IMAGE=plow-hours:test node tests/dev-boundaries.mjs
```

Tests run against the installed image: verified roles, clock replays and recovery,
atomic switches, concurrent contractors, calendar boundaries, cents, closure and
approval, legacy migration and authenticated backup restore. The probe starts
the actual gateway and checks owner-only access for the page, data and assets.
Network checks run the pinned Caddy proxy and evaluator’s actual loopback listener.

The [conversation evaluator](evals/conversation.mjs) uses a real model with an
isolated Plow transport fixture and ledger. It records responses, actual tool
calls and assertions, without sending production messages or registering a fake
Agent Index install. It consumes model usage and requires Plow credentials.

```sh
mkdir -p work/evidence
docker run --rm --env-file plow-credentials \
  -v "$PWD/evals:/evals:ro" -v "$PWD/work/evidence:/evidence" \
  --entrypoint node plow-hours:test /evals/conversation.mjs
```

A full contractor conversation through Apple’s live iMessage service is a
separate delivery check with the real contractor identity. Fixture success does
not prove Apple delivery. Cloud deployment and the chosen off-host backup
destination also need their own checks.

The public image includes native AMD64 and ARM64 variants. Docker selects the
host's architecture, including Apple Silicon; OpenClaw's filesystem maintenance
needs native system calls and must not run through Rosetta emulation.

This image uses Build on Plow. Its base reporter registers the installation and
reports actual OpenClaw usage every five minutes. A public `v*` tag publishes
only after the pinned-image checks pass on both architectures, using the official
Plow image push CLI for each variant and publishing their shared manifest.
Follow the [Agent Index publishing guide](https://aiworthusing.com/agent-index/publish)
for first-time 1-click admission and hackathon review. Later admitted updates use
`plow-agents image push IMAGE --promote plow-hours`. Keep the image public and the
installation’s Agent Index ID across restarts.

## License

Custom code is [MIT licensed](LICENSE). Base dependencies retain their own
licenses. [NOTICE](NOTICE) covers the original Plow logo and trademark.
