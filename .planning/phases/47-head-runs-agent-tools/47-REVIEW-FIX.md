---
phase: 47-head-runs-agent-tools
fixed_at: 2026-06-07T23:49:02Z
review_path: .planning/phases/47-head-runs-agent-tools/47-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 47: Code Review Fix Report

**Fixed at:** 2026-06-07T23:49:02Z
**Source review:** .planning/phases/47-head-runs-agent-tools/47-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (1 Critical + 3 Warning; Info finding IN-01 out of scope for critical_warning)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: `get_usage` native head case violates model-time invariant — raw user input reaches storage layer

**Files modified:** `src/head/index.ts`
**Commit:** a310c15
**Applied fix:** Rewrote the head's native `get_usage` case to route the model-supplied `since` through `parseModelTime(sinceRaw, tz)` (catching parse errors and returning a structured error), pass `parsed.toISOString()` to `usageStore.getSummary()`, and echo back the workspace-local `formatModelTime(parsed, tz)` on output — mirroring `buildUsageTool` in registry.ts. Added the `import { formatModelTime, parseModelTime } from '../util/model-time.js'` import. This brings the head handler into compliance with the AGENTS.md model-time invariant (no UTC reaches the model on input or output). Verified via full `tsc --noEmit` (clean) and head test suites.

### WR-01: `bash_no_net` exclusion from `HEAD_RUNNABLE_TOOL_NAMES` is undocumented in the gate comment and untested

**Files modified:** `src/dashboard/routes/tools.test.ts`, `src/dashboard/routes/heads.ts`, `src/dashboard/routes/settings.ts`
**Commit:** e955264
**Applied fix:** Added a dedicated test in `tools.test.ts` asserting `bash_no_net` carries exactly `['agent']` in its layers (so any future change that makes it head-assignable fails loudly). Added a clarifying comment in both the `heads.ts` and `settings.ts` head-direction membership gate blocks noting that `bash_no_net` is intentionally absent from `HEAD_RUNNABLE_TOOL_NAMES` (it uses `unshare -n`, blocked in many environments) and that operators assign plain `bash` instead. Verified via `tsc --noEmit` (clean) and `tools.test.ts` (all pass).

### WR-02: `update_schedule` is head-runnable but absent from the base `config.json` agent allowedTools

**Files modified:** `src/sub-agents/registry.ts`, `src/dashboard/routes/tools.test.ts`
**Commit:** 211ba43
**Applied fix:** Chose option (b) from the review — kept shipped agent defaults unchanged and instead made the head-runnable schedule set consistent with the base config. Added a `HEAD_RUNNABLE_SCHEDULE_EXCLUDES` set (`['update_schedule']`) and filtered `SCHEDULE_TOOL_NAMES` through it when building `HEAD_RUNNABLE_TOOL_NAMES`, with a JSDoc note mirroring the existing `bash_no_net` exclusion explaining why (the base `config.json` ships create/list/delete_schedule but not update_schedule, so head-running it would be a surprising asymmetry). Option (a) — adding `update_schedule` to `config.json` — was rejected because it changes shipped agent defaults and the "25-tool" count is referenced across `system.ts`, `tool-access.ts`, and `enforcement.test.ts`, making it a wider behavior change. Added two tests in `tools.test.ts`: one asserting `update_schedule` is agent-only (`['agent']`), and one asserting `HEAD_RUNNABLE_TOOL_NAMES` excludes `update_schedule` but includes the other three schedule tools. Verified via `tsc --noEmit` (clean) and the tools/head/heads/settings/enforcement suites (all pass).

### WR-03: The `default` branch in `dispatch()` falls through silently when `entry` is undefined

**Files modified:** `src/head/index.ts`
**Commit:** 9c1d25d
**Applied fix:** Added an explicit `else` to the `default` branch's `if (entry !== undefined)` block so the unknown-tool error return is structurally unambiguous and self-documenting for future readers. No behavior change — purely a clarity improvement as requested. Verified via `tsc --noEmit` (clean) and head test suites (all pass).

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-06-07T23:49:02Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
