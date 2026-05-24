---
phase: 37-schema-tool-params
verified: 2026-05-23T17:03:13Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Confirm the tool description's nagging-behavior promise is acceptable for a foundation phase"
    expected: "Either (a) the team accepts that the description pre-advertises Phase 38 behavior per D-10b, or (b) the description is softened per CR-01 in 37-REVIEW.md before Phase 38 ships"
    why_human: "The description says 'An acknowledgment-required reminder keeps nagging on the nag interval until the user explicitly acknowledges it' but no scheduler code consumes requiresAck or nagIntervalMinutes yet. CONTEXT D-10b explicitly authorized this forward-description. REVIEW CR-01 recommends softening it. Programmatic verification cannot decide between the two positions — a human must ratify one."
    resolution: "RATIFIED option (a) per D-10b by human on 2026-05-23. Forward-looking description accepted as-is; no code change. See 37-HUMAN-UAT.md."
---

# Phase 37: Schema & Tool Params Verification Report

**Phase Goal:** Add `requiresAck` + `nagInterval` fields to the reminder schedule schema with lazy JSON migration; wire both params into `create_reminder`; verify and correct the `create_reminder` tool description for `triggerAt` + `cron` start-then-repeat behavior.
**Verified:** 2026-05-23T17:03:13Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A reminder created with `requiresAck:true` and nag slots round-trips both fields through `ScheduleStore.get()` (ROADMAP SC1) | VERIFIED | `src/db/schedules.ts:89-90` defaults; `schedules.test.ts` 18/18 pass including round-trip; slot-sum test in `agents.test.ts` asserts `nagIntervalMinutes===90` |
| 2 | A pre-Phase-37 reminder JSON file reads back with defaults stamped and continues to fire — no crash (ROADMAP SC2 / ACK-09) | VERIFIED | `migrateLegacySchedule` in `src/db/schedules.ts:55-63` uses `'field' in obj` guards for both fields; legacy-migration test passes (5/5) |
| 3 | `create_reminder` tool description no longer contains "for one-time reminders only"; `triggerAt` + `cron` documented as start-then-repeat (ROADMAP SC3 / SCHED-04) | VERIFIED | `grep -c 'for one-time reminders only' src/sub-agents/registry.ts` returns 0; description at line 927 contains "start-then-repeat"; description test asserts both |
| 4 | `npx tsc --noEmit` is clean and `npx vitest run` passes (ROADMAP SC4) | VERIFIED | `tsc --noEmit` exits 0; `schedules.test.ts` 18/18 pass; `agents.test.ts` create_reminder filter 20/20 pass |
| 5 | `create_reminder` exposes `requiresAck` + `nagMinutes`/`nagHours`/`nagDays` as input params with full boundary validation (D-03/D-04/D-05/D-06) | VERIFIED | All four params declared in `inputSchema.properties` at lines 954-969; per-slot integer guard at lines 997-1005; D-05 check at line 1011; D-04 check at line 1016; D-03 floor at line 1021; D-03 ceiling at line 1026; all reject with `{ error:true, message }` |
| 6 | A task created without ack fields defaults to `requiresAck:false`, `nagIntervalMinutes:null` (D-07 inert-for-tasks) | VERIFIED | `create()` defaults at lines 89-90; inert-for-tasks test in `schedules.test.ts` passes |
| 7 | Reading an already-migrated file a second/third time does NOT rewrite it — mtime and bytes stable (D-08 idempotent guard) | VERIFIED | Migrator uses `'field' in obj` (NOT `??` coalesce) at lines 59-61; mtime-stable tests (2/2) pass |
| 8 | `SchedulePatch` and `update()` are NOT modified — no edit path for the new fields (D-09 creation-only) | VERIFIED | `SchedulePatch` type at line 41 excludes `requiresAck` and `nagIntervalMinutes`; `update()` at lines 125-141 has no branches for either field |

**Score:** 8/8 truths verified

### Deferred Items

No items deferred. All Phase 37 scope is implemented. Runtime consumption of `requiresAck`/`nagIntervalMinutes` by the scheduler and ack tool is explicitly Phase 38 (ACK-03..08) per ROADMAP and CONTEXT.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schedules.ts` | `requiresAck` + `nagIntervalMinutes` on Schedule; `CreateScheduleOptions` optionals; `create()` defaults; `migrateLegacySchedule` wired into get/list/getDue | VERIFIED | All present. `migrateLegacyHeadId` count = 0 (renamed). `migrateLegacySchedule` count = 4 (definition + get + list + getDue). `requiresAck` count = 6 lines. `nagIntervalMinutes` count = 5 lines. |
| `src/db/schedules.test.ts` | Round-trip, inert-for-tasks, legacy-migration, mtime-stable tests for new fields | VERIFIED | 18/18 tests pass. Named subsets: "round-trip" 2/2, "legacy" 5/5, "mtime" 2/2. |
| `src/sub-agents/registry.ts` | `create_reminder` inputSchema declares 4 new params; boundary validation; slot-sum; createOpts assignment; reworded description | VERIFIED | All params declared. `1440` multiplier present (3 occurrences). `createOpts.nagIntervalMinutes = nagSum` count = 1. `createOpts.requiresAck = requiresAckArg` count = 1. |
| `src/sub-agents/agents.test.ts` | Reject tests (D-03/D-04/D-05/V5), slot-sum round-trip, default path, description assertion, updated property-order test | VERIFIED | `nagIntervalMinutes` count = 7. Property-order test updated to 9-key array including new params. Description test asserts start-then-repeat and absence of "for one-time reminders only". |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `ScheduleStore.create()` | `Schedule` literal | `options.requiresAck ?? false` / `options.nagIntervalMinutes ?? null` defaults | WIRED | `src/db/schedules.ts:89-90` |
| `ScheduleStore.get()/list()/getDue()` | `migrateLegacySchedule` | lazy stamp on read funnel | WIRED | All three read paths call `migrateLegacySchedule` at lines 101, 110, 152 |
| `create_reminder.execute()` | `scheduleStore.create(createOpts)` | summed `nagSum` assigned to `createOpts.nagIntervalMinutes` when non-zero | WIRED | `src/sub-agents/registry.ts:1092-1098` |
| `create_reminder.inputSchema.properties` | LLM | declared `requiresAck`/`nagMinutes`/`nagHours`/`nagDays` params | WIRED | All four params in inputSchema at lines 954-969 |

### Data-Flow Trace (Level 4)

No dynamic data rendering artifacts in this phase. Both modified files are storage tier (`schedules.ts`) and tool-boundary tier (`registry.ts`) — not UI components or pages. Level 4 trace not applicable.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| tsc type check clean | `npx tsc --noEmit` | exit 0, no output | PASS |
| schedules.test.ts full suite | `npx vitest run src/db/schedules.test.ts` | 18/18 passed | PASS |
| create_reminder reject + round-trip tests | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | 20/20 passed (72 skipped) | PASS |
| property-order test | `npx vitest run src/sub-agents/agents.test.ts -t "property order"` | 2/2 passed | PASS |
| description assertion | `npx vitest run src/sub-agents/agents.test.ts -t "description"` | 2/2 passed | PASS |
| "for one-time reminders only" absent | `grep -c 'for one-time reminders only' src/sub-agents/registry.ts` | 0 | PASS |
| old migrator name absent | `grep -c 'migrateLegacyHeadId' src/db/schedules.ts` | 0 | PASS |

### Probe Execution

No probe scripts declared for Phase 37. Step 7c: SKIPPED (no probe-*.sh files in scripts/).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ACK-01 | 37-01, 37-02 | User can create an ack-required reminder (fields + tool params) | SATISFIED | `requiresAck` field on Schedule; `requiresAck` param in `create_reminder`; stored correctly via `createOpts.requiresAck = requiresAckArg` |
| ACK-02 | 37-01, 37-02 | User can set a nag interval independent of base recurrence | SATISFIED | `nagIntervalMinutes` field on Schedule; multi-slot params (`nagMinutes`/`nagHours`/`nagDays`) summed into stored scalar; slot-sum round-trip test confirms `nagIntervalMinutes===90` for `nagHours:1 + nagMinutes:30` |
| ACK-09 | 37-01 | Pre-milestone reminders continue firing unchanged via lazy migration | SATISFIED | `migrateLegacySchedule` stamps `requiresAck:false` and `nagIntervalMinutes:null` on first read of legacy JSON; legacy-migration and mtime-stable tests confirm behavior |
| SCHED-04 | 37-02 | `create_reminder` description accurately documents `triggerAt` + `cron` = start-then-repeat | SATISFIED | "for one-time reminders only" removed; description at lines 926-927 contains "start-then-repeat" wording; `triggerAt` param doc updated at line 944 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/sub-agents/registry.ts` | 930, 956 | "keeps nagging…until the user explicitly acknowledges it" — behavioral promise with no current runtime consumer | WARNING | The tool description promises nagging-until-acknowledged behavior. No code in `src/scheduler/index.ts` or any other file outside the reviewed pair reads `requiresAck` or `nagIntervalMinutes`. An agent using `requiresAck:true` today gets a one-fire reminder. This was flagged as CR-01 in 37-REVIEW.md. CONTEXT D-10b explicitly authorized this forward-description ("Phase 37 and 38 ship together as one feature"). Phase 38 is the next planned phase. This is a WARNING requiring human ratification, not a BLOCKER. |
| `src/sub-agents/registry.ts` | 997-1005 | Per-slot integer guard runs before requiresAck coupling check (WR-02) | INFO | A call like `{ nagMinutes: 1.5 }` without `requiresAck` gets "nagMinutes must be a non-negative integer" before learning it needs `requiresAck:true`. Two round-trips instead of one. Not a data-corruption bug. |
| `src/sub-agents/registry.ts` | 1026 | Ceiling check `nagSum > 43200` unguarded (WR-03) | INFO | Unreachable dead branch for non-ack calls due to D-05 check at line 1011. Inconsistent with the floor check's `requiresAckArg === true` guard. No wrong behavior. |

Debt-marker gate: No `TBD`, `FIXME`, or `XXX` markers found in modified files. Gate clear.

### Human Verification Required

#### 1. Ratify or Soften the Nagging-Behavior Promise in the Tool Description (CR-01)

**Test:** Read the `create_reminder` description at `src/sub-agents/registry.ts:929-930` and `src/sub-agents/registry.ts:956`. Decide whether to accept the forward-description or soften it before shipping.

**Expected:** One of two outcomes:
- (a) Team accepts the forward-description per D-10b — Phase 38 will make it true. The description ships as-is. No change needed.
- (b) Team prefers honest-for-today description per REVIEW CR-01 — soften the nagging promise so `requiresAck:true` is described as "records acknowledgment preference for future nag mechanism" or similar. Update tests that assert `toMatch(/start.?then.?repeat/)` if description wording changes.

**Why human:** CONTEXT D-10b explicitly authorized describing the full ack contract before Phase 38 lands ("the description becomes fully true once Phase 38 lands the mechanism"). REVIEW CR-01 recommends softening. Programmatic verification cannot resolve this design intent conflict — it requires a human to ratify one position.

### Gaps Summary

No BLOCKER gaps. All 8 must-haves are verified. The one open item is a human decision about description honesty (forward-promise vs. as-built), which was called out in both the CONTEXT and the code review and requires human ratification of the design choice made in D-10b.

---

_Verified: 2026-05-23T17:03:13Z_
_Verifier: Claude (gsd-verifier)_
