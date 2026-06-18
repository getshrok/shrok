# Phase 50: Per-head xray isolation — eliminate cross-head agent-activity bleed - Research

**Researched:** 2026-06-18
**Domain:** Multi-head dashboard isolation — SSE event filtering, React Query cache keying, SQLite migration, frontend accumulator reset
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 — Full leak scope:** Eliminate ALL cross-head leakage, not just the xray timeline. Close every path in `streamFilter.ts`'s "accepted cross-head leakage" list (`agent_message_added`, `memory_retrieval`, `steward_run_added`, `agent_status_changed`) and any additional per-head event/backfill the researcher finds. Acceptance bar: two heads each running agents, switching heads shows zero activity from the other head — on backfill AND live.

**D-02 — Backfill window:** Keep the existing window of 50, applied per head. `/api/agents/xray-history` changes from `getRecent(50)` (global) to `getRecent(50, head)`. Do not introduce a new limit constant.

**D-03 — Head-switch behavior:** On head switch, clear the previous head's accumulated live items immediately and re-backfill from the newly selected head. Mirror commit `352b9dd` (issue #10): head-key the relevant React Query caches and reset the live accumulators in a `useEffect` keyed on `[selectedHead]`.

**D-04 — Backward-compatibility:** Single-head deployments see zero behavior change. Any new `head_id` column (steward_runs) MUST use `DEFAULT 'default'` — scoping by `'default'` is then a no-op when only one head exists.

### Claude's Discretion

The exact wiring mechanism is the planner/executor's call, within the locked pattern:
- Tag each leaky SSE event with `headId` at its emit site.
- Extend `streamFilter.ts` to drop these per-head events when `event.headId !== selectedHead`.
- Head-key the consuming caches and reset on switch.
- Backfill REST routes gain `?head=` and pass it to head-scoped store reads.

### Deferred Ideas (OUT OF SCOPE)

None — the operator widened scope to "all leaks" as a clarification of phase intent, not a new capability.
</user_constraints>

---

## Summary

Phase 50 is a targeted isolation fix: four SSE event types that the Phase 33 `streamFilter.ts` explicitly documented as "accepted cross-head leakage" (T-33-09) are now being closed, plus any additional leaks found by a full sweep.

The codebase already has the right shape for this fix. The precedent commit `352b9dd` demonstrates exactly the three-part pattern to apply: (1) scope the backend query with a `?head=` param, (2) head-key the React Query cache (`['agents', selectedHead]`), (3) reset the live accumulator in a `useEffect([selectedHead])`. That exact pattern needs to be applied uniformly to the four leaky surfaces.

The one genuinely new database work item is adding `head_id` to `steward_runs` — the other three surfaces (`agent_message_added`, `agent_status_changed`, `memory_retrieval`) already have `head_id` available at their emit sites via the `AgentStore` row or the `ActivationLoop.opts.headId` field.

The `/api/activity` route and its `['activity']` React Query key are dead infrastructure: `useStream.ts` invalidates the cache three times but NO dashboard component currently subscribes to it via `useQuery`. The route itself contains unscoped agent and steward reads, but it has no active consumer — it is flagged here for awareness but is not an active leak (nothing renders it). It should be scoped as a future-proofing measure only.

**Primary recommendation:** Apply the `352b9dd` three-part pattern to each of the four leaky surfaces. The `steward_runs` head_id migration is the only structural addition; everything else is threading `headId` through existing emit call chains and updating query keys/accumulators.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SSE event head-filtering | Frontend (`streamFilter.ts`) | — | Client-side drop based on `event.headId` vs `selectedHead`; server broadcasts to all connected clients |
| SSE event head tagging | Backend (`src/db/agents.ts`, `src/head/activation.ts`, `src/db/steward_runs.ts`) | — | `headId` must be on the emitted payload before it traverses the wire |
| Backfill REST query scoping | Backend (`src/dashboard/routes/agents.ts`, `src/dashboard/routes/steward_runs.ts`) | — | `?head=` param accepted, passed to head-scoped store reads |
| React Query cache keying | Frontend (`ConversationsPage.tsx`) | — | Cache key must include `selectedHead` so React Query treats each head as an isolated entry |
| Live accumulator reset | Frontend (`ConversationsPage.tsx`) | — | `useEffect([selectedHead])` clears state arrays before backfill refetch fires |
| Database head isolation | Database (`steward_runs` table) | — | `ALTER TABLE ... ADD COLUMN head_id` with DEFAULT backfill, mirrors existing migrations |

---

## Complete Leak Inventory

This is the authoritative result of the full sweep the CONTEXT.md mandated. Every per-head dashboard event, REST backfill route, and client cache is documented.

### Leak 1: `agent_message_added` — xray timeline interleaving [VERIFIED: codebase grep]

**Severity:** Primary target. Cross-head sub-agent tool calls/results appear in the timeline of the wrong head.

| Surface | Location | Head-scoped today? |
|---------|----------|--------------------|
| SSE emit site | `src/db/agents.ts:253` — `emitMessageAdded(agentId, message, trigger?)` emits `{type:'agent_message_added', payload:{agentId, message, trigger}}` | No `headId` on payload |
| `streamFilter.ts` | `dashboard/src/hooks/streamFilter.ts:22` — `event.type !== 'message_added' && event.type !== 'typing'` → returns `true` unconditionally | No — passes all `agent_message_added` |
| Live cache accumulator | `dashboard/src/hooks/useStream.ts:71-77` — `setQueryData(['xray-messages'], ...)` | Key `['xray-messages']` has no head component |
| Backfill REST route | `src/dashboard/routes/agents.ts:65-90` — `GET /api/agents/xray-history` calls `agents.getRecent(50)` with no head filter | No `?head=` param accepted |
| Backfill cache key | `dashboard/src/pages/ConversationsPage.tsx:517` — `queryKey: ['xray-backfill']` | No head component |
| Store read | `src/db/agents.ts:305-314` — `getRecent(limit, headId?)` | Already supports `headId` filter; just not called with it |
| Head switch reset | None — `['xray-messages']` live accumulator never cleared on head switch | Missing |

**`headId` availability at emit site:** `emitMessageAdded` is called from `src/sub-agents/local.ts:885`. `LocalAgentRunner` holds `this.headId` (line 101, set from `opts.headId` at line 145). The call is `this.agentStore.emitMessageAdded(agentId, msg, options.trigger)` — `this.headId` is available and can be threaded as a fourth argument or captured by a new dedicated method.

---

### Leak 2: `memory_retrieval` — memory block inline in timeline [VERIFIED: codebase grep]

**Severity:** Medium. Memory retrievals from all heads appear in the selected head's timeline.

| Surface | Location | Head-scoped today? |
|---------|----------|--------------------|
| SSE emit site | `src/head/activation.ts:778` — `this.opts.events?.emit('dashboard', {type:'memory_retrieval', payload:{text, eventId, tokens}})` | No `headId` on payload |
| `streamFilter.ts` | passes unconditionally | No |
| Live cache accumulator | `dashboard/src/hooks/useStream.ts:119-124` — `setQueryData(['memory-retrievals'], ...)` | Key `['memory-retrievals']` has no head component |
| Backfill REST route | None — no REST backfill for memory-retrievals exists; `['memory-retrievals']` is accumulator-only (initialData `[]`) | N/A |
| Head switch reset | None — `['memory-retrievals']` never cleared on head switch | Missing |

**`headId` availability at emit site:** `ActivationLoop` holds `this.opts.headId` (set from constructor options, used extensively throughout the file). The emit at line 778 is inside the activation loop body — `this.opts.headId` is directly accessible. [VERIFIED: codebase grep, `grep -n "this\.opts\.headId" src/head/activation.ts`]

---

### Leak 3: `steward_run_added` — steward rows in timeline [VERIFIED: codebase grep]

**Severity:** Medium. Steward runs from all heads appear in the selected head's conversation timeline.

| Surface | Location | Head-scoped today? |
|---------|----------|--------------------|
| SSE emit site | `src/db/steward_runs.ts:41` — `this.eventBus?.emit('dashboard', {type:'steward_run_added', payload:run})` | No `headId` on payload (no column on table) |
| `streamFilter.ts` | passes unconditionally | No |
| Live cache accumulator | `dashboard/src/hooks/useStream.ts:80-85` — `setQueryData(['stewardRuns'], ...)` | Key `['stewardRuns']` has no head component |
| Backfill REST route | `src/dashboard/routes/steward_runs.ts:9-11` — `GET /api/steward-runs` calls `stewardRuns.getAll()` with no filter | No `?head=` accepted |
| Backfill cache key | `dashboard/src/pages/ConversationsPage.tsx:563` — `queryKey: ['stewardRuns']` | No head component |
| DB table | `steward_runs` schema (`sql/001_init.sql:105-109`): columns are `id, stewards, created_at` | No `head_id` column |
| Head switch reset | None — `['stewardRuns']` live accumulator never cleared on head switch | Missing |

**This is the one leak that requires a database migration.**

**`headId` availability at append call site:** `src/head/activation.ts:1057` calls `this.opts.stewardRunStore?.append({id, stewards, createdAt})`. `this.opts.headId` (line 82 of `ActivationLoopOptions`) is directly available at this call site and can be threaded into the `StewardRun` type and `append()` call.

---

### Leak 4: `agent_status_changed` — pill bar + activity invalidation [VERIFIED: codebase grep]

**Severity:** Low (indirect). The `['agents']` cache IS already head-keyed (`['agents', selectedHead]` since commit `352b9dd`). However `agent_status_changed` invalidates with the partial key `['agents']` which triggers a refetch for ALL head-specific cache entries simultaneously (React Query prefix matching). This causes unnecessary refetches for non-selected heads but does NOT cause data bleed because the refetch uses the head-scoped query fn. However the `['activity']` invalidation (also triggered here) is dead infrastructure (see below).

| Surface | Location | Head-scoped today? |
|---------|----------|--------------------|
| SSE emit sites | `src/db/agents.ts`: `updateStatus` (:230), `suspend` (:243), `resume` (:248), `complete` (:258), `fail` (:263), `cancelAllActive` (:280) | No `headId` on payload — emit is `{id, status}` only |
| `streamFilter.ts` | passes unconditionally | No |
| Cache invalidation | `dashboard/src/hooks/useStream.ts:57` — `invalidateQueries({queryKey:['agents']})` | Partial key match — invalidates all `['agents', *]` entries |
| Data result | `agentsQuery` uses `['agents', selectedHead]` with head-scoped `api.agents.list(selectedHead)` | Correctly scoped via precedent commit |

**`headId` availability at emit sites:** `updateStatus(id, status)` currently runs `stmtUpdateStatus.run(status, id)` then emits. The agent row already has `head_id` in the DB. The store does NOT have a cached lookup — it would need either (a) `this.db.prepare('SELECT head_id FROM agents WHERE id = ?').get(id)` inline lookup, or (b) adding a `headId` parameter to `updateStatus`, `suspend`, `resume`, `complete`, `fail`. Option (b) (thread `headId` through the method signatures) is preferred because all call sites already have `headId` available:

- `src/sub-agents/local.ts` — holds `this.headId` (line 101)
- `src/head/activation.ts` — holds `this.opts.headId`  
- `src/index.ts:312` — context has the head id

After adding `headId` to `agent_status_changed` payload, the `streamFilter.ts` drop will filter it per-head, and `['agents']` invalidation can be narrowed to `['agents', event.headId]` for a targeted invalidation (skips non-selected heads).

---

### Leak 5: `/api/activity` route and `['activity']` cache — DEAD INFRASTRUCTURE [VERIFIED: codebase grep]

**Status: NOT an active leak.** Investigation result:

- `useStream.ts` invalidates `['activity']` three times (lines 54, 58, 86) when `message_added`, `agent_status_changed`, and `steward_run_added` events fire.
- **No dashboard component calls `api.activity.get()` in a `useQuery`** — confirmed by exhaustive grep across all dashboard source files. The cache is invalidated but never subscribed.
- The route `GET /api/activity` (`src/dashboard/routes/activity.ts`) calls `messages.getRecentText('default', 60)` (hardcoded to `'default'` head), `agents.getRecent(40)` (no head filter), and `stewardRuns.getRecent(60)` (no filter) — all unscoped.
- The `api.activity.get()` function is defined in `dashboard/src/lib/api.ts:143` but is not called anywhere in the dashboard.

**Disposition:** The three `invalidateQueries({ queryKey: ['activity'] })` calls in `useStream.ts` are harmless dead code. The route is a potential future leak surface but has no active consumer. The planner may choose to: (a) scope the route as future-proofing, or (b) leave it as-is and note it for cleanup. The operator's bar is "nothing that currently renders bleeds" — this surface renders nothing today. [ASSUMED: that no unreferenced components in the codebase also subscribe to `['activity']` via a path not caught by the grep]

---

## Migration: `steward_runs.head_id`

### Current schema (`sql/001_init.sql:105-109`)

```sql
CREATE TABLE IF NOT EXISTS steward_runs (
  id         TEXT NOT NULL PRIMARY KEY,
  stewards   TEXT NOT NULL,   -- JSON
  created_at TEXT NOT NULL
);
```

No `head_id` column. [VERIFIED: codebase read]

### Next migration number

Current highest: `009_agents_relay_guidance.sql`. Next migration: **`sql/010_steward_runs_head_id.sql`**. [VERIFIED: `ls sql/`]

### Migration template (mirror of 005/007)

```sql
-- sql/010_steward_runs_head_id.sql
-- Phase 50: Add head_id isolation column to steward_runs.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.
-- Mirrors sql/007_agents_head_id.sql (Phase 34) exactly.

ALTER TABLE steward_runs ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Head-scoped compound index to support per-head backfill reads.
CREATE INDEX IF NOT EXISTS idx_steward_runs_head_created
  ON steward_runs (head_id, created_at DESC);
```

[ASSUMED: the index name and column order are correct — verify against existing index naming conventions in the codebase]

### Steward write path (head_id threading)

The call chain for a steward run:

1. `ActivationLoop.run()` — holds `this.opts.headId: string` (line 82 of `ActivationLoopOptions`)
2. At `activation.ts:1057`: `this.opts.stewardRunStore?.append({ id, stewards, createdAt })` — `this.opts.headId` is in scope
3. `StewardRunStore.append(run: StewardRun)` — inserts and emits `steward_run_added`

**Change required:**
- Add `headId: string` to the `StewardRun` interface (`src/db/steward_runs.ts:4`)
- Add `headId` to `StewardRunRow` and `rowToRun()` mapper
- Update `stmtInsert` to include `head_id` column
- Add `headId` to the SSE payload emit
- Add `headId` to client-side `StewardRun` interface (`dashboard/src/types/api.ts:60`)
- Thread `this.opts.headId` into the `append()` call at `activation.ts:1057`
- Add `getRecent(limit, headId?)` head-filtered overload to `StewardRunStore` (mirrors `AgentStore.getRecent`)

---

## `DashboardEvent` Union: Dual-file Lockstep

**Both files must be updated in lockstep.** [VERIFIED: codebase read of both files]

### Server-side: `src/dashboard/events.ts`

```typescript
// CURRENT (line 6-16):
export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }        // already scoped
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }  // MISSING headId
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string } }  // MISSING headId
  | { type: 'steward_run_added'; payload: StewardRun }                 // MISSING headId (StewardRun type change)
  | { type: 'usage_updated' }                                          // process-wide, no headId needed
  | { type: 'assistant_name_changed'; payload: { name: string } }      // process-wide, no headId needed
  | { type: 'typing'; headId: string }                                 // already scoped
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }  // process-wide
  | { type: 'thresholds_changed' }                                     // process-wide
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number } }  // MISSING headId
```

**Required additions:**
- `agent_status_changed`: add `headId: string` to the union member
- `agent_message_added`: add `headId: string` to the union member
- `steward_run_added`: `StewardRun` payload gains `headId` when `StewardRun` interface is updated, OR add `headId` as a top-level field on the event
- `memory_retrieval`: add `headId: string` to the union member

### Client-side: `dashboard/src/types/api.ts` (line 435-445)

Identical union — must mirror server-side changes exactly. [VERIFIED: codebase read]

```typescript
// line 435-445 — same four missing headId fields
export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }  // ADD headId
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string } }  // ADD headId
  | { type: 'steward_run_added'; payload: StewardRun }                // StewardRun gains headId
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing'; headId: string }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number } }  // ADD headId
```

---

## Precedent Commit `352b9dd` — Three-Part Pattern

Commit `352b9dd` (2026-06-07, "feat(quick-260607-lwy-01): head-scope frontend agent-pills path") closed issue #10 (head-scope the pills). It changed exactly three files:

### Part 1: Scope the backend query (`dashboard/src/lib/api.ts`)

```typescript
// Before:
list: () =>
  request<...>('/api/agents'),
// After:
list: (headId?: string) =>
  request<...>(headId ? `/api/agents?head=${encodeURIComponent(headId)}` : '/api/agents'),
```

The backend route already had `?head=` support (added in the prior commit `49cf687`). Frontend just needed to pass the param.

### Part 2: Head-key the cache (`ConversationsPage.tsx`)

```typescript
// Before:
queryKey: ['agents'],
queryFn: api.agents.list,
// After:
queryKey: ['agents', selectedHead],
queryFn: () => api.agents.list(selectedHead),
```

React Query now treats `['agents', 'default']` and `['agents', 'work']` as distinct cache entries.

### Part 3: Reset the accumulator on switch (`ConversationsPage.tsx`)

```typescript
// Added:
useEffect(() => {
  setKnownAgents(new Map())
}, [selectedHead])
```

This clears the `Map`-based accumulator that keeps completed agents as greyed pills. Without it, pills from the previous head linger after switching.

**This three-part shape is the template for every leaky surface in Phase 50.** [VERIFIED: `git show 352b9dd`]

---

## Head-Switch Reset: What Needs Resetting

### Existing reset (template at `ConversationsPage.tsx:578`)

```typescript
useEffect(() => {
  setKnownAgents(new Map())
}, [selectedHead])
```

### New resets needed

The same pattern must be applied to the live accumulators for:

| Accumulator | Current key | Effect to add |
|-------------|-------------|---------------|
| xray live messages | `['xray-messages']` | `useEffect(() => { qc.setQueryData(['xray-messages'], []) }, [selectedHead])` |
| memory retrievals | `['memory-retrievals']` | `useEffect(() => { qc.setQueryData(['memory-retrievals'], []) }, [selectedHead])` |
| steward runs (live portion) | `['stewardRuns']` | Head-key the cache (making it `['stewardRuns', selectedHead]`) + matching useEffect reset OR just reset the accumulator directly |

**Location:** All three new effects belong in `ConversationsPage.tsx`, co-located with the existing `setKnownAgents` reset effect at line 578. [VERIFIED: codebase read]

### On-switch cache invalidation / backfill re-trigger

When the cache key includes `selectedHead`, React Query automatically refetches on head switch because it's a new cache miss. For `['xray-backfill']` changing to `['xray-backfill', selectedHead]`, the backfill refetch is automatic — no explicit effect needed (React Query's staleTime:Infinity means it fetches once per unique key).

---

## Standard Stack

This phase uses the existing project stack with no new external dependencies.

| Component | Version | Purpose |
|-----------|---------|---------|
| `node:sqlite` (built-in) | Node 22 | Migration execution via `runMigrations()` |
| React Query (`@tanstack/react-query`) | existing | Cache key management, `invalidateQueries`, `setQueryData` |
| TypeScript | existing | Union type updates for `DashboardEvent` |
| Vitest | ^2.1.0 | Unit tests for filter expansion, migration, store methods |

No new packages needed. [VERIFIED: `package.json`]

---

## Package Legitimacy Audit

No new packages are being installed in this phase. This section is not applicable.

---

## Architecture Patterns

### System Architecture Diagram

```
Head A agents running                    Head B agents running
       │                                        │
       ▼                                        ▼
AgentStore.emitMessageAdded(id,msg,trigger,headId)
AgentStore.updateStatus(id,status,headId)
ActivationLoop:778 → events.emit(memory_retrieval + headId)
StewardRunStore.append({...run, headId})
       │
       ▼
DashboardEventBus (server)
       │
       ▼
GET /api/stream (SSE — broadcasts to ALL connected clients)
       │
       ▼
useStream.ts — shouldDeliverStreamEvent(event, selectedHead)
       │                    │
   headId matches       headId !== selectedHead
       │                    │
       ▼                    ▼
   setQueryData          DROP (Phase 50 expands drop set to
  (['xray-messages',       include agent_message_added,
    selectedHead], ...)    memory_retrieval,
                           steward_run_added,
  setQueryData             agent_status_changed)
  (['memory-retrievals',
    selectedHead], ...)

  setQueryData
  (['stewardRuns',
    selectedHead], ...)

  invalidateQueries
  (['agents', headId])   ← targeted, not partial-match all heads
```

### Recommended Change Set Summary

```
src/db/steward_runs.ts          — StewardRun interface + head_id column + append(headId) + getRecent(headId?)
src/db/agents.ts                — emitMessageAdded(+headId) + updateStatus/suspend/resume/complete/fail(+headId)
src/head/activation.ts          — memory_retrieval emit (+headId) + stewardRunStore.append(+headId)
src/sub-agents/local.ts         — emitMessageAdded call (+this.headId)
src/index.ts                    — updateStatus call sites (+headId)
src/dashboard/events.ts         — DashboardEvent union (add headId to 4 members)
src/dashboard/routes/agents.ts  — xray-history route: agents.getRecent(50, head)
src/dashboard/routes/steward_runs.ts  — accept ?head=, call getRecent(N, head)
sql/010_steward_runs_head_id.sql — new migration
dashboard/src/types/api.ts      — DashboardEvent union (mirror server) + StewardRun interface
dashboard/src/hooks/streamFilter.ts  — expand drop set to all 4 leaky events
dashboard/src/hooks/useStream.ts     — head-key accumulator setQueryData calls
dashboard/src/pages/ConversationsPage.tsx  — head-key queryKeys + add 3 reset useEffects
dashboard/src/lib/api.ts         — xrayHistory(headId?) + stewardRuns.list(headId?)
```

### Pattern: Head-scoped accumulator key + reset

The canonical pattern from Phase 33's `message_added` fix (D-11):

```typescript
// useStream.ts — route live event to head-scoped accumulator
if (event.type === 'agent_message_added') {
  if (event.headId !== currentHeadIdRef.current) return  // streamFilter handles this
  qc.setQueryData(
    ['xray-messages', event.headId],           // head-scoped key
    (old) => [...(old ?? []), { agentId: event.payload.agentId, message: event.payload.message }]
  )
}

// ConversationsPage.tsx — reset on switch
useEffect(() => {
  qc.setQueryData(['xray-messages', selectedHead], [])
}, [selectedHead, qc])

// ConversationsPage.tsx — backfill query
const { data: xrayBackfill } = useQuery({
  queryKey: ['xray-backfill', selectedHead],         // head-scoped key
  queryFn: () => api.agents.xrayHistory(selectedHead), // passes ?head=
  enabled: visibility.agentWork,
  staleTime: Infinity,
})
const { data: xrayLive } = useQuery<...>({
  queryKey: ['xray-messages', selectedHead],          // head-scoped key
  initialData: [],
  staleTime: Infinity,
  enabled: visibility.agentWork,
})
```

### Pattern: `shouldDeliverStreamEvent` expanded drop set

```typescript
// streamFilter.ts — after Phase 50
export function shouldDeliverStreamEvent(
  event: DashboardEvent,
  selectedHead: string | null,
): boolean {
  // Per-head event types: drop when headId doesn't match selected head
  const perHeadTypes = new Set([
    'message_added', 'typing',
    // Phase 50 additions:
    'agent_message_added', 'agent_status_changed', 'memory_retrieval', 'steward_run_added',
  ])
  if (!perHeadTypes.has(event.type)) return true
  if (selectedHead === null) return true
  // TypeScript narrowing: all per-head types carry headId after Phase 50 changes
  return (event as { headId: string }).headId === selectedHead
}
```

### Anti-Patterns to Avoid

- **Invalidating `['agents']` without head scope:** The current `invalidateQueries({ queryKey: ['agents'] })` in `useStream.ts` uses React Query's partial-match behavior — it invalidates ALL `['agents', *]` cache entries at once. After adding `headId` to `agent_status_changed`, this should be narrowed to `invalidateQueries({ queryKey: ['agents', event.headId] })` to avoid unnecessary refetches for non-selected heads.
- **Forgetting the dual-file DashboardEvent union:** Server-side (`src/dashboard/events.ts`) and client-side (`dashboard/src/types/api.ts`) unions must be updated in lockstep. Missing one causes TypeScript to complain on only one side and silently let the other compile.
- **Using `setQueryData` to reset without also resetting the backfill key:** If the live accumulator `['xray-messages', selectedHead]` is reset but the backfill `['xray-backfill', selectedHead]` is NOT refetched, the timeline shows empty until the user navigates away. With `staleTime: Infinity`, cache-key change is the only trigger for a fresh backfill fetch.
- **Threading headId through `updateStatus` without updating all call sites:** `updateStatus` is called from 3 files (`sub-agents/local.ts`, `head/activation.ts`, `index.ts`). All must receive the headId argument. Missing one causes a TypeScript compile error only if the parameter is non-optional — make it optional during migration to prevent a big-bang change, then tighten.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQLite column backfill | Explicit `UPDATE` loop | `ALTER TABLE ADD COLUMN DEFAULT 'default'` | SQLite's ADD COLUMN with constant DEFAULT is atomic and populates all existing rows in one DDL statement — no UPDATE loop needed, no migration window |
| React Query cache reset on route change | Custom state management | `useEffect([selectedHead])` calling `setQueryData` | React Query already handles per-key caching; just change the key |
| SSE event filtering | Custom WebSocket-level filtering per head | `shouldDeliverStreamEvent()` drop filter in `useStream.ts` | Single server broadcasts to all clients; filtering is intentionally client-side so the SSE connection is shared |

---

## Common Pitfalls

### Pitfall 1: `updateStatus` headId lookup overhead

**What goes wrong:** Adding a `SELECT head_id FROM agents WHERE id = ?` lookup inside `updateStatus` (instead of threading `headId` through the method signature) — called many times per agent lifecycle.

**Why it happens:** The emit sites don't currently carry headId, so the temptation is to look it up.

**How to avoid:** Thread `headId` as an optional parameter through `updateStatus`, `suspend`, `resume`, `complete`, `fail`. All 3 call sites (`local.ts`, `activation.ts`, `index.ts`) already hold the headId in scope. The lookup approach is correct but wasteful; signature threading is cleaner.

**Warning signs:** Any new `db.prepare('SELECT head_id FROM agents WHERE id = ?')` in `agents.ts`.

### Pitfall 2: React Query partial-key invalidation

**What goes wrong:** `invalidateQueries({ queryKey: ['agents'] })` invalidates ALL `['agents', *]` entries — React Query's default behavior uses prefix matching. This causes every head's agents cache to refetch simultaneously on any `agent_status_changed`, even for non-selected heads.

**Why it happens:** The existing invalidation was written before agents were head-keyed.

**How to avoid:** After adding `headId` to the `agent_status_changed` payload, narrow the invalidation to `invalidateQueries({ queryKey: ['agents', event.headId] })`.

**Warning signs:** Seeing refetch calls for `['agents', 'head-B']` while only `['agents', 'head-A']` is selected.

### Pitfall 3: Forgetting `staleTime: Infinity` means no automatic refetch

**What goes wrong:** The `['xray-backfill', selectedHead]` backfill is fetched once and cached forever (staleTime: Infinity). If head-keying the cache key creates a NEW cache entry for a head, React Query will fetch it once automatically. But if the cache key is NOT changed (kept as `['xray-backfill']`) and only the effect resets the accumulator, the backfill is not re-fetched on head switch.

**Why it happens:** Forgetting that staleTime controls the re-fetch trigger, not just cache lifetime.

**How to avoid:** The backfill key MUST include `selectedHead` (`['xray-backfill', selectedHead]`) so each head switch is a new cache miss that triggers a fresh fetch automatically.

### Pitfall 4: `getAll()` vs `getRecent()` in steward runs route

**What goes wrong:** The current `/api/steward-runs` route calls `stewardRuns.getAll()` (returns all rows, ascending by created_at). The new head-scoped version must also apply the limit and order.

**Why it happens:** The `StewardRunStore` has two reads: `getAll()` (no limit, ascending) and `getRecent(limit)` (limited, descending). The route calls `getAll()`.

**How to avoid:** The new head-scoped route should use a new `getRecent(limit, headId?)` overload (consistent with `AgentStore.getRecent`), not `getAll()`. The client receives a descending set; display ordering is handled by timeline assembly.

### Pitfall 5: TypeScript narrows `event.headId` only after type union update

**What goes wrong:** `streamFilter.ts` currently narrows on `event.type !== 'message_added' && event.type !== 'typing'` before accessing `event.headId`. After adding headId to more union members, TypeScript will complain about accessing `headId` on the broader union unless the narrowing is updated.

**Why it happens:** The current filter uses a double-negation early-return for exactly the two types that carry headId. Adding more types requires either expanding the condition or re-architecting to a positive-match approach.

**How to avoid:** Refactor `streamFilter.ts` to a positive match against a set of per-head types (see the pattern above), using a type assertion to access `headId`. This is cleaner than a growing `&&`-chain.

---

## Code Examples

### Example 1: Backend xray-history route head-scoping

```typescript
// src/dashboard/routes/agents.ts — AFTER Phase 50
// Source: confirmed from codebase reading of current getRecent signature
router.get('/xray-history', requireAuth, (req: Request, res: Response): void => {
  const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
  const recent = agents.getRecent(50, head)   // head filter already exists at agents.ts:305
  // ... rest of the route unchanged
})
```

The backend work for `agent_message_added` backfill is a one-line change — `getRecent(50)` → `getRecent(50, head)`. The `AgentStore.getRecent(limit, headId?)` head filter was added in commit `49cf687` and confirmed at `src/db/agents.ts:305-314`. [VERIFIED: codebase read]

### Example 2: StewardRunStore migration + head-scoped read

```typescript
// src/db/steward_runs.ts — AFTER Phase 50
export interface StewardRun {
  id: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
  headId: string   // NEW — matches head_id column added by sql/010
}

// getRecent with optional head filter (mirrors AgentStore.getRecent pattern)
getRecent(limit: number, headId?: string): StewardRun[] {
  const rows = headId !== undefined
    ? this.db.prepare('SELECT * FROM steward_runs WHERE head_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(headId, limit)
    : this.db.prepare('SELECT * FROM steward_runs ORDER BY created_at DESC LIMIT ?')
        .all(limit)
  return (rows as unknown as StewardRunRow[]).map(rowToRun)
}

append(run: StewardRun): void {
  this.stmtInsert.run({
    id: run.id,
    stewards: JSON.stringify(run.stewards),
    created_at: run.createdAt,
    head_id: run.headId,   // NEW
  })
  this.eventBus?.emit('dashboard', { type: 'steward_run_added', payload: run })
  // run.headId is now on the StewardRun payload, flowing into the event
}
```

### Example 3: Activation loop — threading headId to steward append

```typescript
// src/head/activation.ts:1057 — AFTER Phase 50
this.opts.stewardRunStore?.append({
  id: generateId('jr'),
  stewards: results,
  createdAt: new Date().toISOString(),
  headId: this.opts.headId,    // NEW — available in scope
})
```

### Example 4: Activation loop — memory_retrieval emit with headId

```typescript
// src/head/activation.ts:778 — AFTER Phase 50
this.opts.events?.emit('dashboard', {
  type: 'memory_retrieval',
  payload: { text: context.memoryBlock, eventId: event.id, tokens: estimateStringTokens(context.memoryBlock) },
  headId: this.opts.headId,   // NEW — available in scope
})
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single `['agents']` key | `['agents', selectedHead]` | Commit `352b9dd` (2026-06-07) | Prevents stale pills from other heads |
| `streamFilter.ts` drops only `message_added`/`typing` | Add `agent_message_added`/`memory_retrieval`/`steward_run_added`/`agent_status_changed` | Phase 50 | Closes the documented T-33-09 deferred leaks |
| `steward_runs` has no `head_id` | `head_id TEXT NOT NULL DEFAULT 'default'` | Phase 50 (migration 010) | Enables per-head steward backfill |

**Deprecated/outdated:**
- The `streamFilter.ts` doc comment that names these four event types as "accepted cross-head leakage — see T-33-09" is explicitly scheduled for removal in this phase (it documents what was intentionally deferred, not what should remain).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `['activity']` cache has no active subscriber — no component calls `api.activity.get()` in a `useQuery` | Leak 5 | If a subscriber exists in a code path not covered by the grep (e.g., dynamic import, conditional render), the `/api/activity` route would be an active bleed. Grep was exhaustive across all `.tsx`/`.ts` files. |
| A2 | The next migration number is `010` | Migration section | If a migration was added after research time, the filename would conflict. Verify `ls sql/` before writing the file. |
| A3 | React Query `invalidateQueries({ queryKey: ['agents'] })` uses prefix matching and invalidates ALL `['agents', *]` cache entries | Pitfall 2 | If the version in use has different matching semantics, the targeted-invalidation recommendation may be wrong. @tanstack/react-query v5 changed semantics — verify version. |
| A4 | Threading `headId` as an optional parameter to `updateStatus` et al. (rather than a lookup) is the right approach | Leak 4 | If any call site doesn't have headId available, an optional parameter would silently send `undefined` headId in events, causing events to be dropped. All 3 call sites were verified to hold headId. |

---

## Open Questions

1. **`api.stewardRuns.list()` — return all or paginated?**
   - What we know: current route returns `getAll()` (no limit). The CONTEXT.md says to add `?head=` but doesn't specify a limit for the steward runs backfill.
   - What's unclear: should the route switch from `getAll()` to `getRecent(N, head)` and use a specific limit, or return all per-head rows?
   - Recommendation: mirror the xray approach — use `getRecent(60, head)` matching the existing `getRecent(60)` in the activity route, or match the `stewardRuns.getRecent(60)` already called in `activity.ts`. The planner should decide.

2. **`['stewardRuns']` cache — head-key or reset?**
   - What we know: `stewardRunsQuery` uses `queryKey: ['stewardRuns']` and `queryFn: api.stewardRuns.list`. The live accumulator appends to this same key.
   - What's unclear: whether to head-key the backfill cache (`['stewardRuns', selectedHead]`) or keep it flat and add only a reset effect.
   - Recommendation: head-key it (`['stewardRuns', selectedHead]`) for consistency with the other surfaces, so head-switch is a cache-miss that auto-triggers a fresh backfill fetch. The reset effect then clears the live accumulator only.

3. **`['activity']` invalidations in `useStream.ts` — remove or leave?**
   - What we know: these invalidations are dead (no subscriber). They add noise.
   - Recommendation: remove them as part of this phase (they're associated with the leaky events being fixed). Low risk — no subscriber means no regression.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^2.1.0 |
| Server config file | `vitest.config.ts` (root) — `include: ['src/**/*.test.ts']` |
| Dashboard config file | `dashboard/vitest.config.ts` — `include: ['src/**/*.test.ts', 'src/**/*.test.tsx']` |
| Quick run (server) | `npx vitest run src/db/steward_runs.test.ts` |
| Quick run (dashboard) | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` |
| Full suite | `npm test` (root — 6 CI shards) + `cd dashboard && npx vitest run` |

CI runs 6 parallel shards via `npm test -- --shard=N/6`.

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Automated Command | File Exists? |
|-----|----------|-----------|-------------------|--------------|
| D-01 (agent_message_added) | `streamFilter` drops `agent_message_added` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | YES — `dashboard/src/hooks/streamFilter.test.ts` needs new cases |
| D-01 (memory_retrieval) | `streamFilter` drops `memory_retrieval` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | YES — needs new cases |
| D-01 (steward_run_added) | `streamFilter` drops `steward_run_added` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | YES — needs new cases |
| D-01 (agent_status_changed) | `streamFilter` drops `agent_status_changed` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | YES — needs new cases |
| D-01 backfill (xray) | `AgentStore.getRecent(50, headId)` returns only that head's agents | unit | `npx vitest run src/db/agents.test.ts` | YES — existing tests cover `getRecent(limit, headId?)` |
| D-01 backfill (steward) | `StewardRunStore.getRecent(N, headId)` returns only that head's runs | unit | `npx vitest run src/db/steward_runs.test.ts` | NO — Wave 0 gap |
| D-01 backfill route | `GET /api/agents/xray-history?head=A` returns only head A's agent messages | integration | `npx vitest run src/dashboard/routes/agents.test.ts` (if exists) | NO — gap |
| D-02 (limit) | Limit of 50 per-head preserved | unit | covered by `agents.test.ts` `getRecent` tests | YES |
| D-04 (migration) | `sql/010` runs without error; existing rows get `head_id='default'` | unit | `npx vitest run src/db/db.test.ts` | YES — db.test.ts runs all migrations |
| D-04 (single-head compat) | Single-head deployment sees identical behavior | smoke | manual — deploy with single head, verify timeline | manual only |

### Sampling Rate

- **Per task commit:** `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` (fast, covers the filter logic)
- **Per wave merge:** `npm test` (full root suite) + `cd dashboard && npx vitest run` (full dashboard suite)
- **Phase gate:** Both suites green before `/gsd:verify-work`

### Wave 0 Gaps (test files to create)

- [ ] `src/db/steward_runs.test.ts` — covers `getRecent(limit, headId?)` head-scoping (mirrors `src/db/agents.test.ts` shape)
- [ ] New test cases in `dashboard/src/hooks/streamFilter.test.ts` — the existing file has explicit TODO comments (`it('always delivers agent_status_changed (scope: out of phase per RESEARCH § A4)')`) that are now in-scope and must be changed from "always delivers" to "drops for wrong head"

---

## Security Domain

This phase does not add new authentication surfaces, user inputs, or cryptographic operations. The changes are:
- A new SQLite column (no user-controlled input beyond what's already validated)
- SSE event payload field additions (no new untrusted input surface)
- React Query key changes (client-side only)

ASVS categories V2, V3, V4, V6 are not applicable. V5 (input validation) is already handled — the `?head=` query parameter follows the same `typeof req.query['head'] === 'string'` guard pattern used in the existing messages and agents routes. New routes should copy this guard pattern. [VERIFIED: codebase read of `src/dashboard/routes/messages.ts:18` and `src/dashboard/routes/agents.ts:12`]

---

## Sources

### Primary (HIGH confidence)

- `dashboard/src/hooks/streamFilter.ts` — authoritative list of "accepted cross-head leakage" events, current drop logic
- `dashboard/src/hooks/useStream.ts` — all SSE event handlers and cache writes
- `dashboard/src/pages/ConversationsPage.tsx` — all query keys, reset effects, and timeline assembly
- `src/dashboard/events.ts` — server-side DashboardEvent union (read directly)
- `dashboard/src/types/api.ts:435-445` — client-side DashboardEvent union (read directly)
- `src/db/agents.ts:228-280, 305-314` — emit sites, getRecent implementation (read directly)
- `src/db/steward_runs.ts` — full file (read directly)
- `src/head/activation.ts:778, 1056-1062` — memory_retrieval emit + steward append call (read directly)
- `src/sub-agents/local.ts:885` — emitMessageAdded call site (read directly)
- `src/dashboard/routes/agents.ts` — xray-history route (read directly)
- `src/dashboard/routes/steward_runs.ts` — steward_runs route (read directly)
- `src/dashboard/routes/activity.ts` — activity route + confirmed unscoped reads (read directly)
- `sql/001_init.sql:105-109` — steward_runs table schema (read directly)
- `sql/005_multi_head.sql` — ADD COLUMN migration pattern (read directly)
- `sql/007_agents_head_id.sql` — agents head_id migration pattern (read directly)
- `git show 352b9dd` — precedent commit three-part pattern (read directly)
- `dashboard/src/hooks/streamFilter.test.ts` — existing test shape to extend (read directly)
- `src/db/agents.test.ts` — existing head-scoped getRecent tests (read directly)

### Secondary (MEDIUM confidence)

- React Query `invalidateQueries` prefix-match behavior — based on training knowledge of @tanstack/react-query v4/v5 API [ASSUMED — verify exact version in `package.json`]

---

## Metadata

**Confidence breakdown:**
- Leak inventory: HIGH — every file named in CONTEXT.md was read directly; grep sweeps confirmed no additional leaky surfaces
- Migration pattern: HIGH — mirror of existing 005/007 pattern is verified
- headId threading: HIGH — all call sites traced, headId confirmed available at each
- Test gaps: HIGH — file existence confirmed via `find` + read
- `['activity']` dead infrastructure: HIGH — exhaustive grep across all dashboard source files found zero `useQuery` subscribers

**Research date:** 2026-06-18
**Valid until:** 2026-07-18 (stable domain — SQLite migration patterns and React Query cache semantics are stable; no third-party dependencies changing)
