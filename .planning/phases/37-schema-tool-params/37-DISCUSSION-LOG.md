# Phase 37: Schema & Tool Params - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-23
**Phase:** 37-Schema & Tool Params
**Areas discussed:** nagInterval format, Ack ↔ nag validation, Field editability, Tool description scope

---

## nagInterval format

This area went through three rounds of exploration as the design evolved.

### Round 1 — initial representation

| Option | Description | Selected |
|--------|-------------|----------|
| Duration string + floor | Free-form `'15m'`/`'1h'`/`'6h'`, tiny parser + minimum floor | |
| Reuse cron cadence | Store a cron expression validated by existing `isValidCadence` | |
| Integer minutes | Store as a number; precise but not human-readable | |

**User's choice:** None — user asked for more context, then proposed ISO 8601 (`PT5M`, `P2D`, `PT1H30M`) with a battle-tested parser.

### Round 2 — ISO 8601 evaluation

Checked the dependency tree: no `luxon`/`date-fns`/`iso8601-duration`/`tinyduration` present; Node 22 has no stable `Temporal`. `zod` (already a dep) has `z.string().duration()` for ISO 8601 validation. Flagged the `P1M` (months) vs `PT1M` (minutes) LLM footgun and the SC1 `'1h'`→`PT1H` example drift.

**User's counter-proposal:** Instead of any string format, offer **multiple integer parameter slots** (minutes/hours/days/…), so there is no format and no parser. User noted a month could conceivably make sense for a far-fetched multi-year base schedule, but accepted that whatever cap Claude thinks sensible is fine.

### Round 3 — multi-slot lock

| Option | Description | Selected |
|--------|-------------|----------|
| min/hr/day, cap 30d | `nagMinutes`/`nagHours`/`nagDays` summed → stored total minutes; floor 5m, cap 30d; no month/year slots | ✓ |
| Add weeks + months slots | Also `nagWeeks`/`nagMonths` (month ≈ 30d approx), higher cap | |
| min/hr/day, bigger cap | Same slots, ceiling raised to 90d/365d | |

**User's choice:** min/hr/day, cap 30 days.
**Notes:** Multi-slot integers chosen specifically for LLM ergonomics + clean dashboard mapping; eliminates all parser/format ambiguity. Stored internally as a single total-minutes scalar. Days covers "month-ish"; the multi-year scenario is the base schedule, not the nag.

---

## Ack ↔ nag validation

### requiresAck:true with no nag slots (or sum below floor)

| Option | Description | Selected |
|--------|-------------|----------|
| Default to 1 hour | Create anyway, nagging hourly — robust against the model forgetting | |
| Reject with error | Error tells the model to supply an interval; it retries | ✓ |

**User's choice:** Reject with error.

### Nag slots present but requiresAck false/omitted

| Option | Description | Selected |
|--------|-------------|----------|
| Reject — slots need requiresAck | Error: nag slots only apply when `requiresAck:true` | ✓ |
| Infer requiresAck:true | Flip the flag on automatically from slot presence | |
| Ignore slots silently | Drop slots, create ordinary reminder | |

**User's choice:** Reject — slots need requiresAck.
**Notes:** Both mismatch cases reject at the tool boundary. No silent defaults, no inference — `requiresAck` is the flag, the nag slots are its parameters; an invalid combination fails loud and the model retries.

---

## Field editability

| Option | Description | Selected |
|--------|-------------|----------|
| Creation-only | `create_reminder` writes them; `SchedulePatch`/PATCH untouched; edit path deferred to Phase 39 | ✓ |
| Add to SchedulePatch now | Extend `SchedulePatch` forward-looking, but with no caller/test this phase | |

**User's choice:** Creation-only.
**Notes:** Matches the project's minimal-correct-scope norm; satisfies all four success criteria without an edit path. Phase 39 adds the dashboard edit form + `SchedulePatch` extension + PATCH route with its own tests.

---

## Tool description scope

| Option | Description | Selected |
|--------|-------------|----------|
| Fix SCHED-04 + fully document params | Reword triggerAt/cron to start-then-repeat AND describe `requiresAck`/nag slots as nag-until-ack | ✓ |
| Fix SCHED-04 only, minimal param text | Reword triggerAt/cron now; let Phase 38 enrich nag semantics so the description never overclaims | |

**User's choice:** Fix SCHED-04 + fully document params.
**Notes:** Backend start-then-repeat behavior was verified already-working (`registry.ts:994-1003` + scheduler `advanceNextRun`) — SCHED-04 is reword-only. Documenting the new params now is fine because Phases 37 + 38 ship together as one feature.

---

## Claude's Discretion

- Final field name for the stored total-minutes value (leaning `nagIntervalMinutes`; must encode units).
- Whether to rename the lazy-migration helper now that it stamps multiple fields.
- Whether `list_reminders` should project the two new fields read-only (leaning include).
- Exact wording/order of the `create_reminder` description and validation error strings.

## Deferred Ideas

- Nag re-arm mechanism, ack-by-type semantics, ack-cancels-in-flight-nag, injected fire-event payload, ack tool/agent → Phase 38.
- Dashboard `requiresAck`/nag-interval form controls, ack-required visual marker, start-date pickers, `SchedulePatch` extension + PATCH edit route → Phase 39.
- PATCH-vs-delete-and-recreate policy for changing ack-ness on an existing reminder → Phase 39.
- ACK-F-01 (dashboard ack button), ACK-F-02 (channel escalation after N nags) → Future Requirements.
