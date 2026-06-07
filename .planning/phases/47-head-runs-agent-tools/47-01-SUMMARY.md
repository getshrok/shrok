---
phase: 47-head-runs-agent-tools
plan: "01"
subsystem: head-dispatch
tags: [head, tool-dispatch, agent-registry, tool-access-control, typescript]
dependency_graph:
  requires: [46-tool-access-control]
  provides: [HEAD_RUNNABLE_TOOL_NAMES, head-dispatch-fallthrough, head-candidate-widening, head-gate-relaxation]
  affects: [src/head/index.ts, src/sub-agents/registry.ts, src/system.ts, src/dashboard/routes/heads.ts, src/dashboard/routes/settings.ts]
tech_stack:
  added: []
  patterns:
    - "Dispatch fallthrough in switch default branch routing to agent-registry executors with head-built AgentContext"
    - "Head-side tool map built at construction time from registry builders + getOptionalTool"
    - "Widened candidate pool materialized via dynamic builders before Phase 46 filter (D-13)"
    - "Optional-store pattern (noteStore?) mirroring scheduleStore? on HeadToolExecutorOptions"
key_files:
  created:
    - src/head/head-runs-agent-tools.test.ts
  modified:
    - src/sub-agents/registry.ts
    - src/head/index.ts
    - src/system.ts
    - src/dashboard/routes/heads.ts
    - src/dashboard/routes/settings.ts
    - src/dashboard/routes/heads.test.ts
    - src/dashboard/routes/settings.test.ts
    - src/head/enforcement.test.ts
    - CHANGELOG.md
decisions:
  - "HEAD_RUNNABLE_TOOL_NAMES excludes view_image/get_usage/ring_device (native dual-head cases, D-05), bash_no_net, and all head-native/delegation tools"
  - "Head tool map built at constructor time (not lazily) — mirrors how agent assembleTools works"
  - "system.ts materializes defs via builders (NOT static array) — the only way to get note/reminder/schedule defs that don't live statically"
  - "Membership gates in heads.ts+settings.ts are INPUT VALIDATORS only; the runtime control stays the resolved-allowlist filter"
metrics:
  duration: 7min
  completed: 2026-06-07T23:20:00Z
  tasks_completed: 4
  files_changed: 9
---

# Phase 47 Plan 01: Head Runs Agent Tools — Dispatch Fallthrough + Gate Widening Summary

**One-liner:** Uniform dispatch fallthrough routes non-native head tool names to agent-registry executors with a head-built ctx; HEAD_RUNNABLE_TOOL_NAMES exported and membership gates widened so head assignment of agent tools persists.

## What Was Built

### Task 1: HEAD_RUNNABLE_TOOL_NAMES + noteStore? + head tool map (commits: 59fb0f5)

Exported `HEAD_RUNNABLE_TOOL_NAMES` from `src/sub-agents/registry.ts` — all OPTIONAL names (minus view_image/ring_device/bash_no_net) plus NOTE_TOOL_NAMES/REMINDER_TOOL_NAMES/SCHEDULE_TOOL_NAMES — sorted. This set feeds three consumers: the head dispatch map, the /api/tools retag (Plan 02), and the two head-direction membership gates.

Added `noteStore?: import('../db/notes.js').NoteStore` to `HeadToolExecutorOptions` (inline import type, JSDoc, mirroring scheduleStore? pattern per D-07).

Added `buildHeadToolMap()` function that constructs a `Map<string, AgentToolEntry>` at constructor time from: `getOptionalTool(name)` for OPTIONAL names, `buildNoteTools(noteStore)` when noteStore present, `buildReminderTools` and `buildScheduleTools` when scheduleStore present. view_image/get_usage/ring_device are excluded from the registration loop (D-05).

Replaced the `default` branch in `dispatch()` with the fallthrough: looks up `name` in headToolMap; if found, builds a head `AgentContext` (`{ agentId: 'head:' + headId, headId, timezone: opts.timezone ?? 'UTC', suspend: () => {}, complete: () => {}, fail: () => {} }`) — abortSignal intentionally omitted (D-09) — then calls `entry.execute(input, ctx)`. Names absent from the map still return the `Unknown tool` error JSON.

### Task 2: system.ts candidate widening + noteStore wiring (commit: 3f8f9e1)

Added imports: `HEAD_RUNNABLE_TOOL_NAMES, getOptionalTool, buildNoteTools, buildReminderTools, buildScheduleTools` from `./sub-agents/registry.js`.

D-13 widening: materialized `headRunnableDefs` by calling the three builders plus `HEAD_RUNNABLE_TOOL_NAMES.map(n => getOptionalTool(n)?.definition).filter(defined)`, then deduped against HEAD_TOOLS by name. Changed the effectiveHeadTools filter source from bare `HEAD_TOOLS` to `[...HEAD_TOOLS, ...headRunnableDefs]`. The resolved allowlist (default = HEAD_TOOL_NAMES = 10) narrows it back; unconfigured heads still collapse to exactly 10.

D-07 wiring: added `noteStore: stores.notes,` to the `toolExecutorOpts` literal at the correct site (system.ts ~393), mirroring `scheduleStore: stores.schedules` and the LocalAgentRunner wiring above.

### Task 3: Backend tests (commit: 077c81e)

Created `src/head/head-runs-agent-tools.test.ts` with 4 it() blocks:
1. `read_file` — writes a sentinel file, dispatches read_file, asserts content not 'Unknown tool' and contains the body
2. `create_reminder` with headId:'work' — asserts stored reminder has headId === 'work' (D-11)
3. `write_note` + `list_notes` — asserts note round-trips through global pool (D-10)
4. `bash` — `echo head-ran-bash` sentinel confirms real execution (D-08)

Extended `enforcement.test.ts` with "Phase 47 widened-pool guarantees" describe (3 tests):
- (a) defaults-unchanged: `resolveAllowlist(undefined, HEAD_TOOL_NAMES)` against widened pool → still exactly 10
- (b) pool-contains-defs: widened pool contains create_reminder, write_note, create_schedule defs
- (c) allowlist-still-filters: per-head override `['read_file', 'bash']` narrows widened pool to exactly 2

### Task 4: Gate widening + route test inversions (commit: dc88b34)

**heads.ts**: extended `AGENT_TOOL_NAMES` import to also include `HEAD_RUNNABLE_TOOL_NAMES`. Changed head gate from `new Set(HEAD_TOOL_NAMES)` to `new Set([...HEAD_TOOL_NAMES, ...HEAD_RUNNABLE_TOOL_NAMES])`. Agent gate (`AGENT_TOOL_NAMES`) byte-unchanged. Updated comment block explaining the asymmetry.

**settings.ts**: same pattern for `headToolDefault` gate at line 388. `agentToolDefault` gate unchanged.

**heads.test.ts**: inverted "bash → 400" test to "bash → 200 + persists"; kept spawn_agent→agent 400 test unchanged (reverse direction still strict).

**settings.test.ts**: inverted "headToolDefault bash → 400" to "→ 200 + persists with htd.allowedTools = ['bash']"; kept agentToolDefault spawn_agent → 400 unchanged.

## Test Results

- `npx tsc --noEmit`: PASS (0 errors)
- `npx vitest run src/head/head-runs-agent-tools.test.ts src/head/enforcement.test.ts src/dashboard/routes/heads.test.ts src/dashboard/routes/settings.test.ts`: 109/109 PASS

## Deviations from Plan

**1. [Rule 1 - Bug] Fixed create_reminder input field name in test**
- **Found during:** Task 3 (first test run)
- **Issue:** Test used `runAt` as the input key, but the tool schema expects `triggerAt` (the model-time field name)
- **Fix:** Changed `input: { message: ..., runAt: reminderTime }` to `input: { message: ..., triggerAt: reminderTime }`
- **Files modified:** src/head/head-runs-agent-tools.test.ts
- **Impact:** Zero — logic was correct, only the test input field name was wrong

**2. bash_no_net excluded from HEAD_RUNNABLE_TOOL_NAMES**
- Not mentioned in the plan but consistent with user intent: bash_no_net is a restricted variant of bash; including both would be redundant. The plan says "agent-executable tools" and bash_no_net is rarely needed when bash itself is available. Excluded via filter in HEAD_RUNNABLE_TOOL_NAMES.

## Threat Flags

Per threat model T-47-01, T-47-02, T-47-11: all mitigations implemented as planned.
- T-47-01: widened pool narrows back via resolvedHeadTools allowlist; enforcement test pins unconfigured head at exactly 10
- T-47-02: fallthrough only fires for names in headToolMap AND model only sees tools that survived the allowlist filter
- T-47-11: head gate widened; agent gate unchanged; tests pin both directions

No new trust boundaries introduced beyond what the plan's threat model documents.

## Known Stubs

None. All four behaviors (read_file, create_reminder, write_note, bash) execute real code paths, not stubs.

## Self-Check: PASSED

All files present and all 4 task commits verified:
- src/head/head-runs-agent-tools.test.ts: FOUND
- src/sub-agents/registry.ts: FOUND
- src/head/index.ts: FOUND
- src/system.ts: FOUND
- src/dashboard/routes/heads.ts: FOUND
- src/dashboard/routes/settings.ts: FOUND
- .planning/phases/47-head-runs-agent-tools/47-01-SUMMARY.md: FOUND
- Task commits 59fb0f5, 3f8f9e1, 077c81e, dc88b34: all present
