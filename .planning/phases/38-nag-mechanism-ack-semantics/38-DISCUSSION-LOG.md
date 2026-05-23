# Phase 38: Nag Mechanism & Ack Semantics - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-23
**Phase:** 38-Nag Mechanism & Ack Semantics
**Areas discussed:** Nag state model, Ack path, Steward & nags, Overlap edge case, Injected fire-event shape

---

## Nag state model

**Q1: How should the armed-nag state and the dual-clock (base cron vs nag) be represented?**

| Option | Description | Selected |
|--------|-------------|----------|
| Single row + ackPending flag | New ackPending field on the existing Schedule row; nextRun holds the nag clock while nagging; base cron occurrence re-derived at ack time. One row, no new lifecycle. | ✓ |
| Separate transient nag row | Base row keeps firing on cron; a separate self-re-arming nag row is created on fire and deleted on ack. Cleaner separation but second-row lifecycle + cascade/orphan + link concerns. | |

**User's choice:** Single row + ackPending flag.
**Notes:** Matches Phase 37's pattern (fields on the shared row, inert when not applicable) and minimal-correct-scope norm.

**Q2: Where should the nag re-arm (setting nextRun = now + nagInterval) happen?**

| Option | Description | Selected |
|--------|-------------|----------|
| Scheduler tick owns it | In the tick advance block (index.ts:88-96): if requiresAck, set nextRun = now + nagInterval, keep enabled=true. Activation only guards the one-time delete + sets ackPending. Literally satisfies ACK-03. | ✓ |
| Activation branch owns it | Keep scheduler generic; do all nag bookkeeping in the activation reminder branch. Redundant write window (scheduler disables/advances, activation overwrites); re-arm in the delivery path. | |

**User's choice:** Scheduler tick owns it.
**Notes:** Re-arm sits in the generic ticker, independent of head work by construction.

---

## Ack path

**Q1: When the head decides the user acknowledged, how should the ack execute?**

| Option | Description | Selected |
|--------|-------------|----------|
| Head-direct tool | New acknowledge_reminder HeadToolExecutor case; synchronous mutation; no agent round-trip; immediate ACK-06 cancel; server-side requiresAck check. Deviates from SEED-001 decision 4. | ✓ |
| Head spawns an ack agent | Per SEED-001 decision 4: head spawns an async agent that calls an acknowledge_reminder agent-tool. Consistent with 'head delegates all work' but multi-cycle round-trip for a one-liner. | |

**User's choice:** Head-direct tool.
**Notes:** Deliberate deviation from SEED-001 decision 4 and the 'head never does work directly' principle — justified: acking is deterministic coordination/bookkeeping (like cancel_agent), and immediacy cleanly cancels the in-flight nag.

**Q2: How airtight should the ack tool be against misfiring + stale acks?**

| Option | Description | Selected |
|--------|-------------|----------|
| Server guard + idempotent no-op | Airtight name/description + server-side requiresAck reject; stale/double ack (missing or !ackPending) returns benign no-op success. | ✓ |
| Server guard + error on stale | Same scoping but stale ack returns an explicit error. Surfaces mistakes loudly but risks confusing 'failed to acknowledge' when already handled. | |
| Description-only scoping | Rely solely on tool name/description; no server check. Contradicts the 'airtight' theme and ACK-08. | |

**User's choice:** Server guard + idempotent no-op.
**Notes:** Loud on the dangerous case (acking an ordinary reminder), quiet on the benign case (double/late ack).

---

## Steward & nags

**Q1: Should ack-required reminders be subject to the proactive steward skip, or bypass it?**

| Option | Description | Selected |
|--------|-------------|----------|
| Full bypass — always deliver | requiresAck reminders skip runReminderDecision entirely; every fire always delivers; never skip-deletes. Avoids the steward-skip-deletes-row catastrophe (activation.ts:1124). | ✓ |
| Steward gates initial fire only | First occurrence runs the steward (respects conditions); nags bypass once ackPending. Middle ground, more complex. | |
| No change — steward can skip nags | Leave steward in path; a skip suppresses a nag. Contradicts 'unmissable'. | |

**User's choice:** Full bypass — always deliver.
**Notes:** "Unmissable" means un-silenceable; the conditions field stays relevant only for ordinary soft reminders.

---

## Overlap edge case

**Q1: For a never-acked recurring ack reminder, pause cron during nag or fire in parallel?**

| Option | Description | Selected |
|--------|-------------|----------|
| Pause cron during nag | One active nag per reminder; cadence suspended while ackPending; resumes from ack time. Consequence of the single-row model; no extra state. | ✓ |
| Cron fires in parallel | Base cron keeps producing fresh occurrences; requires a second stored clock; risks stacking/overwriting nags. | |

**User's choice:** Pause cron during nag.
**Notes:** Deal with the outstanding occurrence before the next; no duplicate/stacked occurrences ever.

---

## Injected fire-event shape (ACK-07)

**Q1: How should the injected fire event encode the reminder ID + ack instructions?**

| Option | Description | Selected |
|--------|-------------|----------|
| Structured attr + framed instruction | reminderId + requires-ack as marker attrs, plus a concise self-contained ack instruction in the body that tells the head to call acknowledge_reminder and not relay it to the user. Injected every fire. | ✓ |
| Instruction-text only (no special attrs) | Append the whole ack instruction (incl. ID) as prose; head parses ID from text. Simpler marker but less reliable ID extraction + leak risk. | |

**User's choice:** Structured attr + framed instruction.
**Notes:** ID stays machine-extractable; instructions are self-contained so no system-prompt entry is needed (SEED decision 5 honored).

---

## Claude's Discretion

- Exact tool name (`acknowledge_reminder`) + precise description and in-event ack instruction wording (must stay airtight).
- Exact new field name (`ackPending`) and marker attr key spellings (`reminderId` / `requires-ack`).
- Whether `list_reminders` projects `ackPending` (cheap, optional).
- `acknowledge_reminder` return shape — match existing reminder-tool idiom.

## Deferred Ideas

- Dashboard `requiresAck`/`nagInterval` controls, ack-required visual marker, start-date pickers → Phase 39.
- Dashboard ack button (ACK-F-01), escalate-after-N-nags (ACK-F-02) → Future Requirements.
