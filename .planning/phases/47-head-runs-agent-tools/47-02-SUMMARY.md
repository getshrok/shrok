---
phase: 47-head-runs-agent-tools
plan: "02"
subsystem: dashboard-tools-api
tags: [tool-registry, layer-tagging, dashboard-api, typescript]
dependency_graph:
  requires: [47-01]
  provides: [head-layer-tagging, ported-tools-in-head-picker]
  affects: [src/dashboard/routes/tools.ts, src/dashboard/routes/tools.test.ts]
tech_stack:
  added: []
  patterns:
    - "Seed headSet/allNames from HEAD_TOOL_NAMES ∪ HEAD_RUNNABLE_TOOL_NAMES so ported agent tools tag as dual ('head' + 'agent')"
    - "ToolLayer / ToolRegistryEntry types and the route handler left byte-unchanged — only the set-union seeding changed"
key_files:
  created: []
  modified:
    - src/dashboard/routes/tools.ts
    - src/dashboard/routes/tools.test.ts
decisions:
  - "D-12: ported agent tools (HEAD_RUNNABLE_TOOL_NAMES) carry layers ['head','agent'] in /api/tools so they surface in the existing Phase 46 head picker"
  - "D-02 preserved: dual tagging changes only what the picker can offer; out-of-box behavior is unchanged because the tools remain opt-in via the Phase 46 assignment UI"
  - "Zero dashboard component changes — HeadCard, BehaviorTab, KindEditorPage, TagSelect already filter by layers.includes(), so retagging is sufficient (git status --porcelain dashboard/src/ empty)"
---

# Plan 47-02 Summary: Retag ported agent tools with the `head` layer

## What was built

Task 1 — `src/dashboard/routes/tools.ts`: `buildTaggedRegistry()` now seeds both
`headSet` and `allNames` from the union `HEAD_TOOL_NAMES ∪ HEAD_RUNNABLE_TOOL_NAMES`
(imported from `registry.ts`). As a result every ported agent tool now reports
`layers: ['head', 'agent']` instead of `['agent']`. `ToolLayer`, `ToolRegistryEntry`,
and the route handler are byte-unchanged; only the set construction and the JSDoc were
updated. The stale `bash is agent-only` assertion was inverted to assert bash is dual.

Task 2 — `src/dashboard/routes/tools.test.ts`: added 6 tests — positive assertions that
`read_file`, `write_note`, `create_reminder`, `create_schedule`, and `bash` all carry
`'head'`; a parametric sweep over all `HEAD_RUNNABLE_TOOL_NAMES`; and a shape invariant
asserting no extra keys on registry entries.

## Verification

- Confirmed by inspection that the dashboard components (`HeadCard`, `BehaviorTab`,
  `KindEditorPage`, `TagSelect`) filter by `layers.includes()` and require zero changes —
  `git status --porcelain dashboard/src/` is empty.
- `tools.test.ts` passes; full phase typecheck + test run green (see verification step).

## Commits

- `8ae44fd` feat(47-02): seed head layer tag from HEAD_RUNNABLE_TOOL_NAMES; invert stale bash test
- `03d747c` test(47-02): pin new head tags + shape invariant; verify zero dashboard component changes

## Note

This SUMMARY.md was reconstructed by the orchestrator after the executor wrote it in its
worktree but did not commit it before the worktree was removed (#2070). Content is derived
from the executor's completion report and the committed diff (`8ae44fd..03d747c`).
