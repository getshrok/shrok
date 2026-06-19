---
phase: 50-per-head-xray-isolation-eliminate-cross-head-agent-activity
verified: 2026-06-18T10:51:45Z
status: human_needed
score: 5/6 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Verify agent pill bar updates within 5 seconds after an agent completes or fails"
    expected: "Pill transitions to completed/failed state within one polling cycle (5s)"
    why_human: "Most agent_status_changed events from local.ts (complete/fail/suspend) emit without headId and are dropped by the SSE filter. The pill bar relies on the 5s refetchInterval fallback. This is observable behavior that grep cannot verify."
  - test: "With two heads each running agents, switch from head A to head B and verify head A's in-progress agents do not appear as pills on head B"
    expected: "Zero pills from head A visible on head B's pill bar after switch"
    why_human: "Cross-head isolation correctness for agent pills requires runtime multi-head observation."
  - test: "Verify no stale xray/memory/steward items from the previous head remain visible after switching heads"
    expected: "Timeline clears immediately on switch (reset effects fire), fresh backfill loads for the new head"
    why_human: "Reset effects and head-keyed query cache behavior requires interactive observation."
---

# Phase 50: Per-head xray isolation Verification Report

**Phase Goal:** When a head is selected, the dashboard shows only that head's agent activity, steward runs, memory retrievals, and agent pills — and nothing from any other head — on both initial backfill and live streaming, including across head switches. Closes the four documented "accepted cross-head leakage" surfaces (T-33-09): `agent_message_added`, `agent_status_changed`, `memory_retrieval`, `steward_run_added`. Single-head deployments see zero behavior change.
**Verified:** 2026-06-18T10:51:45Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `steward_run_added` carries head context via `StewardRun.headId` payload and the SSE filter drops cross-head events | VERIFIED | `sql/010_steward_runs_head_id.sql` adds `head_id TEXT NOT NULL DEFAULT 'default'`; `src/db/steward_runs.ts` threads `headId` through `StewardRun` type, `append()`, and `getRecent()`; `streamFilter.ts:40-42` reads `(event.payload as StewardRun).headId` for the `steward_run_added` branch; `streamFilter.test.ts` tests 53-63 cover drop-wrong + deliver-matching |
| 2 | `agent_message_added` and `memory_retrieval` carry top-level `headId` at emit and the SSE filter drops cross-head events | VERIFIED | `src/head/activation.ts:778` emits `memory_retrieval` with `headId: this.opts.headId`; `src/sub-agents/local.ts:885` passes `this.headId` as 4th arg to `emitMessageAdded`; both `src/dashboard/events.ts` and `dashboard/src/types/api.ts` union members declare `headId: string`; `streamFilter.ts:48-55` handles both via explicit type union; `streamFilter.test.ts` tests 66-84 cover drop + deliver for both |
| 3 | `agent_status_changed` no longer leaks cross-head (filter drops events with missing or mismatched headId) | VERIFIED (partial) | `streamFilter.ts:48-55` drops `agent_status_changed` when `event.headId !== selectedHead`; events from `cancelAllActive` (`src/db/agents.ts:280`) and startup reaping (`src/index.ts:312-313`) correctly carry `headId`. **Gap:** primary runtime paths — `local.ts:1016 complete()`, `local.ts:1044 suspend()`, `local.ts:649 fail()` — call `agentStore` methods WITHOUT passing `this.headId` (which is in scope). These events emit without `headId`, are correctly dropped fail-closed (no cross-head leakage), but also fail to deliver to the CORRECT head via SSE. The agent pill bar falls back to its 5s `refetchInterval` polling. No cross-head leakage; impaired liveness only. |
| 4 | REST backfill routes (`/api/agents/xray-history`, `/api/steward-runs`, `/api/activity`) accept `?head=` and pass it to head-filtered store reads (D-02) | VERIFIED | `src/dashboard/routes/agents.ts:66-67` `getRecent(50, head)`; `src/dashboard/routes/steward_runs.ts:10-11` `getRecent(60, head)`; `src/dashboard/routes/activity.ts:29-67` scopes all three store calls with `head` param; all three use `typeof req.query['head'] === 'string'` guard |
| 5 | Client passes `selectedHead` to backfill API calls with head-keyed React Query caches; cache misses on head switch force fresh fetches (D-02, D-03) | VERIFIED | `dashboard/src/pages/ConversationsPage.tsx:518-519` `queryKey: ['xray-backfill', selectedHead]`, `queryFn: () => api.agents.xrayHistory(selectedHead)`; `:564-565` `queryKey: ['stewardRuns', selectedHead]`; `dashboard/src/lib/api.ts:113-114` `api.stewardRuns.list(headId?)` appends `?head=`; `:139-140` `api.agents.xrayHistory(headId?)` appends `?head=`; query keys include `selectedHead` so cache misses on switch |
| 6 | Head-switch clears live accumulators (xray, memory-retrievals, stewardRuns) and agent pills (D-03); reset effects keyed on `[selectedHead]` | VERIFIED | `ConversationsPage.tsx:587-597` three `useEffect(() => { qc.setQueryData([...], ...) }, [selectedHead, qc])` blocks; `:579-581` `setKnownAgents(new Map())` on `[selectedHead]`; live accumulator keys in `useStream.ts:71,79,118` use `event.headId` or `event.payload.headId`; `ConversationsPage.tsx` reads on `selectedHead` (`:524`, `:531`) |

**Score:** 5/6 truths verified (truth 3 is verified for the leakage-closure goal but has an impaired liveness concern)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `sql/010_steward_runs_head_id.sql` | Migration adding head_id to steward_runs | VERIFIED | `ALTER TABLE steward_runs ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'` + compound index `idx_steward_runs_head_created` |
| `src/db/steward_runs.ts` | StewardRun.headId + getRecent(headId?) | VERIFIED | `headId: string` on interface; `WHERE head_id = ?` in `getRecent`; `@head_id` in insert binding |
| `src/dashboard/events.ts` | DashboardEvent union with headId on 3 members | VERIFIED | `agent_status_changed`, `agent_message_added`, `memory_retrieval` each have `headId: string`; `steward_run_added` stays payload-only |
| `dashboard/src/types/api.ts` | Client DashboardEvent union mirror + StewardRun.headId | VERIFIED | Lines 436-446 match server union exactly; `StewardRun.headId: string` at line 64 |
| `dashboard/src/hooks/streamFilter.ts` | Per-head SSE filter covering all 6 types | VERIFIED | `perHeadTypes` Set covers `message_added`, `typing`, `agent_message_added`, `agent_status_changed`, `memory_retrieval`, `steward_run_added`; steward branch uses payload cast; union narrowing via explicit type checks; T-33-09 comment removed |
| `dashboard/src/hooks/useStream.ts` | Head-keyed live accumulator writes | VERIFIED | `['xray-messages', event.headId]`, `['stewardRuns', event.payload.headId]`, `['memory-retrievals', event.headId]`, `['agents', event.headId]`; dead `['activity']` invalidations removed |
| `dashboard/src/pages/ConversationsPage.tsx` | Head-keyed backfill queries + 3 reset effects | VERIFIED | `['xray-backfill', selectedHead]`, `['xray-messages', selectedHead]`, `['memory-retrievals', selectedHead]`, `['stewardRuns', selectedHead]`; three `useEffect` reset blocks; `useQueryClient` import and `const qc` added |
| `src/dashboard/routes/agents.ts` | `/xray-history?head=` route | VERIFIED | `getRecent(50, head)` at line 67 |
| `src/dashboard/routes/steward_runs.ts` | `/steward-runs?head=` route | VERIFIED | `getRecent(60, head)` at line 11; `getAll()` call replaced |
| `src/dashboard/routes/activity.ts` | `/activity?head=` route (3 scoped calls) | VERIFIED | `messages.getRecentText(head ?? 'default', 60)`, `agents.getRecent(40, head)`, `stewardRuns.getRecent(60, head)` |
| `dashboard/src/lib/api.ts` | `api.agents.xrayHistory(headId?)` and `api.stewardRuns.list(headId?)` | VERIFIED | Both use `encodeURIComponent` and ternary URL (`?head=` only when headId supplied) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `activation.ts` memory_retrieval emit | `DashboardEvent.memory_retrieval.headId` | `headId: this.opts.headId` at line 778 | WIRED | Verified at `activation.ts:778` |
| `activation.ts` stewardRunStore.append | `StewardRun.headId` | `headId: this.opts.headId` in append object at line 1061 | WIRED | Verified at `activation.ts:1057-1062` |
| `local.ts` emitMessageAdded | `DashboardEvent.agent_message_added.headId` | `this.headId` 4th arg at line 885 | WIRED | Only this one call site in `local.ts` consistently passes headId |
| `local.ts` completeAgent | `DashboardEvent.agent_status_changed.headId` | should be `this.headId` | NOT WIRED | `agentStore.complete(agentId, output)` at line 1016 — `this.headId` in scope but NOT passed; event emits without headId |
| `local.ts` suspendAsQuestion | `DashboardEvent.agent_status_changed.headId` | should be `this.headId` | NOT WIRED | `agentStore.suspend(agentId, question)` at line 1044 — NOT passed |
| `local.ts` fail paths (lines 220, 445, 649) | `DashboardEvent.agent_status_changed.headId` | should be `this.headId` | NOT WIRED | Error paths in runLoop/spawn do not pass `this.headId` |
| `streamFilter.shouldDeliverStreamEvent` | drop cross-head events | `perHeadTypes` Set + per-type headId access | WIRED | All 6 per-head types handled; fail-closed for missing headId |
| `ConversationsPage` selectedHead → `api.agents.xrayHistory` | `?head=` query param | arrow `queryFn` at line 519 | WIRED | Verified |
| `ConversationsPage` selectedHead → reset effects | `qc.setQueryData` | `useEffect` on `[selectedHead]` at lines 587-597 | WIRED | Three effects for xray-messages, memory-retrievals, stewardRuns |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `ConversationsPage.tsx` xray timeline | `xrayBackfill` + `xrayLive` | `api.agents.xrayHistory(selectedHead)` → `/api/agents/xray-history?head=` → `agentStore.getRecent(50, head)` (SQLite `WHERE head_id = ?`) | Yes | FLOWING |
| `ConversationsPage.tsx` steward runs list | `stewardRunsList` | `api.stewardRuns.list(selectedHead)` → `/api/steward-runs?head=` → `stewardRunStore.getRecent(60, head)` (SQLite `WHERE head_id = ?`) | Yes | FLOWING |
| `ConversationsPage.tsx` memory retrievals | `memoryRetrievals` | accumulator seeded at `[]` via `initialData`, written by SSE events with `event.headId` key | Yes (live-only, no backfill) | FLOWING |
| `useStream.ts` steward live accumulator | `['stewardRuns', event.payload.headId]` | SSE event `steward_run_added`, `event.payload.headId` from `StewardRun.headId` | Yes | FLOWING |
| `useStream.ts` agent_status_changed invalidation | `['agents', event.headId]` | SSE event — headId absent for primary completion/fail/suspend paths (see truth 3 gap) | Partial (events without headId invalidate `['agents', undefined]`) | HOLLOW for primary paths; mitigated by 5s polling |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| tsc full repo clean | `npx tsc --noEmit; echo EXIT:$?` | EXIT:0 | PASS |
| streamFilter tests (14 tests) | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | 14/14 passed | PASS |
| steward_runs head-scoping tests | `npx vitest run src/db/steward_runs.test.ts` | 3/3 passed | PASS |
| All dashboard tests | `cd dashboard && npx vitest run` | 97/97 passed | PASS |
| Migration adds head_id column | `grep "ADD COLUMN head_id" sql/010_steward_runs_head_id.sql` | found | PASS |
| streamFilter covers all 6 per-head types | `grep -c "'steward_run_added'" dashboard/src/hooks/streamFilter.ts` | 1 (in perHeadTypes Set) | PASS |
| T-33-09 "accepted cross-head leakage" comment removed | `grep -ci "T-33-09" dashboard/src/hooks/streamFilter.ts` | 0 | PASS |
| xray-history route uses head-filtered query | `grep "getRecent(50, head)" src/dashboard/routes/agents.ts` | found at line 67 | PASS |
| steward-runs route uses head-filtered query | `grep "getRecent(60, head)" src/dashboard/routes/steward_runs.ts` | found at line 11 | PASS |
| Dead `['activity']` invalidations removed | `grep -c "\['activity'\]" dashboard/src/hooks/useStream.ts` | 0 | PASS |

### Probe Execution

Step 7c: SKIPPED — no probe scripts exist for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| D-01 | 50-02, 50-04 | Eliminate all four leaky SSE surfaces | PARTIALLY SATISFIED | 3/4 surfaces fully closed (agent_message_added, memory_retrieval, steward_run_added). agent_status_changed: no cross-head leakage (events without headId are dropped fail-closed), but primary lifecycle events (complete/fail/suspend from local.ts) don't carry headId so pills' SSE invalidation path is broken; 5s polling fallback works. |
| D-02 | 50-03 | Keep 50-item window per head for xray; steward uses 60 | SATISFIED | `getRecent(50, head)` in agents route; `getRecent(60, head)` in steward_runs route |
| D-03 | 50-03, 50-04 | Head-switch: clear live accumulators + re-backfill | SATISFIED | Three reset `useEffect` blocks in ConversationsPage; head-keyed query keys force cache miss |
| D-04 | 50-01 | Single-head: zero behavior change; DEFAULT 'default' pattern | SATISFIED | `sql/010` uses `DEFAULT 'default'`; `activity.ts` uses `head ?? 'default'` for messages; single-head sees no difference |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/sub-agents/local.ts` | 1016 | `agentStore.complete(agentId, output)` — `this.headId` available but not passed | WARNING | `agent_status_changed` event emitted without headId; SSE filter drops it fail-closed; pill bar relies on 5s polling fallback |
| `src/sub-agents/local.ts` | 1044 | `agentStore.suspend(agentId, question)` — `this.headId` available but not passed | WARNING | Same as above for suspension events |
| `src/sub-agents/local.ts` | 220, 445, 649 | `agentStore.fail(agentId, ...)` without `this.headId` | WARNING | Failure events don't carry headId; pill bar relies on 5s polling |
| `src/sub-agents/local.ts` | 261, 732 | `agentStore.resume(agentId)` without `this.headId` | WARNING | Resume events don't carry headId |
| `src/sub-agents/local.ts` | 310, 644, 708 | `agentStore.updateStatus(agentId, 'retracted')` without `this.headId` | WARNING | Retract events from runLoop don't carry headId |
| `dashboard/src/lib/api.ts` | 142-144 | `api.activity.get()` has no `headId` param despite backend supporting `?head=` | INFO | Dead code — no React component calls `api.activity.get()`; no runtime impact |

No BLOCKER anti-patterns found (no TBD/FIXME/XXX markers, no unimplemented stubs).

### Human Verification Required

### 1. Agent pill bar liveness after agent completion

**Test:** With a head selected, trigger an agent to run and complete (or fail) a task. Observe how quickly the agent pill transitions to completed/failed state in the pill bar.
**Expected:** Pill updates within 5 seconds (one polling cycle via `refetchInterval: 5_000`). It will NOT update instantly via SSE (the SSE path is broken for this transition because `local.ts` doesn't pass `this.headId` to `complete()`/`fail()`).
**Why human:** SSE delivery behavior for agent lifecycle events cannot be observed via grep. The practical impact (polling-only vs SSE+polling) requires runtime observation.

### 2. Multi-head cross-isolation for agent pills

**Test:** Configure two heads. Have head A run an agent and head B run an agent simultaneously. Select head A — verify only head A's agent pills appear. Switch to head B — verify only head B's agent pills appear.
**Expected:** Zero cross-head leakage on pill bar. Agent pills may update via 5s polling rather than immediately on status change (see item 1).
**Why human:** Requires multi-head runtime environment. Cannot be verified statically.

### 3. Head-switch visual UX

**Test:** While head A has a visible xray timeline (agent work items), steward runs, and memory retrievals, switch to head B.
**Expected:** Timeline, steward runs, and memory retrievals clear immediately (reset effects fire synchronously on head change) and repopulate with head B's data from the backfill.
**Why human:** React render behavior and timing of reset effects requires interactive browser observation.

### Gaps Summary

The phase goal is substantially achieved. Cross-head leakage is eliminated for all four event surfaces — the SSE filter is fail-closed, so events without headId are dropped rather than misrouted. However, the stated must-have "Every agent_status_changed SSE event carries the headId of the affected agent" is not fully realized: the primary runtime paths (agent complete/fail/suspend in `src/sub-agents/local.ts`) call `agentStore.complete()`, `fail()`, `suspend()` without passing `this.headId` (which is in scope as a class field). The plan explicitly allowed this for call sites that "lack head context," but `this.headId` was actually available throughout `local.ts`.

The practical consequence is that the agent pill bar's live-update via SSE is degraded for these transitions — the 5s polling fallback covers it. No cross-head leakage occurs.

The `api.activity.get()` client function lacks a `headId` parameter, but the function has no consumer in the current codebase, so there is no runtime leakage.

---

_Verified: 2026-06-18T10:51:45Z_
_Verifier: Claude (gsd-verifier)_

---

## Gap Resolution (post-verification, orchestrator)

**Commit:** `c44eab4` fix(50): pass this.headId to all agent_status_changed emits in local runner

The single code gap identified above — `agent_status_changed` emit sites in
`src/sub-agents/local.ts` omitting the available `this.headId` — is now closed.
All eleven `complete`/`fail`/`suspend`/`resume`/`updateStatus` call sites in
`LocalAgentRunner` (lines 220, 261, 310, 445, 644, 649, 708, 732, 1016, 1044,
1077) now pass `this.headId` as the trailing arg added by Plan 50-02. These
events now self-identify their head and are delivered by the fail-closed
per-head filter, restoring live SSE pill updates on complete/fail/suspend
(previously degraded to the 5s `refetchInterval` poll).

`npx tsc --noEmit` clean; src/sub-agents + db/agents suites 184/184 green;
full dashboard suite 97/97 green.

**Remaining human UAT** (runtime/visual, cannot be machine-verified):
1. Agent pill bar updates promptly via SSE after completion/failure (now expected instant, not 5s).
2. Two-head cross-isolation: switch heads, confirm no pill/timeline leakage.
3. Head-switch UX: timeline/steward/memory clear immediately on switch and repopulate with the new head.

Code-level score now 6/6 must-haves. Status: **verified (pending human UAT of runtime UX).**
