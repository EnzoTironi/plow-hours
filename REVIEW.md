# Review instructions: plow-hours (Ours)

Repo-specific reviewer policy. `README.md` owns the product prose; flag drift between
it and the code in either direction.

## What this repo is

**One agent.** Ours tracks contractor hours in iMessage groups and keeps the timesheet
and invoice paperwork for one owner. It is a prompt (`AGENTS.md`), one skill
(`skill/SKILL.md`), the hours plugin (`plugin/hours*.ts`, `plugin/ours.ts`), the
patches `install.mjs` applies to the base Plow channel, a boot wrapper
(`boot/preboot.ts`, `boot/ours-config.ts`) and encrypted backups (`backup.mjs`), on a
pinned `plow-pbc/plow-openclaw-agent` base.

**Stage:** pre-PMF, a handful of installs, each one owner's ledger on their own line.
The ledger holds other people's hours, rates and payment details (Pix keys, ACH
numbers), so a real person's handle, payment data or chat id anywhere in the tracked
tree is blocking, fixtures included. Use `example.test` addresses, `+1555…` numbers,
or the evaluator's dedicated `ours-qa-*` handles.

## Review priority

Subtractive remedies outrank additive ones. These gates come first:

- **Money never moves.** Ours records documents and the owner's approval of an exact
  billing fingerprint. Block any path that sends a payment, marks an invoice paid, or
  keeps an approval after the reviewed data changed.
- **A worker sees only their own records.** Contractor turns get `plow_hours_self`
  only, scoped to the verified group. Identity and clock time come from the runtime
  binding of the inbound message, never from model arguments. Block a change that lets
  a model argument choose the contractor, the chat, the message or the timestamp, or
  that puts owner reports, dashboard links or another worker's data in a group.
- **The ledger is the record.** Every clock change commits in a transaction with a
  receipt keyed by its source message, so a replay cannot create a second entry; a
  confirmation is sent only after the commit. Block writes outside `transaction()`,
  confirmations sent before the receipt, and anything that resets or silently
  repairs state it cannot parse. Corrupt rows must throw.
- **Owner checks fail closed.** Handles are compared with `sameHandle()`; a roster
  member without a handle matches no one. Block comparisons that treat a missing
  handle as a match.
- **Pins are the supply chain.** `FROM` carries a base tag and its index digest, and
  `tests/fixtures/base-AGENTS.md` matches that commit. Block a mutable reference.
  Bumping to a new immutable revision is ordinary work.

**Repo-specific contrast pairs:**

| DON'T flag (by design) | DO flag (real finding) |
|---|---|
| Behaviour specific to tracking one owner's contractors. Being that one agent is why the repo exists. | A change that belongs to a **sibling repo**: boot, identity, the Plow channel and the usage reporter are `plow-openclaw-agent`'s. `install.mjs` patches the base only where Ours must, by exact anchors that fail the build when the base moves; a fix any variant would want goes upstream instead. |
| Ours' own prompt wording instead of the base prompt's. It is tuned and evaluated. | Losing one of the base rules Ours mirrors (see `RULES` in `tests/repo-contract.test.mjs`) without saying why. |
| A contractor's clock messages skipping the base's burst debounce. Each keeps its own uid, timestamp and recovery record. | A contractor message dispatched before the previous one's turn finished. |

**Update cadence:** edit this when the stage changes. Product and architecture edits
belong in `README.md`.
