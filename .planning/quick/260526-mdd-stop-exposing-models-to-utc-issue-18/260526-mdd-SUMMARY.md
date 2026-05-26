---
phase: quick-260526-mdd
plan: 01
subsystem: registry / model-time
tags: [time, model-facing, invariant, issue-18, DST, tool-boundary]
dependency_graph:
  requires: []
  provides: [model-time-invariant, parseModelTime, formatModelTime, formatPastTimeError]
  affects: [src/sub-agents/registry.ts, src/head/index.ts, src/sub-agents/tool-surface.ts, src/types/agent.ts, src/sub-agents/local.ts, AGENTS.md]
tech_stack:
  added: [src/util/model-time.ts, src/util/model-time.test.ts, src/sub-agents/registry.test.ts]
  patterns: [tool-boundary parse/render chokepoint, past-time guard, DST-safe local→UTC resolution]
key_files:
  created:
    - src/util/model-time.ts
    - src/util/model-time.test.ts
    - src/sub-agents/registry.test.ts
  modified:
    - src/sub-agents/registry.ts
    - src/head/index.ts
    - src/sub-agents/tool-surface.ts
    - src/types/agent.ts
    - src/sub-agents/local.ts
    - AGENTS.md
    - src/sub-agents/agents.test.ts
decisions:
  - "DST spring-forward gap: parseModelTime throws (non-existent local time); documented in JSDoc"
  - "DST fall-back ambiguous: parseModelTime returns first occurrence (earlier UTC = pre-shift offset); documented in JSDoc"
  - "AgentContext.timezone is optional (not required) to avoid breaking dozens of existing test fixtures; local.ts populates it; executeGetFileInfo falls back to UTC when absent"
  - "buildUsageTool signature widened to (usageStore, timezone) — single caller in tool-surface.ts updated"
  - "OPTIONAL_TOOLS remains a static const Map (not converted to factory); get_file_info reads timezone from ctx.timezone ?? 'UTC'"
  - "agents.test.ts: 17 triggerAt usages updated from '2099-01-01T09:00:00Z' to '2099-01-01 09:00' (canonical format) — these were testing old broken behavior"
metrics:
  duration: 11min
  completed: "2026-05-26"
  tasks: 4
  files: 10
---

# Phase quick-260526-mdd Plan 01: Stop Exposing Models to UTC (Issue #18) Summary

**One-liner:** Enforces project-wide model-time invariant — parseModelTime/formatModelTime chokepoints at every tool boundary, eliminating UTC exposure to LLMs and closing issue #18.

## What Was Built

### Task 1: model-time helper module (TDD)

New file `src/util/model-time.ts` exports:
- `formatModelTime(date, tz)` — returns `YYYY-MM-DD HH:MM` (24-hour, workspace-local). Handles the `"24"` → `"00"` midnight bug in some Intl implementations. Never throws; falls back to UTC on invalid/falsy zone.
- `parseModelTime(s, tz)` — strict parser for canonical local format. Rejects any input with `Z`, a `+HH:MM`/`-HH:MM` offset, or trailing alphabetic token. DST-safe local→UTC resolution (candidate-shift-verify algorithm). Spring-forward gap throws; fall-back ambiguous returns first occurrence.
- `formatPastTimeError(parsed, now, tz)` — single-line error message for past-time guard, containing both timestamps in canonical format, the zone name, and the literal phrase "pick a time in the future".

29 tests in `src/util/model-time.test.ts` covering all cases.

### Task 2: Input description rewrites + parse/guard

**Four descriptions rewritten (before → after):**

| Tool | Property | Before | After |
|------|----------|--------|-------|
| `get_usage` (registry.ts) | `since` | `'ISO timestamp to filter from (e.g. "2026-04-15T00:00:00Z" for today UTC)...'` | ``'Enter a start date and time in workspace-local format: `YYYY-MM-DD HH:MM` ...'`` |
| `create_schedule` | `runAt` | `'ISO datetime for one-time schedules.'` | ``'One-time fire date and time in workspace-local format: `YYYY-MM-DD HH:MM` ...'`` |
| `update_schedule` | `runAt` | `{ type: 'string' }` (bare, no description) | ``'Updated one-time fire date and time in workspace-local format: `YYYY-MM-DD HH:MM` ...'`` |
| `create_reminder` | `triggerAt` | `'The first (or only) fire time as an ISO 8601 datetime (e.g. "2026-04-01T09:00:00Z")...'` | ``'The first (or only) fire time in workspace-local format: `YYYY-MM-DD HH:MM` ...'`` |
| `get_usage` (head/index.ts) | `since` | Same old UTC text | Same new canonical text |

Each execute() path now:
1. Calls `parseModelTime(input, timezone)` — rejects Z-suffix/offsets/IANA tokens with a structured `{ error: true, message }` response
2. Applies a 30-second past-time guard for `create_reminder` and `create_schedule`
3. Returns `formatPastTimeError(parsed, now, tz)` message on past-time violation

**buildUsageTool signature change:** `buildUsageTool(usageStore)` → `buildUsageTool(usageStore, timezone)`. Single caller in `tool-surface.ts` updated to pass `deps.timezone`.

**`get_usage` response `since` field:** now echoes the canonical local string (e.g. `"2026-04-15 09:00"`) instead of the raw input.

### Task 3: Output renderer fixes

Three tools rewritten to emit canonical-format time fields:

- **`list_schedules`**: Added `renderScheduleForModel(row, tz)` helper that converts `runAt`, `nextRun`, `lastRun`, `createdAt`, `updatedAt` through `formatModelTime`. Null fields stay null.
- **`list_reminders`**: `runAt` and `createdAt` converted through `formatModelTime`. Non-time fields (`id`, `message`, `cron`, `requiresAck`, `nagIntervalMinutes`) preserved bit-for-bit.
- **`get_file_info`**: `created`/`modified`/`accessed` converted through `formatModelTime`. Signature widened to `executeGetFileInfo(input, timezone)`. `AgentContext.timezone?: string` added as optional field; `local.ts` ctx construction populates it from `this.timezone`; OPTIONAL_TOOLS call site reads `ctx.timezone ?? 'UTC'`.

### Task 4: AGENTS.md invariant documentation

New subsection `## Model-facing time invariant (no UTC ever reaches the model)` added after the TypeScript section, containing:
1. The invariant statement (workspace-local `YYYY-MM-DD HH:MM`, no Z/offset/IANA suffix)
2. The two helpers and their file (`formatModelTime`, `parseModelTime` in `src/util/model-time.ts`)
3. The boundary rule (internal storage stays ISO UTC; rendering/parsing at tool boundary only)
4. The past-time guard (`create_reminder`/`create_schedule` reject times > 30s in the past)
5. The already-correct surfaces that must NOT be modified
6. Link: Closes #18

## Verified Safe: assembler.ts does not leak `createdAt` to the model

`src/head/assembler.ts` line 278–289: `getMessageContent()` switches on `msg.role` and extracts only `msg.content`, `msg.toolCalls`, or `msg.toolResults` text — never `createdAt`. The `this.messages.getRecent()` call returns `Message[]` rows but `createdAt` is stripped at the rendering layer before anything reaches the LLM context. No code change to `assembler.ts` needed or made.

## DST Disposition

- **Spring-forward gap** (`America/New_York` `2026-03-08 02:30` — non-existent): `parseModelTime` throws with a message naming the gap and suggesting the next valid time. Documented in JSDoc.
- **Fall-back ambiguous** (`America/New_York` `2026-11-01 01:30` — occurs twice): `parseModelTime` returns the **first occurrence** (earlier UTC instant, pre-shift offset = EDT). Algorithm documented in JSDoc: the candidate-shift approach naturally returns the earlier instant.

## Signature Changes and Updated Call Sites

| Change | File | Call site updated |
|--------|------|------------------|
| `buildUsageTool(usageStore, timezone)` | registry.ts | tool-surface.ts:241 |
| `executeGetFileInfo(input, timezone)` | registry.ts | OPTIONAL_TOOLS map entry |
| `AgentContext.timezone?: string` (optional) | types/agent.ts | local.ts ctx construction |
| `renderScheduleForModel(row, tz)` (new private helper) | registry.ts | list_schedules execute() |

## Already-Correct Surfaces (not modified per plan constraints)

- System-prompt `Current time:` line (`tool-surface.ts:83`) — uses `formatIanaTimeLine`, outputs human-readable text for model context, already correct
- Reminder-fire `currentTime` injection — already workspace-local formatted
- Sub-agent system-prompt `Current time:` — same as above
- `cronTimezone` descriptions — these describe an IANA zone name field, not a time format
- `nextRunAfter(...).toISOString()` in scheduler (head/index.ts:395, registry.ts) — internal DB storage, not model-facing

## Test Results

```
npx vitest run — 1864 passed | 1 skipped (1865 total)
  - src/util/model-time.test.ts: 29 passed
  - src/sub-agents/registry.test.ts: 38 passed (new)
  - src/sub-agents/agents.test.ts: 92 passed (17 triggerAt values updated to canonical format)
  - All other 103 test files: unchanged, all passing

npx tsc --noEmit — clean (no errors)
```

## Sentinel Checks

- `grep -rn '"[^"]*Z"' src/sub-agents/registry.ts src/head/index.ts | grep "description:"` → 0 matches
- `grep -c 'YYYY-MM-DD HH:MM' src/sub-agents/registry.ts` → 4 (all four target descriptions)
- `grep -c 'YYYY-MM-DD HH:MM' src/head/index.ts` → 1 (get_usage.since duplicate)
- `grep -n 'Model-facing time invariant' AGENTS.md` → line 68

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] agents.test.ts: 17 existing create_reminder tests used Z-suffixed triggerAt values**
- **Found during:** Task 2 (GREEN phase, running full test suite)
- **Issue:** `create_reminder` tests in `src/sub-agents/agents.test.ts` used `triggerAt: '2099-01-01T09:00:00Z'` — the exact old broken format that issue #18 documented as a bug. After `parseModelTime` was wired, these all returned `{ error: true }` instead of `{ ok: true }`.
- **Fix:** Updated all 17 occurrences to `'2099-01-01 09:00'` (canonical local format). This is a correctness fix — the old tests were testing the old broken behavior.
- **Files modified:** `src/sub-agents/agents.test.ts`
- **Commit:** 02c1dba

**2. [Rule 2 - Missing functionality] Added AgentContext.timezone as optional field**
- **Found during:** Task 3 (executeGetFileInfo needs timezone from runtime context)
- **Issue:** `OPTIONAL_TOOLS` is a static const Map with no closure access to workspace timezone. The plan's analysis suggested either adding `timezone` to `AgentContext` or converting to a factory.
- **Fix:** Added `timezone?: string` (optional) to `AgentContext` interface — lower-impact than factory conversion (which would require touching all OPTIONAL_TOOLS callers). The optional field means existing test fixtures remain valid without modification. `local.ts` ctx construction populates it from `this.timezone`.
- **Files modified:** `src/types/agent.ts`, `src/sub-agents/local.ts`
- **Commit:** 02c1dba

## Known Stubs

None.

## Threat Flags

No new security-relevant surfaces introduced. Changes are purely at the tool boundary parse/render layer.

## Self-Check: PASSED

- src/util/model-time.ts exists: FOUND
- src/util/model-time.test.ts exists: FOUND
- src/sub-agents/registry.test.ts exists: FOUND
- Commits e9c4b41, 02c1dba exist in git log: FOUND
- AGENTS.md contains 'Model-facing time invariant': FOUND (line 68)
- npx tsc --noEmit: CLEAN
- npx vitest run: 1864 passed
