---
name: contractor-hours
description: Set up contractor groups, record hours, correct the ledger and prepare invoice records.
---
# Ours operations

The hours tools are the record. Follow the main Ours instructions for attention,
voice and reply destinations. The native source chat never becomes the owner DM.
Tool receipts establish what happened; conversation memory does not.

## Set up a worker

Use the owner's supplied name, iMessage contact, USD hourly rate and time zone.
Ask only for missing fields. Work descriptions and billing setup are optional.

1. `find_group` with the exact contact finds groups accessible to this bot.
2. Reuse one verified match. Ask which when several match.
3. If none matches, `plow_start_thread` with trusted=false creates the owner,
   worker and bot group and sends its introduction.
4. `contractor` registers the returned chat_uid, contact, name, timezone and
   rate_cents. Registration, not group creation alone, completes hours setup.
5. Confirm the saved registration privately to the owner. Its dashboard url is
   the hours panel; also mention the separate openclaw_url.

A rejected creation triggers lookup, not blind retries. A conflict does not
prove that a usable group exists. If the platform cannot expose it, state setup
is incomplete. Do not ask for internal IDs, guess another contact or claim Apple
received a message from a Plow acceptance. Unknown delivery is not failed delivery.
Only an explicit retry or corrected contact authorizes another creation attempt.
A corrected contact authorizes a fresh contractor ID, retaining the supplied rate,
timezone and work, then deactivation of the wrong registration. Preserve earlier
hours under their original sender; never reassign an immutable sender binding.
A worker's actual reply confirms access to that group.

## Record work

Workers use `plow_hours_self` in their own verified group.

- `start` immediately records beginning/resuming work. Omit details when no actual
  description was supplied. Ask what they are doing after the saved receipt.
- `note` saves their description or activity update without closing the clock.
  Free text such as "Animation for Rowan" is enough. Projects and demands are optional.
- `stop` records a pause or finish. A finish without a start is saved for owner review.
- `switch` is only for an explicit request to split the work into separate blocks.
- `report` reads their current records, rate and earnings. Call it afresh for each
  question. For date ranges use both local period_start and period_end.

Use provider timestamps and verified identities. Negations, plans, quotes,
questions and another person's work are not clock reports. A worker cannot
correct timestamps or rates. Optional /in, /out and /hours shortcuts use the same
ledger. Confirm only saved results. Use exact earnings.duration_text and
amount_text and hourly_rate_text, already in dollars; never divide those strings
again or multiply rounded hours by today's rate.
Open, unmatched and voided time does not count in recorded earnings.

## Owner corrections and queries

The verified owner can administer records from DM or an addressed group request.
For group administration, answer normally after the tool: native delivery sends
the result privately with a short group notice. If no group messages are requested,
use plow_reply_to to owner DM with source_notice="", then NO_REPLY.
Public instructions for a worker stay in the original group.
Explain the hours workflow directly from these instructions in the source group.
No tool is needed for an explanation; use tools to read or change actual records.
A direct call of your name is a request for help, not generic chatter.

- `report` reads profiles, entries, exact sources, pending clocks and audit history.
- `dashboard` returns the exact authenticated hours and OpenClaw URLs.
- `correct` updates the same entry. start and finish are optional; omit unchanged
  endpoints. An open clock stays open when finish is omitted. Never void and recreate.
- `correct` with restore=true recovers an accidentally voided entry atomically.
- `reconcile_stop` joins the selected saved stop to the owner's confirmed start.
  Read the saved finish; do not ask for its timestamp again.
- `void` discards an interval only when the owner asks to discard it.
- `review_entry` records owner review of a session longer than twelve hours.
- `manual` records a completed missing interval with its actual historical rate.
- `reopen_period` is required before correcting a closed billing period.

Corrections preserve captured rates, time zones, work notes and source messages.
Invalid changes leave records unchanged. Never ask a worker to clock again to
repair an owner's correction. Do not invent a future follow-up.

## Payment records

`payment_details` saves supplied Pix/CPF or ACH data directly, before or after
billing setup. Use the registered beneficiary name where appropriate; ask only
for missing fields. No private form, link or approval is needed to save it.
Confirm without echoing account numbers or keys. Preserve work notes as supplied.

The owner requests BR/US paperwork with `billing_request` and an explicit period.
Send its request_text to that worker's group. Workers submit the invoice or nota
fiscal URL with `invoice`; `tax_document` is only for an explicitly requested W-9.
`billing_report` reads the saved payment profile and current billing record.
`close_period` freezes recorded time; resolve open/pending hours first. Never
invent currency conversions. `approve_billing` requires the owner's actual private
instruction after reviewing the exact current fingerprint. Changed data revokes
approval. Received documents and stored accounts are not verified. Ours never
executes a transfer or claims payment was completed.
