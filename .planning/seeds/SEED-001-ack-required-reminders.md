---
id: SEED-001
status: realized
planted: 2026-05-23
planted_during: v1.3 Multi-Head Support (Phase 36)
realized_in: v1.4 Unmissable Reminders (Phases 37–39)
realized_on: 2026-05-24
trigger_when: when planning reminder/scheduling enhancements, an "unmissable reminders" capability, or a v1.4 milestone
scope: medium-large (a dedicated phase; possibly a small milestone)
---

> **Realized in v1.4 Unmissable Reminders** (Phases 37–39): opt-in `requiresAck` +
> `nagIntervalMinutes` schedule fields, scheduler nag re-arm loop, head-direct
> `acknowledge_reminder` tool, and dashboard ack/nag UI. This seed is closed.

# SEED-001: Acknowledgment-required ("unmissable") reminders

An opt-in reminder severity that nags the user on a configurable interval until they
**explicitly acknowledge** it — for things you can't afford to miss (appointments,
medication). Not the default behavior: ordinary reminders stay one-shot/cron; only
flagged reminders enter the nag-until-acked loop (avoid alarm fatigue).

## Why This Matters

Today a one-time reminder fires once and self-deletes; a recurring reminder fires on
cron forever. Neither guarantees the user actually *saw and acted on* it. For
high-stakes items (a doctor's appointment, a weekly injection) "fired into the void"
isn't good enough — the system needs a delivery the user has to actively dismiss, or it
keeps surfacing. This is a long-standing want.

## When to Surface

**Trigger:** when planning any reminder/scheduling enhancement, an "unmissable
reminders" feature, or kicking off a v1.4 milestone. Surface this seed during
`/gsd:new-milestone` scans.

## Scope Estimate

**Medium–Large.** A dedicated phase: schema field(s), tool param + a new ack
tool/agent, fire-branch re-arm logic, the injected-event payload, and tests. Could
anchor a small v1.4 milestone if bundled with the dashboard start-date follow-up
(see backlog item 999.1) and any other scheduling polish.

## Settled Design Decisions

1. **System-native nag re-arm.** The scheduler/activation layer schedules the next nag
   itself, in code, *before* delivering the current one. The head's ONLY job is to stop
   the loop on acknowledgment. Nagging must never depend on the head doing work each
   cycle (that's the failure mode that makes "unmissable" miss).
2. **Nag interval is independent of the recurrence interval.** e.g. a weekly injection
   that nags hourly until acknowledged. Needs a separate `nagInterval` field distinct
   from the base `cron`.
3. **Ack behavior differs by reminder type:**
   - One-time + requiresAck → on ack, **delete** the reminder entirely.
   - Recurring + requiresAck → on ack, **mark this occurrence acknowledged** and stop
     the nag sub-loop; the base cron fires the next real occurrence, which re-triggers
     a fresh nag loop. (`requiresAck` is a persistent property; ack only clears the
     current occurrence.)
4. **Ack flows through the head.** When an ack-required reminder fires, inject a system
   event (same path as a normal reminder) that ALSO carries the reminder ID + explicit
   instructions: on user acknowledgment, the head spawns an agent to mark THIS reminder
   acknowledged.
5. **No system-prompt entry.** The ack instructions ride in the injected event, not the
   global prompt. Worst-case failure (the event ages out of head context before the
   next nag) is benign: one redundant nag, user replies "already got that." Only a
   perpetual repeat of that exact race would be a real problem — highly unlikely and
   low-impact, not worth bloating the prompt.
6. **The ack tool/agent description must be airtight.** A generic name/description risks
   the model calling it on ordinary reminders to silence them. Scope the name AND
   description explicitly to ack-required reminders only.
7. **Ack must cancel the already-armed in-flight nag**, not merely set a flag — since the
   system re-arms ahead of time, there is always a pending nag that must be
   deleted/disabled on ack.

## Verified Facts About Current Code (don't rebuild what exists)

- Reminders are a system feature: `kind: 'reminder'` schedule rows (NOT workspace
  tasks). Tools `create_reminder` / `list_reminders` / `cancel_reminder` are built in
  `src/sub-agents/registry.ts:903` (also surfaced to agents in
  `src/head/assembler.ts:453-455`).
- **Recurring-with-start-date already works at the backend.** `create_reminder` already
  accepts `cron` AND `triggerAt` together: it stores the cron expression but sets the
  first fire to `triggerAt` (`registry.ts:994-1003`). The scheduler advances `nextRun`
  from the cron after each fire (`src/scheduler/index.ts:88-91`); one-time rows (no
  cron) disable/delete on fire. So "start firing on date X, then repeat" is a backend
  capability today — it's just undocumented (the tool description calls `triggerAt`
  "for one-time reminders"). → verify + document/loosen the description, don't build.
- Reminder fire path: `src/head/activation.ts:1079` — resolves channel (last-active →
  head's first configured channel), a steward evaluates `conditions` and may skip,
  one-time reminders self-delete on fire (line 1132), and the message is injected to the
  head via `systemTrigger('reminder', …)`.
- A grep for `acknowledg|unmissable|nag|escalat|requiresAck` confirms **no ack /
  unmissable / escalation concept exists today** for reminders.

## Implementation Surface (for planning)

- `src/db/schedules.ts` — add `requiresAck` + `nagInterval` fields to the schedule row
  schema (+ lazy JSON/SQL migration, matching how Phase 35 added `headId`).
- `src/sub-agents/registry.ts` — `create_reminder` gains `requiresAck` + `nagInterval`
  params; add a new, narrowly-scoped ack tool (or the agent the head spawns to ack).
- `src/head/activation.ts` — fire branch: for `requiresAck`, re-arm the next nag before
  delivering; augment the injected event with the reminder ID + ack instructions; ack
  handling clears the nag (one-time → delete, recurring → stop nag, keep base cron).
- Tests (vitest): the `triggerAt + cron` start-date path; nag re-arm; ack stops the nag
  (one-time delete vs recurring resume); ack cancels the in-flight nag; ack
  tool/agent is NOT misfired on ordinary reminders.
- Likely a new milestone (v1.4) / next phase number (37+), since v1.3 is complete.

## Breadcrumbs

- `src/sub-agents/registry.ts:903` — `buildReminderTools` (create/list/cancel).
- `src/sub-agents/registry.ts:994-1003` — `triggerAt + cron` combine logic (start-date support).
- `src/scheduler/index.ts:88-91` — `advanceNextRun` from cron after fire.
- `src/head/activation.ts:1079-1144` — reminder fire branch (channel resolve, steward skip, self-delete, systemTrigger inject).
- `src/db/schedules.ts` — schedule row schema (`kind: 'task' | 'reminder'`).
- Related prior work: Phase 35 (per-head-scheduling) added `headId` to schedule rows the same way new fields would be added.

## Notes

Design was worked out in full during a v1.3-era discussion. Recommended GSD shape: a
single phase (discuss → plan → execute). The dashboard start-date UI gap is a separate,
smaller follow-up captured as backlog item 999.1.
