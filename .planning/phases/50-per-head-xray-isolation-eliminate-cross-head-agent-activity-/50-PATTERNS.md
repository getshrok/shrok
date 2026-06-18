# Phase 50: Per-head xray isolation - Pattern Map

**Mapped:** 2026-06-18
**Files analyzed:** 14 new/modified files
**Analogs found:** 14 / 14

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `sql/010_steward_runs_head_id.sql` | migration | batch | `sql/007_agents_head_id.sql` | exact |
| `src/db/steward_runs.ts` | model/store | CRUD | `src/db/agents.ts` (getRecent pattern) | exact |
| `src/db/steward_runs.test.ts` | test | batch | `src/db/agents.test.ts` | exact |
| `src/db/agents.ts` | model/store | event-driven | itself (existing emit pattern) | self-patch |
| `src/head/activation.ts` | service | event-driven | itself (existing emit at :778) | self-patch |
| `src/sub-agents/local.ts` | service | event-driven | itself (existing emitMessageAdded call at :885) | self-patch |
| `src/dashboard/events.ts` | model | event-driven | itself (existing DashboardEvent union) | self-patch |
| `src/dashboard/routes/agents.ts` | controller | request-response | `src/dashboard/routes/agents.ts` GET `/` (lines 11-14, ?head= pattern) | exact |
| `src/dashboard/routes/steward_runs.ts` | controller | request-response | `src/dashboard/routes/agents.ts` GET `/` (?head= + getRecent) | exact |
| `src/dashboard/routes/activity.ts` | controller | request-response | itself (dead infrastructure, future-proofing only) | self-patch |
| `dashboard/src/types/api.ts` | model | request-response | `src/dashboard/events.ts` (lockstep mirror) | exact |
| `dashboard/src/hooks/streamFilter.ts` | utility | event-driven | itself (existing shouldDeliverStreamEvent) | self-patch |
| `dashboard/src/hooks/useStream.ts` | hook | event-driven | itself (existing message_added handler lines 46-53) | self-patch |
| `dashboard/src/pages/ConversationsPage.tsx` | component | request-response | itself (agentsQuery + setKnownAgents reset, lines 553-580) | exact |

---

## Pattern Assignments

### `sql/010_steward_runs_head_id.sql` (migration, batch)

**Analog:** `sql/007_agents_head_id.sql`

**Full analog** (entire file):
```sql
-- sql/007_agents_head_id.sql
-- Phase 34: Add head_id isolation column to the agents table.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.
-- Mirrors the Phase 29 sql/005_multi_head.sql pattern for queue_events / messages.

ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Head-scoped compound index to mirror idx_queue_head_status_priority and
-- idx_messages_head_created. Anticipated read path: per-head agent listings
-- filtered by status (running / suspended). Even without v1.3 consumers, the
-- index keeps the agents table consistent with the rest of the multi-head data
-- model and avoids a future migration when the dashboard surfaces per-head agents.
CREATE INDEX IF NOT EXISTS idx_agents_head_status
  ON agents (head_id, status);
```

**Copy verbatim**, changing: table name `agents` → `steward_runs`, index name `idx_agents_head_status` → `idx_steward_runs_head_created`, index columns `(head_id, status)` → `(head_id, created_at DESC)`, and updating the comment header.

---

### `src/db/steward_runs.ts` (model/store, CRUD + event-driven)

**Analog:** `src/db/agents.ts` `getRecent(limit, headId?)` pattern (lines 302-314)

**Imports pattern** (lines 1-3, current):
```typescript
import { type DatabaseSync, type StatementSync } from './index.js'
import type { DashboardEventBus } from '../dashboard/events.js'
```

**Current StewardRun interface** (lines 4-8) — add `headId`:
```typescript
export interface StewardRun {
  id: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
  // ADD: headId: string
}
```

**Current StewardRunRow** (lines 10-14) — add `head_id`:
```typescript
interface StewardRunRow {
  id: string
  stewards: string
  created_at: string
  // ADD: head_id: string
}
```

**Current rowToRun mapper** (lines 16-22) — add `headId: row.head_id`:
```typescript
function rowToRun(row: StewardRunRow): StewardRun {
  return {
    id: row.id,
    stewards: JSON.parse(row.stewards) as Array<{ name: string; ran: boolean; fired: boolean }>,
    createdAt: row.created_at,
    // ADD: headId: row.head_id,
  }
}
```

**Current stmtInsert** (lines 29-32) — add `head_id` column:
```typescript
this.stmtInsert = db.prepare(`
  INSERT INTO steward_runs (id, stewards, created_at)
  VALUES (@id, @stewards, @created_at)
`)
// BECOMES:
this.stmtInsert = db.prepare(`
  INSERT INTO steward_runs (id, stewards, created_at, head_id)
  VALUES (@id, @stewards, @created_at, @head_id)
`)
```

**Current append** (lines 39-42) — add `head_id` to the run call:
```typescript
append(run: StewardRun): void {
  this.stmtInsert.run({ id: run.id, stewards: JSON.stringify(run.stewards), created_at: run.createdAt })
  this.eventBus?.emit('dashboard', { type: 'steward_run_added', payload: run })
  // BECOMES stmtInsert.run({ ..., head_id: run.headId })
  // The payload emit is unchanged — run.headId flows through because StewardRun now carries it
}
```

**getRecent analog to add** — copy from `src/db/agents.ts` lines 305-313:
```typescript
/** Returns the N most recently updated agents, newest first.
 *  When headId is provided, only agents belonging to that head are returned.
 *  When omitted, agents across all heads are returned (backward-compatible). */
getRecent(limit: number, headId?: string): AgentState[] {
  const rows = headId !== undefined
    ? this.db.prepare('SELECT * FROM agents WHERE head_id = ? ORDER BY updated_at DESC LIMIT ?').all(headId, limit) as unknown as AgentRow[]
    : this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as AgentRow[]
  return rows.map(row => {
    // ...
  })
}
```

Mirror this exactly for `StewardRunStore.getRecent(limit, headId?)`, substituting `steward_runs`, `created_at`, and `rowToRun`. The existing `getRecent(limit)` (line 49) becomes the head-less branch of this new overload.

---

### `src/db/steward_runs.test.ts` (test, batch) — NEW FILE

**Analog:** `src/db/agents.test.ts` (full file, lines 1-66)

**Full analog** (copy structure verbatim, adapt for StewardRunStore):
```typescript
/**
 * AgentStore.getRecent head-scoping tests (closes #10).
 *
 * Verifies that getRecent(limit, headId) returns only agents for the
 * given head, and that getRecent(limit) (no headId) returns agents
 * across all heads (backward-compatible).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as url from 'node:url'
import { initDb, type DatabaseSync } from './index.js'
import { runMigrations } from './migrate.js'
import { AgentStore } from './agents.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

function freshDb(): DatabaseSync {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

describe('AgentStore.getRecent(limit, headId?)', () => {
  let db: DatabaseSync
  let store: AgentStore

  beforeEach(() => {
    db = freshDb()
    store = new AgentStore(db)
  })

  it('returns only agents belonging to the specified head when headId is provided', () => {
    store.create('agent-a1', { task: 'task A1', trigger: 'manual', headId: 'A' })
    // ...
    const result = store.getRecent(10, 'A')
    expect(result).toHaveLength(2)
  })
  // ...
})
```

Substitute `StewardRunStore` for `AgentStore`, and `.append({ id, stewards:[], createdAt, headId })` for `.create(...)`. The three test cases to mirror: (1) returns only that head's runs, (2) returns all heads when omitted, (3) returns empty for nonexistent head.

---

### `src/db/agents.ts` (model/store, event-driven) — MODIFY

**Context:** All six emit methods must gain a `headId` parameter so the SSE payload carries it.

**Current emit pattern** (lines 228-263) — the pattern to replicate across all six methods:
```typescript
updateStatus(id: string, status: AgentStatus): void {
  this.stmtUpdateStatus.run(status, id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status } })
}

suspend(id: string, question: string): void {
  this.stmtSuspend.run(question, id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'suspended' } })
}

resume(id: string): void {
  this.stmtResume.run(id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'running' } })
}

/** Emit an SSE event for a new message appended to an agent's in-progress history. */
emitMessageAdded(agentId: string, message: Message, trigger?: string): void {
  this.eventBus?.emit('dashboard', { type: 'agent_message_added', payload: { agentId, message, trigger: trigger ?? 'manual' } })
}

complete(id: string, output: string): void {
  this.stmtComplete.run(output, id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'completed' } })
}

fail(id: string, error: string): void {
  this.stmtFail.run(error, id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status: 'failed' } })
}
```

**After Phase 50** — add optional `headId?: string` to each signature and include it on the emitted payload:
```typescript
updateStatus(id: string, status: AgentStatus, headId?: string): void {
  this.stmtUpdateStatus.run(status, id)
  this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id, status }, ...(headId !== undefined ? { headId } : {}) })
}
// Same spread pattern for suspend, resume, complete, fail.

emitMessageAdded(agentId: string, message: Message, trigger?: string, headId?: string): void {
  this.eventBus?.emit('dashboard', { type: 'agent_message_added', payload: { agentId, message, trigger: trigger ?? 'manual' }, ...(headId !== undefined ? { headId } : {}) })
}
```

**cancelAllActive** (lines 276-283) — same loop, pass head_id from the agent row. Lookup `agent.headId` from the already-fetched `AgentState` (which has `head_id` populated from the DB):
```typescript
cancelAllActive(): number {
  const active = this.getActive()
  this.stmtCancelAllActive.run()
  for (const a of active) {
    this.eventBus?.emit('dashboard', { type: 'agent_status_changed', payload: { id: a.id, status: 'retracted' }, headId: a.headId })
  }
  return active.length
}
```

---

### `src/head/activation.ts` (service, event-driven) — MODIFY

**Context:** Two sites — the `memory_retrieval` emit and the steward `append` call. `this.opts.headId` is in scope at both.

**memory_retrieval emit** (line 778, current):
```typescript
this.opts.events?.emit('dashboard', { type: 'memory_retrieval', payload: { text: context.memoryBlock, eventId: event.id, tokens: estimateStringTokens(context.memoryBlock) } })
```

**After Phase 50** — add `headId`:
```typescript
this.opts.events?.emit('dashboard', { type: 'memory_retrieval', payload: { text: context.memoryBlock, eventId: event.id, tokens: estimateStringTokens(context.memoryBlock) }, headId: this.opts.headId })
```

**steward append call** (lines 1057-1061, current):
```typescript
this.opts.stewardRunStore?.append({
  id: generateId('jr'),
  stewards: results,
  createdAt: new Date().toISOString(),
})
```

**After Phase 50** — add `headId`:
```typescript
this.opts.stewardRunStore?.append({
  id: generateId('jr'),
  stewards: results,
  createdAt: new Date().toISOString(),
  headId: this.opts.headId,
})
```

---

### `src/sub-agents/local.ts` (service, event-driven) — MODIFY

**Context:** `emitMessageAdded` call at line 885. `this.headId` is the private readonly field at line 101.

**Current call** (line 885):
```typescript
this.agentStore.emitMessageAdded(agentId, msg, options.trigger)
```

**After Phase 50** — pass `this.headId` as the fourth argument:
```typescript
this.agentStore.emitMessageAdded(agentId, msg, options.trigger, this.headId)
```

---

### `src/dashboard/events.ts` (model, event-driven) — MODIFY

**Analog:** `message_added` and `typing` union members at lines 7 and 13 (the two already-scoped members, showing the pattern).

**Current union** (lines 6-16):
```typescript
export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string } }
  | { type: 'steward_run_added'; payload: StewardRun }
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing'; headId: string }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number } }
```

**After Phase 50** — add `headId: string` to the four leaky members (mirror `message_added`):
```typescript
export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus }; headId: string }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string }; headId: string }
  | { type: 'steward_run_added'; payload: StewardRun }   // headId flows via StewardRun.headId on payload
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing'; headId: string }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number }; headId: string }
```

Note: `steward_run_added` does NOT get a top-level `headId`. Its head context travels INSIDE the payload as `payload.headId` (the `StewardRun.headId` field added in Plan 01, wave 1). The emit `{ type:'steward_run_added', payload: run }` stays unchanged. Only `agent_status_changed`, `agent_message_added`, and `memory_retrieval` gain a top-level `headId: string` (their emit sites have headId in scope at emit and are updated in this wave). `streamFilter.ts` narrows per-type: top-level `event.headId` for those three, `(event.payload as StewardRun).headId` for `steward_run_added`.

---

### `dashboard/src/types/api.ts` (model, request-response) — MODIFY

**Analog:** `src/dashboard/events.ts` — lockstep mirror. Lines 435-445 (current):
```typescript
export type DashboardEvent =
  | { type: 'message_added'; payload: Message; headId: string }
  | { type: 'agent_status_changed'; payload: { id: string; status: AgentStatus } }
  | { type: 'agent_message_added'; payload: { agentId: string; message: Message; trigger: string } }
  | { type: 'steward_run_added'; payload: StewardRun }
  | { type: 'usage_updated' }
  | { type: 'assistant_name_changed'; payload: { name: string } }
  | { type: 'typing'; headId: string }
  | { type: 'theme_changed'; payload: { accentColor: string; logoUrl: string } }
  | { type: 'thresholds_changed' }
  | { type: 'memory_retrieval'; payload: { text: string; eventId?: string; tokens: number } }
```

Apply the identical four additions as `src/dashboard/events.ts`.

**Also update `StewardRun` interface** (lines 60-64) — add `headId`:
```typescript
export interface StewardRun {
  id: string
  stewards: Array<{ name: string; ran: boolean; fired: boolean }>
  createdAt: string
  // ADD: headId: string
}
```

---

### `src/dashboard/routes/agents.ts` (controller, request-response) — MODIFY

**Analog:** The existing GET `/` route in the same file (lines 11-14) — exact pattern for accepting `?head=` and passing it to `getRecent`:
```typescript
router.get('/', requireAuth, (req: Request, res: Response): void => {
  const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
  const recent = agents.getRecent(20, head)
  // ...
})
```

**Current xray-history route** (lines 65-90):
```typescript
router.get('/xray-history', requireAuth, (_req: Request, res: Response): void => {
  const recent = agents.getRecent(50)
  // ...
})
```

**After Phase 50** — one-line change: destructure `req` from `_req` and apply the same `?head=` guard:
```typescript
router.get('/xray-history', requireAuth, (req: Request, res: Response): void => {
  const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
  const recent = agents.getRecent(50, head)
  // rest unchanged
})
```

---

### `src/dashboard/routes/steward_runs.ts` (controller, request-response) — MODIFY

**Analog:** `src/dashboard/routes/agents.ts` GET `/` (lines 11-14) — exact `?head=` + `getRecent(N, head)` pattern.

**Current route** (lines 9-11):
```typescript
router.get('/', requireAuth, (_req: Request, res: Response): void => {
  res.json({ stewardRuns: stewardRuns.getAll() })
})
```

**After Phase 50** — accept `?head=`, switch `getAll()` → `getRecent(60, head)`:
```typescript
router.get('/', requireAuth, (req: Request, res: Response): void => {
  const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
  res.json({ stewardRuns: stewardRuns.getRecent(60, head) })
})
```

The limit 60 mirrors `stewardRuns.getRecent(60)` already used in `activity.ts:66`.

---

### `src/dashboard/routes/activity.ts` (controller, request-response) — MODIFY (future-proofing only)

**Status:** Dead infrastructure — no component subscribes to `['activity']`. Scope the three unscoped reads as future-proofing. The `?head=` guard pattern is identical to every other route above.

**Three reads to scope** (lines 32, 46, 66):
```typescript
messages.getRecentText('default', 60)   // hardcoded 'default' — REPLACE with head param or leave scoped to 'default'
agents.getRecent(40)                    // REPLACE with agents.getRecent(40, head)
stewardRuns.getRecent(60)               // REPLACE with stewardRuns.getRecent(60, head)
```

Accept `?head=` at line 28 (same guard as all other routes). The three `invalidateQueries({ queryKey: ['activity'] })` calls in `useStream.ts` are dead code — remove them as part of this change.

---

### `dashboard/src/hooks/streamFilter.ts` (utility, event-driven) — MODIFY

**Analog:** The existing function is the analog — the Phase 50 change expands its drop set from 2 to 6 event types.

**Current full file** (lines 1-25):
```typescript
import type { DashboardEvent } from '../types/api'

/**
 * Per-head SSE filter (D-11 minimum-correct scope per RESEARCH § A4).
 *
 * Returns false ONLY for `message_added` and `typing` events whose
 * headId does not match the currently selected head. Every other event
 * type passes through unconditionally — they are either process-wide
 * (usage_updated, theme_changed, thresholds_changed,
 * assistant_name_changed) or accepted cross-head leakage in this phase
 * (agent_status_changed, agent_message_added, steward_run_added,
 * memory_retrieval — see T-33-09).
 *
 * @param selectedHead Currently selected head id, or null to deliver every
 *   per-head event regardless (used during initial render before head is
 *   resolved).
 */
export function shouldDeliverStreamEvent(
  event: DashboardEvent,
  selectedHead: string | null,
): boolean {
  if (event.type !== 'message_added' && event.type !== 'typing') return true
  if (selectedHead === null) return true
  return event.headId === selectedHead
}
```

**After Phase 50** — replace the double-negation guard with a positive per-head set. The doc comment must also drop the T-33-09 deferred list (it's no longer deferred):
```typescript
import type { DashboardEvent } from '../types/api'

/**
 * Per-head SSE filter.
 *
 * Returns false for per-head event types whose headId does not match the
 * currently selected head. Process-wide events (usage_updated,
 * theme_changed, thresholds_changed, assistant_name_changed) always pass.
 *
 * @param selectedHead Currently selected head id, or null to deliver every
 *   per-head event regardless (used during initial render before head is
 *   resolved).
 */
export function shouldDeliverStreamEvent(
  event: DashboardEvent,
  selectedHead: string | null,
): boolean {
  const perHeadTypes = new Set([
    'message_added', 'typing',
    'agent_message_added', 'agent_status_changed',
    'memory_retrieval', 'steward_run_added',
  ])
  if (!perHeadTypes.has(event.type)) return true
  if (selectedHead === null) return true
  return (event as { headId: string }).headId === selectedHead
}
```

**Test file update** (`dashboard/src/hooks/streamFilter.test.ts`): the two existing "always delivers" tests (lines 41-51) must flip from asserting `true` to asserting `false` for a mismatched head. Add matching/null-head cases for each new event type. The existing passing test shape (lines 14-17) is the template for each new test case.

---

### `dashboard/src/hooks/useStream.ts` (hook, event-driven) — MODIFY

**Analog:** The existing `message_added` handler (lines 39-55) — the canonical per-head cache routing pattern to replicate.

**Existing message_added handler** (lines 39-54 — the template):
```typescript
if (event.type === 'message_added') {
  qc.setQueryData(['typing'], false)
  if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null }
  // Phase 33 (D-11): SSE payload now carries headId; route to its
  // head-scoped cache entry. The filter above guarantees
  // event.headId === currentHeadIdRef.current here, so we use the
  // event's own headId rather than re-reading the ref.
  const headId = event.headId
  qc.setQueryData(
    ['messages', headId],
    (old: { messages: Message[] } | undefined) => ({
      messages: [...(old?.messages ?? []), event.payload],
    }),
  )
  void qc.invalidateQueries({ queryKey: ['activity'] })
}
```

**Three handlers to update:**

1. **`agent_message_added`** (lines 60-78) — add head-key to `['xray-messages']` accumulator. After `streamFilter` passes this event, `event.headId` is guaranteed to equal `currentHeadIdRef.current`. Use `event.headId` as the cache key component:
```typescript
if (event.type === 'agent_message_added') {
  // ... existing agent-history update unchanged ...
  if (trigger === 'manual' && (message.kind === 'tool_call' || message.kind === 'tool_result')) {
    qc.setQueryData(
      ['xray-messages', event.headId],   // ADD head component
      (old: Array<{ agentId: string; message: Message }> | undefined) =>
        [...(old ?? []), { agentId, message }],
    )
  }
}
```

2. **`steward_run_added`** (lines 79-87) — add head-key to `['stewardRuns']` accumulator and REMOVE the dead `['activity']` invalidation:
```typescript
if (event.type === 'steward_run_added') {
  qc.setQueryData(
    ['stewardRuns', event.headId],   // ADD head component
    (old: { stewardRuns: StewardRun[] } | undefined) => ({
      stewardRuns: [...(old?.stewardRuns ?? []), event.payload],
    }),
  )
  // REMOVE: void qc.invalidateQueries({ queryKey: ['activity'] })
}
```

3. **`agent_status_changed`** (lines 56-59) — narrow the `['agents']` invalidation to the specific head and REMOVE the dead `['activity']` invalidation:
```typescript
if (event.type === 'agent_status_changed') {
  void qc.invalidateQueries({ queryKey: ['agents', event.headId] })  // NARROW from ['agents']
  // REMOVE: void qc.invalidateQueries({ queryKey: ['activity'] })
}
```

4. **`memory_retrieval`** (lines 118-125) — add head-key to `['memory-retrievals']` accumulator:
```typescript
if (event.type === 'memory_retrieval') {
  const { text, eventId, tokens } = event.payload
  qc.setQueryData(
    ['memory-retrievals', event.headId],   // ADD head component
    (old: Array<{ text: string; eventId?: string; tokens: number }> | undefined) =>
      [...(old ?? []), { text, eventId, tokens }],
  )
}
```

Also REMOVE the `void qc.invalidateQueries({ queryKey: ['activity'] })` at line 54 (the `message_added` handler's dead invalidation).

---

### `dashboard/src/pages/ConversationsPage.tsx` (component, request-response) — MODIFY

**Analog:** The existing `agentsQuery` + `setKnownAgents` pattern (lines 553-580) — the exact precedent from commit `352b9dd`.

**Existing precedent** (lines 553-580 — copy this three-part shape for each leaky surface):

Part 1 — head-key the backfill query:
```typescript
const agentsQuery = useQuery({
  queryKey: ['agents', selectedHead],        // head component
  queryFn: () => api.agents.list(selectedHead),  // passes ?head=
  enabled: agentsEnabled,
  refetchInterval: agentsEnabled ? 5_000 : false,
})
```

Part 2 — head-key the live accumulator query (so cache miss on head switch triggers backfill):
```typescript
// (the messages query at lines 537-541 is the head-keyed backfill for the conversation)
const messagesQuery = useQuery({
  queryKey: ['messages', selectedHead],      // head component
  queryFn: () => api.messages.list(selectedHead),
  refetchOnWindowFocus: false,
})
```

Part 3 — reset accumulator on head switch:
```typescript
useEffect(() => {
  setKnownAgents(new Map())
}, [selectedHead])
```

**Four changes to `ConversationsPage.tsx`:**

1. **xray backfill query** (line 516-521) — add `selectedHead` to cache key and pass to API:
```typescript
const { data: xrayBackfill } = useQuery({
  queryKey: ['xray-backfill', selectedHead],              // WAS: ['xray-backfill']
  queryFn: () => api.agents.xrayHistory(selectedHead),    // WAS: api.agents.xrayHistory
  enabled: visibility.agentWork,
  staleTime: Infinity,
})
```

2. **xray live accumulator query** (line 522-527) — add `selectedHead` to cache key:
```typescript
const { data: xrayLive } = useQuery<Array<{ agentId: string; message: Message }>>({
  queryKey: ['xray-messages', selectedHead],   // WAS: ['xray-messages']
  initialData: [],
  staleTime: Infinity,
  enabled: visibility.agentWork,
})
```

3. **stewardRuns query** (lines 562-565) — add `selectedHead` to cache key and pass to API:
```typescript
const stewardRunsQuery = useQuery({
  queryKey: ['stewardRuns', selectedHead],              // WAS: ['stewardRuns']
  queryFn: () => api.stewardRuns.list(selectedHead),    // WAS: api.stewardRuns.list
})
```

4. **memory-retrievals query** (lines 529-534) — add `selectedHead` to cache key:
```typescript
const { data: memoryRetrievals } = useQuery<Array<{ text: string; eventId?: string; tokens?: number }>>({
  queryKey: ['memory-retrievals', selectedHead],   // WAS: ['memory-retrievals']
  initialData: [],
  staleTime: Infinity,
  enabled: visibility.memoryRetrievals,
})
```

5. **Reset effects on head switch** — co-locate with existing `setKnownAgents` reset at line 578. For `staleTime: Infinity` accumulator caches the head-key change is the automatic refetch trigger; the explicit reset effect clears stale live items before the new backfill arrives:
```typescript
// Existing (line 578):
useEffect(() => {
  setKnownAgents(new Map())
}, [selectedHead])

// ADD — same shape, three new accumulators:
useEffect(() => {
  qc.setQueryData(['xray-messages', selectedHead], [])
}, [selectedHead, qc])

useEffect(() => {
  qc.setQueryData(['memory-retrievals', selectedHead], [])
}, [selectedHead, qc])

// stewardRuns — head-key change triggers auto-refetch; live accumulator reset is optional
// (the backfill re-fetch replaces it via queryKey). If live steward items linger, add:
useEffect(() => {
  qc.setQueryData(['stewardRuns', selectedHead], { stewardRuns: [] })
}, [selectedHead, qc])
```

---

### `dashboard/src/lib/api.ts` (utility, request-response) — MODIFY

**Analog:** `agents.list(headId?)` (line 133-134) — the exact `headId ?` ternary URL pattern from commit `352b9dd`.

**Existing agents.list pattern** (line 133-134):
```typescript
list: (headId?: string) =>
  request<...>(headId ? `/api/agents?head=${encodeURIComponent(headId)}` : '/api/agents'),
```

**Two functions to update:**

1. `agents.xrayHistory` (line 139-140) — add `headId?` parameter:
```typescript
xrayHistory: (headId?: string) =>
  request<{ messages: Array<{ agentId: string; message: Message }> }>(
    headId ? `/api/agents/xray-history?head=${encodeURIComponent(headId)}` : '/api/agents/xray-history'
  ),
```

2. `stewardRuns.list` — currently no `headId` parameter; add one with the same pattern:
```typescript
// Locate the stewardRuns api object and add headId? parameter
list: (headId?: string) =>
  request<{ stewardRuns: StewardRun[] }>(
    headId ? `/api/steward-runs?head=${encodeURIComponent(headId)}` : '/api/steward-runs'
  ),
```

---

## Shared Patterns

### `?head=` query param guard
**Source:** `src/dashboard/routes/agents.ts` lines 11-13 (GET `/` route)
**Apply to:** All three modified routes (`/xray-history`, steward_runs GET `/`, activity GET `/`)
```typescript
const head = typeof req.query['head'] === 'string' ? req.query['head'] : undefined
```

### `ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'`
**Source:** `sql/007_agents_head_id.sql` lines 7-15
**Apply to:** `sql/010_steward_runs_head_id.sql`
SQLite populates all existing rows with `'default'` atomically — no explicit UPDATE needed.

### `headId?` optional param on emit methods
**Source:** `src/db/agents.ts` `getRecent(limit, headId?)` lines 305-313
**Apply to:** `updateStatus`, `suspend`, `resume`, `complete`, `fail`, `emitMessageAdded` in `src/db/agents.ts`
Make `headId` optional so single-head callers that don't yet pass it continue to compile.

### `['cache-key', selectedHead]` React Query head-key convention
**Source:** `dashboard/src/pages/ConversationsPage.tsx` line 556 (`['agents', selectedHead]`), `dashboard/src/lib/api.ts` line 134
**Apply to:** `['xray-backfill']`, `['xray-messages']`, `['stewardRuns']`, `['memory-retrievals']`
Each head gets its own cache entry; head-switch = cache miss = automatic fresh fetch.

### `useEffect(() => { reset }, [selectedHead])` accumulator reset
**Source:** `dashboard/src/pages/ConversationsPage.tsx` lines 576-580 (the `setKnownAgents` effect)
**Apply to:** `['xray-messages']`, `['memory-retrievals']`, `['stewardRuns']` live accumulators

---

## No Analog Found

All files in scope have close analogs within the codebase. No files require patterns from RESEARCH.md code examples instead.

---

## Metadata

**Analog search scope:** `src/db/`, `src/dashboard/routes/`, `src/head/`, `src/sub-agents/`, `dashboard/src/hooks/`, `dashboard/src/pages/`, `dashboard/src/lib/`, `dashboard/src/types/`, `sql/`
**Files scanned:** 18
**Pattern extraction date:** 2026-06-18
