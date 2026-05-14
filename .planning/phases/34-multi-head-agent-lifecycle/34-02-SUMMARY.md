---
phase: 34-multi-head-agent-lifecycle
plan: 02
subsystem: types
tags: [typescript, head_id, multi-head, type-contracts, spawn-options, agent-state, runner, executor]

requires:
  - phase: 33-multi-head-management-ui
    provides: required-at-type-level head_id contract pattern (D-12 MessageStore.append; D-INJECTOR-HEADID positional precedent considered and rejected for grab-bag options)
  - plan: 34-01
    provides: agents.head_id column + AgentRow.head_id field; the RED tsc errors at src/db/agents.ts:47 / :194 that this plan resolves
provides:
  - "SpawnOptions.headId: string — required field; type-enforces every spawn callsite to supply head identity"
  - "AgentState.headId: string — required field; rowToState() returns it as a plain (always-present) value"
  - "LocalAgentRunnerOptions.headId: string — required field at the top of the interface (identity, not grab-bag)"
  - "HeadToolExecutorOptions.headId: string — required field at the top of the interface; mirrors ActivationLoopOptions over InjectorImpl positional"
affects: [plan-03-local-agent-runner-headid, plan-04-system-wiring, plan-05-integration-tests]

tech-stack:
  added: []
  patterns:
    - "Required-at-type-level head identity on the spawn surface (SpawnOptions.headId, AgentState.headId) — extends Phase 33 D-12 (MessageStore.append) to the agent lifecycle"
    - "Option-field over positional ctor arg for HeadToolExecutorOptions.headId — chosen per D-EXEC-OPTION because the interface is already an options grab-bag (15+ fields); InjectorImpl's positional pattern is the precedent for 2-field constructors only"
    - "Interface contracts ship in Wave 1; implementation rides in Wave 2 — same cadence as Phase 33 D-WIDEN (Plan 33-01 widened DashboardEvent; Plan 33-03 wired consumers)"

key-files:
  created: []
  modified:
    - src/types/agent.ts
    - src/sub-agents/local.ts
    - src/head/index.ts

key-decisions:
  - "D-SPAWN-REQUIRED honored on both SpawnOptions.headId AND AgentState.headId — required, no optional variant, no silent 'default' fallback"
  - "D-RUNNER-HEADID interface-only: LocalAgentRunnerOptions.headId is required; class body deliberately untouched in this plan (Plan 03 lands `private readonly headId` + ctor read + 6 enqueue callsite edits)"
  - "D-EXEC-OPTION honored: HeadToolExecutorOptions.headId is an option field, NOT a 2nd positional ctor arg — JSDoc records the explicit rejection of InjectorImpl's pattern"
  - "headId placed at the TOP of LocalAgentRunnerOptions and HeadToolExecutorOptions (identity field), not in the optional grab-bag near the bottom"
  - "Plan 01's documented RED state (5 tsc errors at src/db/agents.ts and src/db/db.test.ts) is now fully resolved — the new tsc errors are at the spawn / runner / executor construction sites Plans 03/04 will mechanically wire"

patterns-established:
  - "Type-required head identity on the agent lifecycle surface — completes the multi-head type-safety trio (MessageStore.append per Phase 33 D-12, AppStateStore namespacing per Phase 30, now SpawnOptions/AgentState/LocalAgentRunner/HeadToolExecutor per Phase 34)"
  - "Interface-first wave cadence: Wave 1 contracts (Plans 01+02), Wave 2 implementations (Plans 03+04), Wave 3 integration (Plan 05) — mirrors Phase 33's D-WIDEN cadence and keeps each wave's diff under 15 lines of net change"

requirements-completed: []

duration: 2min
completed: 2026-05-14
---

# Phase 34 Plan 02: SpawnOptions / AgentState / Runner / Executor headId Contracts Summary

**One-liner:** Added `headId: string` as a **required** field to four interfaces (`SpawnOptions`, `AgentState`, `LocalAgentRunnerOptions`, `HeadToolExecutorOptions`) — the type-level enforcement that powers the rest of Phase 34. After this plan, `npx tsc --noEmit` flags every call site that must supply `headId`, turning Plans 03/04 into mechanical fixes.

## What Changed

### `src/types/agent.ts`

1. **`AgentState.headId: string`** — required field added after `trigger`. JSDoc: "Head this agent belongs to (Phase 34). Carried through the agents.head_id column."
2. **`SpawnOptions.headId: string`** — required field added after `trigger`. JSDoc cites D-SPAWN-REQUIRED and the no-silent-fallback rule.

No optional variants. The `AgentRunner` interface (`spawn(options: SpawnOptions)`) is untouched — the new field rides along on the options object.

### `src/sub-agents/local.ts`

`LocalAgentRunnerOptions.headId: string` — required field at the **top** of the interface (before `agentStore`, `inboxStore`, etc.) so it's flagged as core identity, not in the optional grab-bag near the bottom. JSDoc cites D-RUNNER-HEADID and the ActivationLoop "fixed at construction" pattern.

**Class body deliberately untouched in this plan.** The `private readonly headId` field, the ctor read of `opts.headId`, and the 6 `queueStore.enqueue(..., this.headId)` callsite edits ride in Plan 03 (Wave 2), exactly as designed in the plan's `<action>` block.

### `src/head/index.ts`

`HeadToolExecutorOptions.headId: string` — required field at the **top** of the interface. JSDoc cites D-EXEC-OPTION and explicitly records the rejection of InjectorImpl's positional pattern (this interface is already an options grab-bag with 15+ fields).

**Class body and `spawn_agent` dispatch case deliberately untouched in this plan.** Plan 04 (Wave 2) wires `headId: this.opts.headId` into the constructed `SpawnOptions` at the spawn_agent dispatch site, and `src/system.ts` adds `headId: deps.headId ?? 'default'` into the `toolExecutorOpts` object that `activation.ts:766` spreads into `new HeadToolExecutor(...)`.

## Deviations from Plan

None — plan executed exactly as written.

## Authentication Gates

None.

## Verification

- `grep -c "headId: string" src/types/agent.ts` → `2` (SpawnOptions + AgentState) ✓
- `grep -c "headId: string" src/sub-agents/local.ts` → `1` ✓
- `grep -c "headId: string" src/head/index.ts` → `1` ✓
- `grep -q "headId?:\s*string" src/types/agent.ts` → exit 1 (no optional variant) ✓
- `grep -q "headId?:\s*string" src/sub-agents/local.ts` → exit 1 (no optional variant) ✓
- `grep -q "headId?:\s*string" src/head/index.ts` → exit 1 (no optional variant) ✓
- `grep -E "this\.headId" src/sub-agents/local.ts` → no code matches (class body untouched per D-RUNNER-HEADID Wave 1/2 split) ✓
- `grep -E "this\.opts\.headId" src/head/index.ts` → exit 1 (class body untouched per D-EXEC-OPTION Wave 1/2 split) ✓
- `npx vitest run src/db/db.test.ts -t "AgentStore"` → 22 passed (Plan 01's tests stay green under the new type contract because Plan 01 already set `baseOptions.headId = 'default'` in the test fixture) ✓

### Wave 1 RED → Wave 2 GREEN handoff

Plan 01's SUMMARY documented 5 expected tsc errors as its Wave 1 RED state:

```
src/db/agents.ts(47,5): error TS2353: ... 'headId' does not exist in type 'AgentState'.
src/db/agents.ts(194,24): error TS2339: Property 'headId' does not exist on type 'SpawnOptions'.
src/db/db.test.ts(403,61): error TS2353: ... 'headId' does not exist in type 'SpawnOptions'.
src/db/db.test.ts(407,19): error TS2339: Property 'headId' does not exist on type 'AgentState'.
src/db/db.test.ts(419,29): error TS2339: Property 'headId' does not exist on type 'AgentState'.
```

`npx tsc --noEmit 2>&1 | grep -E "src/db/agents\.ts|src/db/db\.test\.ts"` after this plan → **no matches**. All five Plan 01 RED errors are resolved exactly as forecast.

The new tsc errors after Plan 02 are at the **construction sites** Plans 03/04 will wire mechanically:

- `src/head/activation.ts:1247` — SpawnOptions constructed for scheduled triggers (Plan 04 wires `headId: this.opts.headId`)
- `src/head/index.ts:171` — SpawnOptions constructed in the `spawn_agent` dispatch case (Plan 04 injects `headId: this.opts.headId`)
- `src/sub-agents/local.ts` and `scripts/eval/harness.ts` — LocalAgentRunner constructors (Plan 03 wires through buildSystem)
- `src/head/activation.test.ts:196`, `src/head/head.test.ts:249,620` — HeadToolExecutorOptions test fixtures (Plan 04 wires fixtures)
- `src/sub-agents/agents.test.ts:423,510,534,558,582,584,626,628,666,667` — Spawn / Runner test fixtures (Plan 03 wires fixtures)
- `scripts/eval/scenarios/*.ts` — Eval scenarios constructing SpawnOptions (Plan 03/04 wires `headId: 'default'`)

This is the **expected** Wave 1 RED state per the plan's `<acceptance_criteria>` and `<verification>`: "tsc surfaces compile errors at every call site needing the new field (the RED state)". Wave 2 plans (03, 04) mechanically resolve each one.

## Commits

| Hash      | Type | Description                                                            |
| --------- | ---- | ---------------------------------------------------------------------- |
| `187a5c6` | feat | add required headId: string to SpawnOptions and AgentState             |
| `1e86758` | feat | add required headId: string to LocalAgentRunnerOptions                 |
| `5917a49` | feat | add required headId: string to HeadToolExecutorOptions                 |

## Threat Flags

None — this plan only widens four internal TypeScript interfaces. No new HTTP / IPC / file / DB surface, no untrusted-input crossing, no authentication or authorization boundary changes. Per the plan's `<threat_model>`, T-34-05 / T-34-06 / T-34-07 are addressed by the required-at-type-level contracts established here (mitigation disposition for T-34-05 and T-34-07; accept for T-34-06).

## Self-Check: PASSED

- All 3 listed modified files (src/types/agent.ts, src/sub-agents/local.ts, src/head/index.ts) carry the required `headId: string` field per `grep -c "headId: string"`
- SUMMARY.md exists on disk at `.planning/phases/34-multi-head-agent-lifecycle/34-02-SUMMARY.md`
- All 3 commits (187a5c6, 1e86758, 5917a49) present in git log
- Plan 01's documented RED state is fully resolved (no remaining tsc errors at `src/db/agents.ts` or `src/db/db.test.ts`); the new tsc errors land exactly where Plans 03/04 will wire them
- All 22 AgentStore tests from Plan 01 remain green
