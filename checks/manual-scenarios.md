# Ours end-to-end checklist (real line)

Run this before promoting a release, on a real Plow line with two phones: the owner and
one contractor. Use a QA contractor contact, not a real worker. Every box must pass;
write failures next to the item with the time and what was sent.

Setup:

```sh
npm ci --ignore-scripts --no-audit --no-fund && npm run check   # offline suites green first
plow-agents login && plow-agents lines
plow-agents deploy --local --line LINE_UID                      # writes plow-credentials, starts Compose
docker compose logs -f agent                                    # wait for "plow-boot: identity resolved"
```

## 0. Image

- [ ] **Boot.** The log shows `plow-boot: identity resolved` and no `parked` line.
- [ ] **Probe.** `docker compose exec agent /opt/plow/probe` prints `PLOW_HOURS_PROBE_OK`.
- [ ] **Local dashboard.** <http://localhost:3331/hours> loads on this machine only.

## 1. Owner setup

1. [ ] **First contact.** As the owner, text: "Add Alex, QA_CONTACT, to work on the
   landing page. Create a group with us."
   - Expect: one short introduction, then a question for only the missing facts
     (hourly rate and timezone). No menu, no "How can I help?".
2. [ ] **Group.** Answer "$20/hour, São Paulo time."
   - Expect: Ours reuses an existing owner + Alex + bot group, or creates one with an
     introduction. It reports the request as accepted, never as delivered.
   - Check: the group appears on both phones with exactly three participants.
3. [ ] **Registration receipt.** Expect a confirmation only after the saved receipt.
   Asking "Is Alex registered?" gets a yes that matches the dashboard.
   - Expect (#30): right after registration the group gets one how-to-log-time message
     in Alex's language, with /in and /out, promising nothing further. Changing Alex's
     rate afterwards sends no second one.

## 2. A workday in the contractor's group

4. [ ] **Start without a task.** As Alex: "Starting work now."
   - Expect: the clock starts at the message's time, then one question about the work.
5. [ ] **Overview later.** "Making the checkout animation."
   - Expect: saved as a note; the start time does not move.
6. [ ] **Split bubbles.** Send "Back on the landing page" and "the hero section" within
   two seconds.
   - Expect: two separate replies in order. Neither message starts a second clock.
7. [ ] **Swipe-reply.** Long-press Ours' question and reply "Yes, the hero".
   - Expect: Ours answers. The turn does not fail, retry or go silent.
8. [ ] **Human talk stays human.** As the owner in the group: "Alex, can you check the
   landing page?"
   - Expect: Ours stays silent and no clock changes.
9. [ ] **Shortcut.** As Alex: `/out commit abc123`.
   - Expect: an immediate stop receipt with the total, without a model delay.
10. [ ] **Own report.** "How much did I work today, and how much did I earn?"
    - Expect: Alex's own duration and USD value from the ledger, exact to the second.
11. [ ] **No cross-worker data.** "How much does the other contractor earn?"
    - Expect: a refusal. No other worker's name, rate or hours.

## 3. Owner privacy and corrections

12. [ ] **Report asked in the group.** As the owner in Alex's group: "Send me the dashboard."
    - Expect: a short "I'll reply privately" in the group; the link arrives only in the
      owner's DM. The group never shows the URL.
13. [ ] **Routed context is never "fake" (#32).** As the owner in Alex's group, send
    "elm are you there?" and a screenshot.
    - Expect: an answer or silence. No reply anywhere calls the message, its context or
      its metadata fake, pasted or injected.
14. [ ] **Voided is not "never clocked in" (#32).** Void Alex's entry from the DM, then ask
    "Has Alex clocked in today?"
    - Expect: the voided entry is mentioned with the option to restore it.
15. [ ] **Correction.** In the owner DM: "Alex started at 9:10, not 9:30, yesterday."
    - Expect: the same entry is corrected with a reason; nothing is voided and recreated,
      and Alex is not asked to clock again.

## 4. Paperwork and billing

16. [ ] **Payment details before billing.** As Alex: send a Pix key and beneficiary.
    - Expect: saved and confirmed without repeating the key.
17. [ ] **Request paperwork.** In the owner DM, request the period's invoice for Alex (BR).
    - Expect: the paperwork request lands in Alex's group, not the DM.
18. [ ] **Close and review.** Close the period, then have Alex send a nota fiscal link and
    amount that match.
    - Expect: "ready for your review" in the owner DM; the amount matches the closed value.
19. [ ] **Approval is exact.** Approve in the owner DM. Then have Alex change the Pix key.
    - Expect: the approval is revoked and the owner gets a private alert. Nothing is
      paid or marked paid at any point.

## 5. Recovery

20. [ ] **Restart mid-day.** With a clock open, run `docker compose restart agent`, then
    have Alex send "Finished for today."
    - Expect: the stop closes the original session; no duplicate entry or second receipt.
21. [ ] **Backups.** `docker compose exec agent ls /var/lib/plow/plow-hours/backups` shows a
    fresh encrypted snapshot.

## 6. On its own (run across one day)

22. [ ] **Forgotten clock.** Start a clock in the morning and leave it open.
    - Expect: ten hours later, in daytime for the contractor, one nudge in their group
      with the start time, how to close it, and to reply with the real stop time.
      Nothing more for that session, even after `docker compose restart agent`.
23. [ ] **Evening summary.** On a day with recorded work, wait until 19:00 São Paulo time.
    - Expect: one message in the owner DM with each contractor's hours and USD value,
      open clocks, items waiting on the owner, and, the first time only, how to turn it
      off. A day with no work sends nothing.
24. [ ] **Owner control.** In the DM: "stop the daily summary", then "send it at 7 pm New
    York time instead".
    - Expect: the summary stops, then resumes at 19:00 New York time.

Record the image digest, the date and the line used at the top of the release notes.
