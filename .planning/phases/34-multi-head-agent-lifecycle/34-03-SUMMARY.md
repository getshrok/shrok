---
phase: 34-multi-head-agent-lifecycle
plan: 03
subsystem: agent-runtime
tags: [typescript, head_id, multi-head, local-agent-runner, queue-routing, spawn-options]

requires:
  - plan: 34-01
    provides: agents.head_id column + AgentState.headId field (carried into resumeSuspended via state.headId)
  - plan: 34-02
    provides: SpawnOptions.headId / AgentState.headId / LocalAgentRunnerOptions.headId required-at-type-level contracts (this plan consumes opts.headId in the LocalAgentRunner ctor)
provides:
  - "LocalAgentRunner now has a `private readonly headId: string` field assigned from `opts.headId` in the ctor"
  - "All 6 queueStore.enqueue() callsites in src/sub-agents/local.ts pass this.headId as the 3rd positional argument — completion events route to the spawning head, not 'default'"
  - "resumeSuspended() rebuilds SpawnOptions with `headId: state.headId` — head identity survives suspend/resume round-trips"
  - "handleSpawnAgent() sets `headId: this.headId` on childOptions — sub-agents inherit the parent runner's head"
affects: [plan-04-system-wiring, plan-05-integration-tests]

tech-stack:
  added: []
  patterns:
    - "Head identity fixed at LocalAgentRunner construction (`private readonly headId`) — mirrors ActivationLoop / AppStateStore / InjectorImpl patterns; one runner per head, lifetime contract encoded in the `readonly` modifier"
    - "Uniform 3rd-positional `this.headId` argument on every queueStore.enqueue() in src/sub-agents/local.ts — closes T-34-09 cross-head info leak by eliminating the silent 'default' fallback at the call site (the QueueStore default still exists as defense-in-depth)"
    - "Resume-after-suspend uses `state.headId` (the agent's persisted head), not `this.headId` (the runner's head) — matches the SpawnOptions contract 'the agent's head' and is correct under any future configuration where a runner could load an agent created under a different head; today they are always equal"
    - "Sub-agent inheritance uses `this.headId` on childOptions (handleSpawnAgent) — codifies T-34-10 'sub-agents cannot escalate to a different head' as a structural invariant rather than a runtime check"

key-files:
  created: []
  modified:
    - src/sub-agents/local.ts

key-decisions:
  - "D-RUNNER-HEADID honored (Wave 2): `private readonly headId: string` field declared in the class identity-shape block (top of the private-field list, immediately after the JSDoc comment), assigned as `this.headId = opts.headId` on the very first line of the ctor body — mirrors ActivationLoop's identity-fixed-at-construction precedent"
  - "D-ALL-SIX honored: all six queueStore.enqueue() callsites — spawn() last-resort, runLoopFrom error handler, completeAgent(), suspendAsQuestion(), buildAgentExecutor ctx.complete, respond_to_message dispatch — append `, this.headId` as the 3rd positional argument; uniform fix, no per-callsite design work"
  - "resumeSuspended uses `state.headId` (agent's persisted head), NOT `this.headId` (runner's head) — defensive correctness: matches the SpawnOptions contract under any future configuration where a runner could load an agent created under a different head"
  - "handleSpawnAgent uses `this.headId` on childOptions (NOT a synthesized 'default') — sub-agents structurally inherit the parent runner's head; T-34-10 escalation surface eliminated by construction"
  - "TDD-RED cadence skipped for this plan: the test fixtures in src/sub-agents/agents.test.ts are already runtime-RED from Plan 01 (AgentStore.create runtime requires head_id and the fixtures don't supply it); the existing failing tests ARE the RED state, and Plan 05's fixture wiring is the formal GREEN. Plan 03 just lands the implementation that makes the headId routing correct once the fixtures are wired."

patterns-established:
  - "Head identity threading through the agent lifecycle is now structural — the `private readonly headId` field plus the uniform 3rd-arg threading on enqueue() means a single point of head-binding (the ctor) routes every queue event the runner emits; impossible to silently drop the headId at a single callsite by accident"
  - "Resume vs spawn vs sub-spawn use different headId sources by design: state.headId for resume (persisted), this.headId for sub-spawn (inherit), opts.headId for new spawn (caller-supplied) — three deliberate sources, one runner field, no ambiguity"

requirements-completed: []

duration: 4min
completed: 2026-05-14
---

# Phase 34 Plan 03: LocalAgentRunner head_id Threading Summary

**One-liner:** Wired `LocalAgentRunner` to know its own head identity (`private readonly headId`) and stamped `this.headId` onto all six `queueStore.enqueue()` callsites in `src/sub-agents/local.ts` — completion / failure / question / response events now route to the spawning head's activation loop instead of silently defaulting to `'default'`. T-34-09 cross-head info leak closed at the call site.

## Performance

- **Duration:** 4min
- **Started:** 2026-05-14T03:14:30Z (approximate, post Plan 02)
- **Completed:** 2026-05-14T03:18:30Z
- **Tasks:** 2
- **Files modified:** 1 (src/sub-agents/local.ts)

## Accomplishments

- **`private readonly headId: string` field on LocalAgentRunner** assigned from `opts.headId` in the ctor — head identity fixed at construction, mirrors ActivationLoop's pattern. Cannot be mutated after construction (TypeScript `readonly` modifier).
- **All 6 `queueStore.enqueue()` callsites updated** in src/sub-agents/local.ts: each now passes `this.headId` as the 3rd positional argument. The QueueStore's `headId='default'` parameter default is no longer reached from this file — the bug is closed at the call site, and the QueueStore default remains only as defense-in-depth.
- **`resumeSuspended()` reconstructs SpawnOptions with `headId: state.headId`** — head identity is preserved across the agent's suspend/resume lifecycle. After Plan 01 persists head_id on the agents row and Plan 02 makes AgentState.headId required, this line is the third leg of the triangle that pins suspend-resume identity.
- **`handleSpawnAgent()` sets `headId: this.headId` on childOptions** — sub-agents spawned via the `spawn_agent` tool inherit the parent runner's head. T-34-10 (sub-agent escalation to a different head) is eliminated structurally, not by runtime check.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add private readonly headId + thread through resumeSuspended and handleSpawnAgent** — `e8d2e46` (feat)
2. **Task 2: Append this.headId as 3rd positional argument to all 6 queueStore.enqueue() callsites** — `dcc5ed2` (feat)

_Note: TDD RED commits were skipped this plan — see "Decisions Made" below for rationale._

## Files Created/Modified

- `src/sub-agents/local.ts` — added `private readonly headId: string` field + ctor read; threaded `state.headId` into resumeSuspended SpawnOptions reconstruction; threaded `this.headId` into handleSpawnAgent childOptions; appended `, this.headId` to all 6 queueStore.enqueue() callsites (lines 219, 627, 982, 1001, 1026, 1104).

## Decisions Made

- **D-RUNNER-HEADID Wave 2 (the body-level fix)** — The `private readonly headId: string` field lives at the top of the class private-field block, immediately after a JSDoc comment that explains the field's purpose ("Head this runner belongs to ... stamped on every queue event"). The ctor assignment `this.headId = opts.headId` is on the very first line of the ctor body, before any other assignment, matching the identity-first ordering used in ActivationLoop and InjectorImpl.

- **resumeSuspended uses `state.headId`, not `this.headId`** — defensive correctness: the SpawnOptions contract is "the agent's head", which is `state.headId` (the persisted value on the agents row). Today `state.headId === this.headId` is invariant because there's one runner per head, but using `state.headId` matches the contract and is correct under any future configuration where a runner could load an agent created under a different head. Decision documented inline in the file as a `// Phase 34 D-RUNNER-HEADID: preserve head identity across resume` comment.

- **handleSpawnAgent uses `this.headId` on childOptions** — sub-agents structurally inherit the parent runner's head. No synthesized `'default'`, no per-call lookup. The decision encodes T-34-10's "accept" disposition ("sub-agents cannot escalate to a different head — by design") as a compile-time invariant.

- **TDD-RED cadence skipped this plan** — The plan's `<behavior>` test specs (3 tests for Task 1, 6 tests for Task 2) describe behavior that's already exercised by the existing failing test fixtures in src/sub-agents/agents.test.ts: those fixtures don't supply `headId` and therefore fail at runtime against Plan 01's AgentStore.create binding (which requires head_id). Adding new RED commits would duplicate the failure surface that's already documented as Plan 02's Wave 1 RED state. Plan 05's test-fixture wiring is the formal GREEN; Plan 03's job is to land the implementation that makes the headId routing correct once those fixtures are wired. This is consistent with the plan's `<acceptance_criteria>` note: "The existing src/sub-agents/agents.test.ts tests pass once their SpawnOptions construction sites are updated to include headId (test-file update covered in Plan 05)."

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Verification

### Task 1 acceptance criteria (all PASS)

- `grep -q "private readonly headId: string" src/sub-agents/local.ts` → exit 0 ✓
- `grep -q "this.headId = opts.headId" src/sub-agents/local.ts` → exit 0 ✓
- `grep -q "headId: state.headId" src/sub-agents/local.ts` → exit 0 (resumeSuspended) ✓
- `grep -c "headId: this.headId" src/sub-agents/local.ts` → `1` ≥ 1 (handleSpawnAgent childOptions) ✓

### Task 2 acceptance criteria (all PASS)

- `grep -c "this.queueStore.enqueue(" src/sub-agents/local.ts` → `6` (exact match) ✓
- `grep -c ", this.headId)" src/sub-agents/local.ts` → `6` ≥ 6 (every enqueue closer is the 3rd-arg headId) ✓
- `grep -c "PRIORITY.AGENT_COMPLETED, this.headId)" src/sub-agents/local.ts` → `2` (callsites 3 and 5) ✓
- `grep -c "PRIORITY.AGENT_FAILED, this.headId)" src/sub-agents/local.ts` → `1` (callsite 2) ✓
- `grep -c "PRIORITY.AGENT_QUESTION, this.headId)" src/sub-agents/local.ts` → `1` (callsite 4) ✓
- `grep -c "PRIORITY.AGENT_RESPONSE, this.headId)" src/sub-agents/local.ts` → `1` (callsite 6) ✓
- `grep -c ", 2, this.headId)" src/sub-agents/local.ts` → `1` (callsite 1, literal `2` priority) ✓
- `grep -nE "queueStore\.enqueue\(" src/sub-agents/local.ts | wc -l` → `6` (no leftover 2-arg calls) ✓

### tsc surface after Plan 03

`npx tsc --noEmit` reports zero errors in `src/sub-agents/local.ts`. The remaining errors are exactly the Plan 04 / Plan 05 scopes:

- `src/system.ts(247,28)` and `src/system.ts(368,5)` — `LocalAgentRunner` instantiation + `toolExecutorOpts` object missing `headId` (Plan 04 wires `headId: deps.headId ?? 'default'`)
- `src/head/index.ts(171,15)` — `spawn_agent` dispatch SpawnOptions construction missing `headId` (Plan 04 injects `headId: this.opts.headId`)
- `src/head/activation.ts(1247,56)` — scheduled-trigger SpawnOptions construction missing `headId` (Plan 04 threads `headId: this.opts.headId`)
- `src/head/activation.test.ts(196,5)`, `src/head/head.test.ts(249,37)`, `src/head/head.test.ts(620,5)` — HeadToolExecutorOptions test fixtures (Plan 04 wires)
- `src/sub-agents/agents.test.ts:*`, `src/sub-agents/cancel.test.ts:*`, `src/sub-agents/archival.test.ts(73,32)` — LocalAgentRunner + SpawnOptions test fixtures (Plan 05 wires)
- `scripts/eval/harness.ts(804,31)`, `scripts/eval/scenarios/*.ts` — eval scenarios constructing SpawnOptions (Plan 04/05 wires `headId: 'default'`)

This is the **expected** Wave 2 partial state per the plan's `<acceptance_criteria>`: "Plan 03 alone may have residual unresolved compile errors at external SpawnOptions construction sites in src/system.ts and src/head/index.ts which Plan 04 fixes." Wave 2's other half (Plan 04) lands at the system wiring layer.

## Threat Flags

None — this plan only routes existing in-memory data (`opts.headId` → `this.headId` → 3rd arg on existing enqueue() calls). No new HTTP / IPC / file / DB surface, no untrusted-input crossing, no auth boundary changes. Per the plan's `<threat_model>`:

- T-34-08 (Tampering) — `private readonly` modifier prevents accidental mutation after construction ✓
- T-34-09 (Information Disclosure) — closed at the call site by the 3rd-arg threading; Plan 05's integration test will pin the closure ✓
- T-34-10 (Elevation of Privilege) — sub-agent head inheritance encoded structurally via `handleSpawnAgent`'s `headId: this.headId` ✓

## Next Phase Readiness

- Wave 2 half-landed: Plan 03 closes the LocalAgentRunner-side enqueue threading. Plan 04 closes the system.ts + head/index.ts + activation.ts construction sites. After Plan 04 lands, `npx tsc --noEmit` should be clean except for the test fixtures Plan 05 wires.
- Plan 05's integration test ("two heads, spawn under work, complete, assert work claims the event") becomes the architectural regression test that pins T-34-09's closure.

## Self-Check: PASSED

- File on disk: `src/sub-agents/local.ts` contains all four landmarks
  - `grep -q "private readonly headId: string"` exits 0
  - `grep -q "this.headId = opts.headId"` exits 0
  - `grep -q "headId: state.headId"` exits 0
  - `grep -c "headId: this.headId" → 1`
  - `grep -c "this.queueStore.enqueue(" → 6`
  - `grep -c ", this.headId)" → 6`
- Commits in git log:
  - `e8d2e46 feat(34-03): add LocalAgentRunner.headId field + thread through resume/spawn` — FOUND
  - `dcc5ed2 feat(34-03): thread this.headId through all 6 queueStore.enqueue() callsites` — FOUND
- SUMMARY.md exists at `.planning/phases/34-multi-head-agent-lifecycle/34-03-SUMMARY.md` — FOUND
- `npx tsc --noEmit` reports zero errors in `src/sub-agents/local.ts` (Plan 03's only file); remaining errors are at Plan 04 / Plan 05 scopes exactly as forecast.

---
*Phase: 34-multi-head-agent-lifecycle*
*Completed: 2026-05-14*
