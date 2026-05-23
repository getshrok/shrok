---
phase: 38-nag-mechanism-ack-semantics
plan: "04"
subsystem: head-tool-executor
tags: [ack-semantics, head-tools, acknowledge-reminder, schedule-store, testing]
dependency_graph:
  requires:
    - "38-01 (ackPending field in Schedule/SchedulePatch/update/migrate — already landed)"
  provides:
    - "acknowledge_reminder head-direct tool (HEAD_TOOLS entry + dispatch case)"
    - "scheduleStore + timezone threaded into HeadToolExecutorOptions and buildSystem"
    - "head-tools.test.ts: full ACK-04/05/06/08 + D-09 unit coverage"
  affects:
    - "src/head/index.ts (HeadToolExecutorOptions, HEAD_TOOLS, dispatch)"
    - "src/system.ts (toolExecutorOpts)"
tech_stack:
  added: []
  patterns:
    - "head-direct tool: HEAD_TOOLS entry + dispatch case (cancel_agent analog)"
    - "optional store threading: mirrors agentStore? pattern in HeadToolExecutorOptions"
    - "static import: nextRunAfter from scheduler/cron.js (not dynamic await)"
    - "D-07 dispatch order: not-found no-op → requiresAck-false hard error → ackPending-false no-op → one-time delete → recurring cron-resume"
    - "test harness clone: head.test.ts HeadToolExecutor describe block + scheduleStore mock shape from activation.test.ts"
key_files:
  created:
    - src/head/head-tools.test.ts
  modified:
    - src/head/index.ts
    - src/system.ts
decisions:
  - "Static nextRunAfter import (not dynamic await) — module has no init side effects; cleaner"
  - "schedule.cronTimezone ?? this.opts.timezone ?? 'UTC' — per-schedule tz wins, then head tz, then safe UTC default"
  - "Four-clause description (requiresAck/acknowledgment-required, NEVER ordinary, explicitly confirmed, ID from event)"
metrics:
  duration: "~4 minutes"
  completed: "2026-05-23"
  tasks: 3
  files: 3
---

# Phase 38 Plan 04: acknowledge_reminder Tool Summary

**One-liner:** Head-direct `acknowledge_reminder` tool with one-time-delete / recurring-cron-resume / requiresAck-false-hard-error / double-ack-no-op semantics, threaded scheduleStore + timezone into HeadToolExecutorOptions.

## What Was Built

### Task 1 — Thread scheduleStore + timezone into HeadToolExecutorOptions (commit: a0db567)

Added two optional fields to `HeadToolExecutorOptions` in `src/head/index.ts`:
- `scheduleStore?: import('../db/schedules.js').ScheduleStore` — mirrors the `agentStore?` optional-store pattern; existing callers remain tsc-clean
- `timezone?: string` — for cron-resume computation in the recurring ack path (D-07)

Wired both into `toolExecutorOpts` in `buildSystem` (`src/system.ts`):
- `scheduleStore: stores.schedules` — the `ActivationLoop` already receives this store
- `timezone: config.timezone` — the workspace-level IANA timezone

The production `HeadToolExecutor` at `activation.ts:772` receives both via the `{...this.opts.toolExecutorOpts}` spread — no construction-site edit needed.

### Task 2 — Add acknowledge_reminder HEAD_TOOLS entry and dispatch case (commit: 476ea81)

Added static `import { nextRunAfter } from '../scheduler/cron.js'` at the top of `src/head/index.ts`.

Added `acknowledge_reminder` to `HEAD_TOOLS` with a four-clause airtight description (D-08 layer a):
1. States it acknowledges an acknowledgment-required reminder and stops its nag loop
2. "Only call this for reminders that explicitly require acknowledgment (requiresAck: true)"
3. "NEVER call this on an ordinary reminder" with cancel_reminder alternative
4. "Call this only when the user has explicitly confirmed they have seen and handled the reminder"
5. "The reminder ID is provided in the reminder event"

Added `acknowledge_reminder` dispatch case implementing D-07/D-08/D-09 in precedence order:
1. `scheduleStore?.get() → null` → `{ ok: true, note: '...' }` benign no-op (D-09: already deleted one-time)
2. `requiresAck === false || kind !== 'reminder'` → `{ error: true, message: '...' }` hard error (D-08 layer b, covers Pitfall 5 task case)
3. `!ackPending` → `{ ok: true, note: '...' }` benign no-op (D-09: recurring between occurrences / already acked)
4. `cron === null` → `scheduleStore.delete(reminderId)` (ACK-04 + ACK-06: one-time row gone)
5. `cron present` → `scheduleStore.update(reminderId, { ackPending: false, nextRun: nextRunAfter(cron, now, tz).toISOString() })` (ACK-05 + ACK-06: recurring resume via cron, NOT now+nagInterval per Pitfall 3)

### Task 3 — Create head-tools.test.ts (commit: a887495)

Created `src/head/head-tools.test.ts` with:
- `makeReminder(overrides)` helper (sensible defaults: kind:'reminder', requiresAck:true, ackPending:true, cron:null)
- Cloned `HeadToolExecutor` harness from `head.test.ts:223-254` with `scheduleStore` + `timezone:'UTC'` additions
- `scheduleStore` mock with `{ get: vi.fn(), update: vi.fn(), delete: vi.fn() }`
- 6 `it()` blocks:
  - Test 1 (ACK-04, ACK-06): one-time ack → `scheduleStore.delete` called with rem-1, `{ ok: true }` returned, update NOT called
  - Test 2 (ACK-05, ACK-06): recurring ack → `scheduleStore.update` called with `{ ackPending: false, nextRun: <iso> }`, nextRun is a valid future ISO string, delete NOT called
  - Test 3 (ACK-08, D-08): requiresAck:false → `{ error: true }` returned, no mutation
  - Test 4 (ACK-08, Pitfall 5): kind:'task' → `{ error: true }` returned, no mutation
  - Test 5 (D-09): get returns null → `{ ok: true, note }` no-op, no mutation
  - Test 6 (D-09): ackPending:false → `{ ok: true, note }` no-op, no mutation

## Verification

- `npx tsc --noEmit` → PASSED (0 errors)
- `npx vitest run src/head/head-tools.test.ts` → 6/6 PASSED
- `npx vitest run src/head/head.test.ts` → 45/45 PASSED (existing fixture unaffected)

## Deviations from Plan

None — plan executed exactly as written. The plan specified a static import for `nextRunAfter` (over dynamic `await import`) and noted the `schedule.cronTimezone ?? this.opts.timezone ?? 'UTC'` tz resolution; both implemented exactly as specified.

Note: The plan's PATTERNS.md showed a RESEARCH-era draft that used `await import('../scheduler/cron.js')` inside the dispatch case. The plan text (`<action>` step) explicitly overrode this with "Prefer a static import" — the static import was used.

## Known Stubs

None — all paths in `acknowledge_reminder` are fully wired to live store operations. No hardcoded empty values or placeholder returns.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes introduced beyond what is in the plan's threat model. The `acknowledge_reminder` tool is head-direct only (V4: not in `buildReminderTools` agent surface — per RESEARCH.md confirmed unchanged).

## Self-Check: PASSED

- src/head/head-tools.test.ts — FOUND
- src/head/index.ts — FOUND (modified)
- src/system.ts — FOUND (modified)
- 38-04-SUMMARY.md — FOUND
- Commit a0db567 — FOUND
- Commit 476ea81 — FOUND
- Commit a887495 — FOUND
