---
phase: "45"
plan: "04"
subsystem: ring
tags: [ring, tools, head-tools, optional-tools, tdd]
dependency_graph:
  requires: ["45-01", "45-02"]
  provides: ["ring_device tool on head surface", "ring_device tool on agent surface"]
  affects: ["src/head/index.ts", "src/sub-agents/registry.ts"]
tech_stack:
  added: []
  patterns: ["module-singleton init pattern (initRingTool/executeRingDevice)", "AgentToolEntry factory (buildRingDeviceTool)", "OPTIONAL_TOOLS static Map entry"]
key_files:
  created:
    - src/ring/tool.ts
    - src/ring/tool.test.ts
  modified:
    - src/head/index.ts
    - src/sub-agents/registry.ts
decisions:
  - "D-45-04-SINGLETON: executeRingDevice uses module-level singletons set by initRingTool so OPTIONAL_TOOLS Map entry can be static (matches all existing OPTIONAL_TOOLS entries — no factory)"
  - "D-45-04-DISPATCH-NOOP: head dispatch case returns {ok:true,note:'ring runner not configured'} when ringRunner absent — safe degradation for heads without HA"
  - "D-45-04-SOURCE-COERCE: source input outside 'alarm'/'timer' coerces to 'timer' (safe default); schema enum is primary guard"
  - "D-45-04-PREINIT-NOOP: executeRingDevice before initRingTool returns {ok:true,note:'ring not configured'} — never throws (RING-04)"
metrics:
  duration: "8min"
  completed: "2026-05-26"
  tasks: 2
  files: 4
---

# Phase 45 Plan 04: ring_device Dual-Surface Tool Registration Summary

**One-liner:** ring_device(start|stop) tool wired to HEAD_TOOLS dispatch and OPTIONAL_TOOLS Map via module-singleton init pattern, with HA-absent no-op on both surfaces.

## What Was Built

### Task 1: src/ring/tool.ts + src/ring/tool.test.ts (TDD)

- `RING_DEVICE_DEF`: ToolDefinition with `action` enum `['start', 'stop']` (required) and optional `source` string. Satisfies RING-03 enum constraint (T-45-04-ENUM mitigated).
- `buildRingDeviceTool(runner, getHaAdapter)`: AgentToolEntry factory. Resolves adapter via `getHaAdapter(ctx.headId)`; returns `{ok:true,note:'no HA channel for this head'}` when null (RING-04); calls `runner.start(adapter, source)` or `runner.stop(adapter)`.
- `initRingTool(runner, getHaAdapter)`: Sets module-level singletons once at startup.
- `executeRingDevice(input, ctx)`: Delegates to singletons; pre-init returns `{ok:true,note:'ring not configured'}` (never throws).
- 16 tests: schema assertions, factory no-HA path, factory with-adapter start/stop/default-source, pre-init singleton no-op, post-init routing.

### Task 2: src/head/index.ts + src/sub-agents/registry.ts (TDD)

- `HEAD_TOOLS`: `RING_DEVICE_DEF` appended after `acknowledge_reminder`.
- `HeadToolExecutorOptions.ringRunner?`: Optional `RingRunner` (mirrors `scheduleStore?`). Existing callers tsc-clean with no changes.
- dispatch `case 'ring_device'`: Guards `if (!this.opts.ringRunner)` → `{ok:true,note:'ring runner not configured'}`; else `dispatchForHead(headId, action, source)`.
- `OPTIONAL_TOOLS` Map: `['ring_device', { definition: RING_DEVICE_DEF, execute: async (input, ctx) => executeRingDevice(input, ctx) }]`.
- 2 new membership tests (RING-03): `HEAD_TOOLS.some(t => t.name === 'ring_device')` and `OPTIONAL_TOOL_NAMES.includes('ring_device')`.

## Verification

- `npx tsc --noEmit`: clean (0 errors)
- `npx vitest run src/ring/ src/head/ src/sub-agents/`: 312/312 passing (20 test files)

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The tool delegates all HA REST work to RingRunner (token safety enforced there per Plan 02 D-05). T-45-04-ENUM: action enum schema + runtime coerce in place. T-45-04-XHEAD: tool resolves only caller's headId. T-45-04-NOOP: all no-op paths return `{ok:true}` without throwing.

## Known Stubs

None — all return paths produce real values; no hardcoded placeholders in executable paths.

## Self-Check

Files exist:
- src/ring/tool.ts ✓
- src/ring/tool.test.ts ✓
- src/head/index.ts (modified) ✓
- src/sub-agents/registry.ts (modified) ✓

Commits exist:
- 7634955: feat(45-04): RING_DEVICE_DEF + buildRingDeviceTool + initRingTool/executeRingDevice singletons ✓
- 2f62cb9: feat(45-04): register ring_device on HEAD_TOOLS + dispatch + OPTIONAL_TOOLS (RING-03/04) ✓

## Self-Check: PASSED
