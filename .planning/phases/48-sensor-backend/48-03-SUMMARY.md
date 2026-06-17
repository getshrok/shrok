---
phase: 48-sensor-backend
plan: "03"
subsystem: sensors
tags: [sensors, ambient, cache-split, tdd, injection]
dependency_graph:
  requires:
    - src/sensors/scan.ts (Plan 01 — scanAmbient function)
  provides:
    - src/head/assembler.ts (scanAmbient injection in uncached region + script-schedule filter)
    - src/head/activation.ts (readAmbientContext deleted; both proactive sites use scanAmbient)
    - src/sub-agents/tool-surface.ts (AMBIENT.md deleted; scanAmbient after Current time:)
    - src/scheduler/prompts/tasks.md (stale AMBIENT.md doc reference scrubbed)
  affects:
    - src/head/assembler.test.ts (4 new tests: Weather placement, absent ambient/, AMBIENT.md exclusion, script-kind filter)
    - src/head/activation.test.ts (2 behavioral tests: mocked scanAmbient sentinel at both proactive sites)
tech_stack:
  added: []
  patterns:
    - scanAmbient() called in the uncached region — AFTER the \n\nCurrent time: line
    - s.kind !== 'script' filter in buildScheduleBlock (sensor schedules are ambient state, not awareness items)
    - vi.mock hoisted at module top + workspacePath in fixture config so mock call site is reachable
key_files:
  created: []
  modified:
    - src/head/assembler.ts
    - src/head/assembler.test.ts
    - src/head/activation.ts
    - src/head/activation.test.ts
    - src/sub-agents/tool-surface.ts
    - src/scheduler/prompts/tasks.md
decisions:
  - D-48-03-THREE-CALL-SITES: activation.ts had three readAmbientContext() call sites (lines 1136, 1213, and one discovered mid-implementation at a different indentation level). All three replaced with scanAmbient() via workspacePath ternary guard. The plan named two; the third was caught by tsc-clean verification.
  - D-48-03-WORKSPACEPATH-FIXTURE: activation.test.ts makeFixture config lacked workspacePath, so the scanAmbient call site was never reached (ternary returned '' before calling scanAmbient). Added workspacePath: tmpDir to the config object. Existing tests unaffected because tmpDir has no ambient/ directory — scanAmbient returns '' for all legacy tests.
metrics:
  duration: "5min"
  completed: "2026-06-17"
  tasks_completed: 2
  files_created: 0
  files_modified: 6
---

# Phase 48 Plan 03: Ambient Injection Repoint + Legacy Deletion Summary

**One-liner:** Deleted the cache-busting AMBIENT.md injection (above the cache marker) and replaced all three ambient read sites with `scanAmbient()` placed after the `\n\nCurrent time:` uncached-region marker, plus filtered `kind:'script'` schedules out of the head's awareness block.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1: Assembler — delete AMBIENT.md, inject scanAmbient uncached, filter script schedules | a52cca8 | src/head/assembler.ts, src/head/assembler.test.ts |
| 2: Activation + tool-surface + prompt template — delete readAmbientContext, repoint both proactive sites + sub-agent prompt, scrub stale doc reference, add behavioral test | 4d465d1 | src/head/activation.ts, src/head/activation.test.ts, src/sub-agents/tool-surface.ts, src/scheduler/prompts/tasks.md |

## What Was Built

### Task 1 — `src/head/assembler.ts`

**Deleted:** The `## Ambient Context` + AMBIENT.md read block (lines 114–121 original) that was injected ABOVE the `\n\nCurrent time:` cache-split marker — the cache-busting bug (T-48-08).

**Added:** `import { scanAmbient } from '../sensors/scan.js'` and a new injection block immediately AFTER the schedule block (which itself comes after `Current time:`):
```typescript
if (this.config.workspacePath) {
  const resolvedWorkspace = this.config.workspacePath.replace(/^~/, os.homedir())
  const ambientBlock = scanAmbient(resolvedWorkspace)
  if (ambientBlock) systemPrompt += `\n\n${ambientBlock}`
}
```

**Added:** `s.kind !== 'script'` to `buildScheduleBlock()`'s filter so sensor schedules never appear in the head's schedule-awareness text (Pitfall 5 from RESEARCH.md).

**Tests added (4):**
- `## Weather` block lands AFTER `\n\nCurrent time:` (the placement invariant — T-48-08 behavioral pin)
- No ambient block when `ambient/` is absent (empty return)
- Legacy root-level `AMBIENT.md` content does NOT appear (D-09 / SENSOR-12)
- `kind:'script'` schedule excluded from awareness block; `kind:'task'` still included (Pitfall 5)

### Task 2 — `src/head/activation.ts`

**Deleted:** `private readAmbientContext(): string { … }` method (SENSOR-12). Three call sites replaced:

```typescript
// Was:
ambientContext: this.readAmbientContext(),

// Now at both proactive branches (lines ~1136 + ~1213):
ambientContext: this.opts.config.workspacePath
  ? scanAmbient(this.opts.config.workspacePath.replace(/^~/, os.homedir()))
  : '',
```

The plan named two call sites; a third was discovered at different indentation (handled by Rule 1 auto-fix — caught by tsc).

**Tests added (2 behavioral):**
- REMINDER branch: mocked `scanAmbient` returning sentinel string `'## SENTINEL-AMBIENT\nsentinel-body'` reaches the `ambientContext` field of `ReminderDecisionContext` (SENSOR-11 coverage)
- TASK branch: same mocked sentinel reaches the `ambientContext` field of `ProactiveContext` at the task branch

Added `workspacePath: tmpDir` to the test fixture config so the `workspacePath` ternary guard is traversable (deviation D-48-03-WORKSPACEPATH-FIXTURE — Rule 1 bug fix, no behavior change for legacy tests).

### Task 2 — `src/sub-agents/tool-surface.ts`

**Deleted:** The AMBIENT.md read block in `buildSystemPrompt()`.

**Added:** scanAmbient injection immediately AFTER the `Current time:` line (no `~` expansion — `deps.workspacePath` is already resolved):
```typescript
if (deps.workspacePath) {
  const ambientBlock = scanAmbient(deps.workspacePath)
  if (ambientBlock) prompt += `\n\n${ambientBlock}`
}
```

`fs` and `path` imports retained (still used by `listDirTree` and `buildTasksBlurb`).

### Task 2 — `src/scheduler/prompts/tasks.md`

Changed line 44 from:
> "The task agent already has ambient context (AMBIENT.md) in its system prompt"

to:
> "The task agent already has ambient context (from the `ambient/` sensor scan) in its system prompt"

## Verification Results

```
npx vitest run src/head src/sub-agents  →  350/350 tests passed (22 test files)
npx tsc --noEmit                        →  clean
grep -rln "AMBIENT.md" src/ | grep -v test  →  (none)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Third readAmbientContext() call site missed by plan**
- **Found during:** Task 2 implementation, when running tests revealed `this.readAmbientContext is not a function` errors
- **Issue:** activation.ts had THREE call sites for `readAmbientContext()` (at lines ~1136, ~1213, and one at a different indentation level). The plan named two; the third was at 8-space indentation vs 10-space for the other two, so `replace_all` on the first matched string only captured two.
- **Fix:** Manually found and replaced the third call site with the same scanAmbient() ternary pattern
- **Files modified:** src/head/activation.ts
- **Commit:** 4d465d1

**2. [Rule 1 — Bug] Test fixture config missing workspacePath**
- **Found during:** Task 2, when new SENSOR-11 behavioral tests showed `ambientContext` receiving `''` despite the mock
- **Issue:** `makeFixture()` in activation.test.ts built a `config` object without `workspacePath`, so the `workspacePath ? scanAmbient(...) : ''` ternary always returned `''` — the mock was never called
- **Fix:** Added `workspacePath: tmpDir` to the config object in `makeFixture`. Legacy tests unaffected (tmpDir has no `ambient/` directory; `scanAmbient` returns `''` for them)
- **Files modified:** src/head/activation.test.ts
- **Commit:** 4d465d1

## Stub Tracking

No stubs. All ambient injection is wired to live `scanAmbient()` calls.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced beyond what the plan's threat model already covers. T-48-08 (cache marker placement) is the mitigated threat; the behavioral test pins the invariant.

## Self-Check: PASSED

- [x] `src/head/assembler.ts` modified — FOUND (contains `scanAmbient`, no `AMBIENT.md`)
- [x] `src/head/assembler.test.ts` modified — FOUND (4 new tests in Phase 48 describe block)
- [x] `src/head/activation.ts` modified — FOUND (contains `scanAmbient` x3, no `readAmbientContext`, no `AMBIENT.md`)
- [x] `src/head/activation.test.ts` modified — FOUND (2 new behavioral tests in SENSOR-11 describe block)
- [x] `src/sub-agents/tool-surface.ts` modified — FOUND (contains `scanAmbient`, no `AMBIENT.md`)
- [x] `src/scheduler/prompts/tasks.md` modified — FOUND (no `AMBIENT.md`)
- [x] Commit a52cca8 exists — FOUND
- [x] Commit 4d465d1 exists — FOUND
