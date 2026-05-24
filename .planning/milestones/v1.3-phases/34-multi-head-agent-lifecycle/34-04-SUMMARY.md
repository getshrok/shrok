---
phase: 34-multi-head-agent-lifecycle
plan: 04
subsystem: system-wiring
tags: [typescript, head_id, multi-head, system-wiring, build-system, head-tool-executor, spawn-options]

requires:
  - plan: 34-01
    provides: AgentStore.create() consumes options.headId (the persistence sink for what this plan wires)
  - plan: 34-02
    provides: SpawnOptions.headId / LocalAgentRunnerOptions.headId / HeadToolExecutorOptions.headId required-at-type-level fields (this plan supplies them at the construction sites)
  - plan: 34-03
    provides: LocalAgentRunner reads opts.headId in the ctor and threads `this.headId` through all 6 enqueue callsites (this plan supplies opts.headId to that ctor from buildSystem)
provides:
  - "buildSystem() supplies `headId: deps.headId ?? 'default'` to the LocalAgentRunner ctor options — every per-head System has a runner stamped with the correct head"
  - "buildSystem() supplies `headId: deps.headId ?? 'default'` to the toolExecutorOpts object — flows through to HeadToolExecutor via the activation.ts:766 spread"
  - "HeadToolExecutor.dispatch() spawn_agent case injects `headId: this.opts.headId` into the constructed SpawnOptions — agents spawned via head tools inherit the spawning head's identity"
  - "ActivationLoop scheduled-trigger SpawnOptions construction (activation.ts:1247) sets `headId: this.opts.headId` — scheduled task spawns also inherit the head identity"
affects: [plan-05-integration-tests]

tech-stack:
  added: []
  patterns:
    - "Head identity wired at the constructor sites with `deps.headId ?? 'default'` mirroring the pre-existing ActivationLoop pattern at system.ts:359 — single fallback policy unifies CONF-02 (implicit default head) with the explicit multi-head case"
    - "No edit needed at the activation.ts:766 HeadToolExecutor construction site — the existing `{...this.opts.toolExecutorOpts, ...}` spread carries the new headId field through automatically once buildSystem adds it to toolExecutorOpts; one design choice avoids touching three files"
    - "All four SpawnOptions construction sites in production code now supply headId: (1) spawn_agent dispatch (head/index.ts) → this.opts.headId, (2) scheduled trigger (activation.ts:1247) → this.opts.headId, (3) handleSpawnAgent in LocalAgentRunner (Plan 03) → this.headId, (4) resumeSuspended (Plan 03) → state.headId. Plus AgentRunner stub in scripts/eval/harness.ts (Plan 05 scope)."

key-files:
  created: []
  modified:
    - src/head/index.ts
    - src/system.ts
    - src/head/activation.ts

key-decisions:
  - "D-EXEC-OPTION Wave 2 honored: HeadToolExecutor.dispatch() spawn_agent case injects `headId: this.opts.headId` into the SpawnOptions object literal, placed immediately after `trigger: 'manual'` to mirror the SpawnOptions interface ordering established in Plan 02. No `?? 'default'` fallback at this site — `this.opts.headId` is type-required by Plan 02's HeadToolExecutorOptions interface, so it is always a defined string."
  - "D-WIRING-IN-SYSTEM honored: src/system.ts is the single wiring point that consumes the per-head `deps.headId` value. Two new lines: `headId: deps.headId ?? 'default'` at the LocalAgentRunner instantiation (line 248) and at the toolExecutorOpts object (line 335). The pre-existing ActivationLoop wiring at line 359 already used this pattern; this plan extends it to the runner and executor."
  - "No edit at src/head/activation.ts:766 — per the canonical_refs in CONTEXT.md, the `new HeadToolExecutor({ ...this.opts.toolExecutorOpts, ... })` spread already carries the new field. The plan's <action> block explicitly notes (checker I1) that an explicit `headId: this.opts.headId` override would be functionally equivalent but redundant: both `ActivationLoopOptions.headId` and `HeadToolExecutorOptions.headId` resolve to the same `deps.headId ?? 'default'` source."
  - "Auto-fix Rule 3 applied at src/head/activation.ts:1247 (scheduled-trigger SpawnOptions): plan text omitted this site from <files_modified>, but Plans 02 and 03's SUMMARYs both explicitly forecast it as a Plan 04 fix. Without it, `npx tsc --noEmit` fails in production code (T2379 at activation.ts:1247) because Plan 02 made SpawnOptions.headId required. Threaded `headId: this.opts.headId` (ActivationLoop already has the field from Phase 30). One-line addition; treated as a deviation under Rule 3 (blocking issue: tsc red in production)."
  - "TDD-RED cadence skipped this plan — consistent with Plan 03's D-RED-SKIPPED rationale: the existing test fixtures in src/sub-agents/agents.test.ts, src/head/head.test.ts, src/head/activation.test.ts, src/sub-agents/cancel.test.ts, src/sub-agents/archival.test.ts, and scripts/eval/* are already runtime/type-RED from Plan 02's interface widening. Adding new RED commits would duplicate the failure surface that Plan 05's fixture wiring resolves. Plan 04 lands implementation only; verification via grep + tsc-clean-in-production + AgentStore tests still green."

patterns-established:
  - "Per-head construction-time identity binding is now complete for the agent lifecycle: ActivationLoop (Phase 30) + LocalAgentRunner (Plan 03 reads, Plan 04 supplies) + HeadToolExecutor (Plan 04 supplies + injects into spawn_agent dispatch). One value (`deps.headId ?? 'default'` at buildSystem boundary) → three constructors → every per-head System is fully isolated."
  - "Wave-2 finishing pattern: Wave 1 widened the contracts (Plans 01+02), Wave 2 wired the production callsites (Plans 03+04), Wave 3 will fix the test fixtures and eval scenarios (Plan 05). After Plan 04, production code is tsc-clean; remaining ~40 tsc errors are all at test/eval fixtures that Plan 05 mechanically updates."

requirements-completed: []

duration: 3min
completed: 2026-05-14
---

# Phase 34 Plan 04: System Wiring of head_id Into Runner and Executor Summary

**One-liner:** Wired `headId: deps.headId ?? 'default'` into the `LocalAgentRunner` ctor options and the `toolExecutorOpts` object inside `buildSystem()`, and made `HeadToolExecutor.dispatch()` inject `headId: this.opts.headId` into the SpawnOptions it constructs for `spawn_agent` — closing the per-head construction-time identity binding for the head-side wiring of the agent lifecycle.

## What Changed

### `src/head/index.ts`

`HeadToolExecutor.dispatch()` `spawn_agent` case (lines 170-188) now injects
`headId: this.opts.headId` into the constructed `SpawnOptions` object, placed
immediately after `trigger: 'manual'` to mirror the field ordering established
by Plan 02 in the `SpawnOptions` interface. No fallback — `this.opts.headId`
is type-required.

### `src/system.ts`

Two surgical edits inside `buildSystem()`:

1. **LocalAgentRunner instantiation (line 247-284):** added `headId: deps.headId ?? 'default'` as the first field of the options object (before `agentStore`), mirroring the identity-first ordering used by Plan 02 for `LocalAgentRunnerOptions`.
2. **toolExecutorOpts object (line 333-351):** added `headId: deps.headId ?? 'default'` as the first field (before `agentRunner`). The value flows through to `HeadToolExecutor` via the existing `{...this.opts.toolExecutorOpts, ...}` spread in `activation.ts:766` — no edit needed at the construction site.

### `src/head/activation.ts` (deviation under Rule 3)

Scheduled-trigger SpawnOptions construction at line 1247 — added `headId: this.opts.headId` into the `agentRunner.spawn({...})` call. The Plan 04 plan text did not list this file under `<files_modified>`, but Plans 02 and 03 SUMMARYs both forecast it as a Plan 04 fix. Without it, `npx tsc --noEmit` would fail in production code (Plan 02 made `SpawnOptions.headId` required). Auto-fixed per Rule 3 (blocking issue).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking Issue] Added `headId: this.opts.headId` to scheduled-trigger SpawnOptions at activation.ts:1247**

- **Found during:** Task 2 verification (`npx tsc --noEmit` showed `src/head/activation.ts(1247,56): error TS2379` because `SpawnOptions.headId` is required by Plan 02's interface widening)
- **Issue:** Plan 04's `<files_modified>` listed only `src/head/index.ts` and `src/system.ts`, but Plans 02 and 03 SUMMARYs both explicitly forecast that the scheduled-trigger SpawnOptions construction at `src/head/activation.ts:1247` would be wired by Plan 04. Without it, production code fails to typecheck.
- **Fix:** Inserted `headId: this.opts.headId` between `trigger: 'scheduled'` and `skillName: taskName!`. `ActivationLoop` already has `this.opts.headId` from Phase 30 (`ActivationLoopOptions.headId`), so no new wiring needed.
- **Files modified:** `src/head/activation.ts` (+1 line)
- **Commit:** `30616ae` (folded into Task 2's commit since it's part of the same wave-2 finishing scope)

## Authentication Gates

None.

## Verification

### Task 1 acceptance criteria (all PASS)

- `grep -q "headId: this.opts.headId" src/head/index.ts` → exit 0 (line 175) ✓
- Match appears INSIDE the `case 'spawn_agent':` block (between line 170 and the next case) ✓
- No `?? 'default'` after `this.opts.headId` (type-required, no fallback) ✓
- `npx tsc --noEmit 2>&1 | grep src/head/index.ts` → no matches ✓

### Task 2 acceptance criteria (all PASS)

- `grep -c "headId: deps.headId ?? 'default'" src/system.ts` → **3** (new LocalAgentRunner line 248, new toolExecutorOpts line 335, pre-existing ActivationLoop line 359) — meets ≥3 requirement ✓
- The new `headId:` at line 248 appears within the `new LocalAgentRunner({` ... `})` block ✓
- The new `headId:` at line 335 appears within the `const toolExecutorOpts = {` ... `}` block ✓
- `npx tsc --noEmit 2>&1 | grep src/system.ts` → no matches ✓

### Plan-level verification

- `npx vitest run src/db/db.test.ts -t "AgentStore"` → 22 passed / 0 failed (Plan 01's test surface unchanged) ✓
- `npx tsc --noEmit` on production code (`src/` minus test files) → **0 errors** ✓
- Remaining ~40 tsc errors are all at test fixtures (`src/head/head.test.ts`, `src/head/activation.test.ts`, `src/sub-agents/agents.test.ts`, `src/sub-agents/cancel.test.ts`, `src/sub-agents/archival.test.ts`) and eval scripts (`scripts/eval/harness.ts`, `scripts/eval/scenarios/*.ts`) — these are Plan 05's scope ✓

### Wave 2 GREEN state

Plan 03's SUMMARY listed the residual tsc errors after Wave 2 partial-land:

| Site                                        | Plan 04 status |
|---------------------------------------------|----------------|
| `src/system.ts(247,28)` LocalAgentRunner    | ✓ resolved (line 248) |
| `src/system.ts(368,5)` toolExecutorOpts     | ✓ resolved (line 335) |
| `src/head/index.ts(171,15)` spawn_agent     | ✓ resolved (line 175) |
| `src/head/activation.ts(1247,56)` scheduled | ✓ resolved (auto-fix Rule 3) |
| `src/head/activation.test.ts(196,5)`        | Plan 05 scope |
| `src/head/head.test.ts(249,37 / 620,5)`     | Plan 05 scope |
| `src/sub-agents/agents.test.ts:*`           | Plan 05 scope |
| `src/sub-agents/cancel.test.ts:*`           | Plan 05 scope |
| `src/sub-agents/archival.test.ts(73,32)`    | Plan 05 scope |
| `scripts/eval/harness.ts(804,31)`           | Plan 05 scope |
| `scripts/eval/scenarios/*.ts`               | Plan 05 scope |

All four production-code sites are now wired. The "Wave 2 GREEN" milestone is reached: production code typechecks cleanly with the head identity flowing from `buildSystem` → runner ctor + executor opts → spawn_agent dispatch + scheduled-trigger spawn → through to `AgentStore.create` (Plan 01) and `queueStore.enqueue` (Plan 03's threading).

## Commits

| Hash      | Type | Description                                                                  |
| --------- | ---- | ---------------------------------------------------------------------------- |
| `a98d957` | feat | inject headId into SpawnOptions in spawn_agent dispatch                      |
| `30616ae` | feat | thread headId through LocalAgentRunner and toolExecutorOpts in buildSystem   |

## Threat Flags

None — this plan only routes existing in-memory data (`deps.headId` → `LocalAgentRunnerOptions.headId` / `HeadToolExecutorOptions.headId` / `SpawnOptions.headId`). No new HTTP / IPC / file / DB surface, no untrusted-input crossing, no auth boundary changes. Per the plan's `<threat_model>`:

- T-34-11 (Tampering) — `deps.headId` is set by `buildSystem` caller (`src/index.ts:240` from server-owned `heads[]` config); the `?? 'default'` fallback at buildSystem level preserves CONF-02 (implicit default head) for single-head deployments and tests ✓
- T-34-12 (Information Disclosure) — accepted; `toolExecutorOpts.headId` is internal routing metadata, never reaches an external surface ✓
- T-34-13 (Elevation of Privilege) — closed structurally; the injected value is `this.opts.headId` (set at HeadToolExecutor construction from trusted toolExecutorOpts), NOT derived from the tool call input — an LLM-generated tool call cannot influence which head its spawned agent belongs to ✓

## Next Phase Readiness

- Wave 2 fully landed: Plans 03 + 04 together close the spawn → run → complete head_id routing loop in production code. `npx tsc --noEmit` on production code (`src/` minus tests) is clean.
- Plan 05 (integration tests + test-fixture/eval-scenario wiring) is the next plan. Its scope is mechanical: append `headId: 'default'` to the ~30 test/eval SpawnOptions and LocalAgentRunner option literals listed above, then add the integration test that pins T-34-09 closure (two heads, spawn under work, complete, assert `work` claims the event but `default` does not).

## Self-Check: PASSED

- All 3 listed modified files (`src/head/index.ts`, `src/system.ts`, `src/head/activation.ts`) carry the expected headId wirings per grep:
  - `grep -c "headId: this.opts.headId" src/head/index.ts` → 1 (line 175) ✓
  - `grep -c "headId: deps.headId ?? 'default'" src/system.ts` → 3 (lines 248, 335, 359) ✓
  - `grep -c "headId: this.opts.headId" src/head/activation.ts` → 3 (pre-existing lines 419 + 1311 from prior phases, plus new line 1251 added by this plan's Rule-3 deviation) ✓
- Both commits (`a98d957`, `30616ae`) present in `git log`:
  - `git log --oneline | grep a98d957` → FOUND
  - `git log --oneline | grep 30616ae` → FOUND
- SUMMARY.md exists on disk at `.planning/phases/34-multi-head-agent-lifecycle/34-04-SUMMARY.md`
- `npx tsc --noEmit` on production code shows zero errors at the four sites Plan 03's SUMMARY forecast as Plan 04 scope.
- All 22 AgentStore tests from Plan 01 remain green via `npx vitest run src/db/db.test.ts -t "AgentStore"`.

---
*Phase: 34-multi-head-agent-lifecycle*
*Completed: 2026-05-14*
