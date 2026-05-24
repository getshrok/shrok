# Phase 44: Multi-head task delivery - Pattern Map

**Mapped:** 2026-05-24
**Files analyzed:** 10 (2 new, 8 modified)
**Analogs found:** 10 / 10

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `sql/008_agents_deliver_to_head_ids.sql` | migration | batch | `sql/007_agents_head_id.sql` | exact |
| `src/types/agent.ts` | model | — | `src/types/agent.ts` (existing `headId` fields) | exact |
| `src/db/schedules.ts` | model/service | CRUD | `src/db/schedules.ts` (existing `requiresAck`/`headId` pattern) | exact |
| `src/db/agents.ts` | model/service | CRUD | `src/db/agents.ts` (existing `tools`/`capabilities` JSON columns + `head_id`) | exact |
| `src/sub-agents/local.ts` | service | event-driven | `src/sub-agents/local.ts` (existing `completeAgent`/`suspendAsQuestion`) | exact |
| `src/head/activation.ts` | service | request-response | `src/head/activation.ts` (existing `handleScheduleTrigger` spawn site) | exact |
| `src/dashboard/routes/schedules.ts` | route/controller | request-response | `src/dashboard/routes/schedules.ts` (existing headId + ack/nag validation) | exact |
| `dashboard/src/types/api.ts` | model | — | `dashboard/src/types/api.ts` (existing `Schedule.headId`) | exact |
| `dashboard/src/pages/SchedulesPage.tsx` | component | request-response | `dashboard/src/pages/SchedulesPage.tsx` (existing single-head `<select>` + HEAD_COLORS chips) | exact |
| `tests/integration/multi-head-task-delivery.test.ts` | test | event-driven | `tests/integration/multi-head-agent-lifecycle.test.ts` | exact |

---

## Pattern Assignments

### `sql/008_agents_deliver_to_head_ids.sql` (migration, batch)

**Analog:** `sql/007_agents_head_id.sql` (lines 1–15)

**Full analog** (`sql/007_agents_head_id.sql` lines 1–15):
```sql
-- Phase 34: Add head_id isolation column to the agents table.
-- SQLite ALTER TABLE ADD COLUMN with a constant DEFAULT populates all existing
-- rows with 'default' immediately — no explicit UPDATE backfill required.
ALTER TABLE agents ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default';

-- Head-scoped compound index to mirror idx_queue_head_status_priority and
-- idx_messages_head_created.
CREATE INDEX IF NOT EXISTS idx_agents_head_status
  ON agents (head_id, status);
```

**New file DDL to copy:**
```sql
-- sql/008_agents_deliver_to_head_ids.sql
-- Phase 44: Persist the task delivery set on the agents row.
-- DEFAULT '[]' covers all existing rows (empty set = owner-only, today's behavior).
-- Mirrors sql/007_agents_head_id.sql pattern exactly.
ALTER TABLE agents ADD COLUMN deliver_to_head_ids TEXT NOT NULL DEFAULT '[]';
```
No index is needed (the column is not a query predicate — it is read only at completion fan-out for the single running agent).

---

### `src/types/agent.ts` (model)

**Analog:** existing `headId` / `parentAgentId` declarations in `src/types/agent.ts`

**AgentState — `headId` declaration pattern** (lines 44–46):
```typescript
/** Head this agent belongs to (Phase 34). Carried through the agents.head_id column. */
headId: string
```

**SpawnOptions — optional field pattern** (lines 72–79, `parentAgentId` and `headHistory`):
```typescript
parentAgentId?: string
/** Head conversation history to prepend as context. */
headHistory?: Message[]
```

**SpawnOptions — required `headId` with rationale comment** (lines 67–70):
```typescript
/** Required: head this agent belongs to. Determines which head's activation loop
 *  claims the agent's completion / question / response queue events. Phase 34 D-SPAWN-REQUIRED:
 *  no silent 'default' fallback — type-enforced so missed call sites are compile errors. */
headId: string
```

**New fields to add:**

On `AgentState` (after `headId` line 45) — required because `rowToState` always produces a value from the JSON column:
```typescript
/** Delivery set for fan-out at completion (Phase 44). Only populated on top-level
 *  scheduled agents. Empty array = owner-only (today's behavior). */
deliverToHeadIds: string[]
```

On `SpawnOptions` (after `parentAgentId`) — optional because sub-agent and manual spawns never set it:
```typescript
/** Optional delivery set (Phase 44). Only meaningful for top-level scheduled agents.
 *  Sub-agents and manual spawns leave this absent (= []). */
deliverToHeadIds?: string[]
```

`exactOptionalPropertyTypes` note: when constructing objects with this field, use conditional spread `...(arr.length ? { deliverToHeadIds: arr } : {})` rather than assigning `undefined`.

---

### `src/db/schedules.ts` (model/service, CRUD)

**Analog:** existing `requiresAck` / `nagIntervalMinutes` / `headId` fields — same file

**Schedule interface — optional boolean/null fields pattern** (lines 19–23):
```typescript
/** Whether this reminder requires explicit user acknowledgment before it stops nagging. */
requiresAck: boolean
/** Total nag cadence in minutes. Null/inert when requiresAck is false. */
nagIntervalMinutes: number | null
/** Whether an ack-required reminder currently has an outstanding nag. */
ackPending: boolean
```

**CreateScheduleOptions — optional field pattern** (lines 38–41):
```typescript
requiresAck?: boolean
nagIntervalMinutes?: number | null
ackPending?: boolean
```

**SchedulePatch — Partial<Pick<>> pattern** (lines 44–47):
```typescript
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' |
  'agentContext' | 'cronTimezone' | 'ackPending' | 'requiresAck' | 'nagIntervalMinutes'
>>
```

**`create()` — conditional spread for optional fields** (lines 96–98):
```typescript
requiresAck: options.requiresAck ?? false,
nagIntervalMinutes: options.nagIntervalMinutes ?? null,
ackPending: options.ackPending ?? false,
```

**`update()` — patch application pattern** (lines 137–148):
```typescript
if (patch.cron !== undefined) existing.cron = patch.cron
if (patch.runAt !== undefined) existing.runAt = patch.runAt
if (patch.enabled !== undefined) existing.enabled = patch.enabled
// ...
if (patch.requiresAck !== undefined) existing.requiresAck = patch.requiresAck
if (patch.nagIntervalMinutes !== undefined) existing.nagIntervalMinutes = patch.nagIntervalMinutes
```

**`migrateLegacySchedule()` — idempotent `'field' in obj` guard** (lines 61–69):
```typescript
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

**New additions:**

`Schedule` interface — add optional field (tasks only; absent on reminders and legacy rows is correct):
```typescript
/** Additional heads to deliver task completion to (Phase 44).
 *  Only meaningful for kind:'task'. Absent on reminders and legacy rows.
 *  Effective delivery set is dedupe([headId, ...deliverToHeadIds]). */
deliverToHeadIds?: string[]
```

`SchedulePatch` — add `'deliverToHeadIds'` to the union (D-08: editable via PATCH, unlike `headId`).

`create()` — use conditional spread (not `?? []`, which would set `[]` and add key noise to reminder rows):
```typescript
...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {}),
```

`update()` — when the patch value is empty array, `delete existing.deliverToHeadIds` (not `= []`). `exactOptionalPropertyTypes` forbids assigning `undefined`; `delete` removes the key cleanly:
```typescript
if (patch.deliverToHeadIds !== undefined) {
  if (patch.deliverToHeadIds.length > 0) {
    existing.deliverToHeadIds = patch.deliverToHeadIds
  } else {
    delete existing.deliverToHeadIds
  }
}
```

`migrateLegacySchedule()` — NO new guard. Absent key on legacy row is intentional (D-02: absent = owner-only). Adding a guard would mark files migrated and update mtime with no semantic gain.

---

### `src/db/agents.ts` (model/service, CRUD)

**Analog:** existing `head_id`, `tools`, `capabilities` columns — same file

**`AgentRow` interface — JSON TEXT column + required TEXT column pattern** (lines 9–30):
```typescript
interface AgentRow {
  // ...
  tools: string          // JSON TEXT
  capabilities: string   // JSON TEXT
  // ...
  head_id: string        // required TEXT
  // ...
}
```

**`rowToState()` — JSON.parse deserialization + conditional spread pattern** (lines 32–53):
```typescript
function rowToState(row: AgentRow, history: Message[]): AgentState {
  return {
    // ...
    headId: row.head_id,
    // conditional spread for nullable columns:
    ...(row.skill_name != null ? { skillName: row.skill_name } : {}),
    ...(row.parent_agent_id != null ? { parentAgentId: row.parent_agent_id } : {}),
    ...(row.color_slot != null ? { colorSlot: row.color_slot } : {}),
  }
}
```

**`stmtCreate` INSERT — column list + named bind parameters** (lines 77–82):
```typescript
this.stmtCreate = db.prepare(`
  INSERT INTO agents
    (id, skill_name, status, task, instructions, tier, tools, capabilities, trigger, parent_agent_id, head_id, color_slot, created_at, updated_at)
  VALUES
    (@id, @skill_name, 'running', @task, @instructions, @tier, @tools, @capabilities, @trigger, @parent_agent_id, @head_id, @color_slot, datetime('now'), datetime('now'))
`)
```

**`create()` — JSON.stringify for array columns + `?? null` for nullable** (lines 182–197):
```typescript
create(id: string, options: SpawnOptions): AgentState {
  const colorSlot = this.pickColorSlot()
  this.stmtCreate.run({
    id,
    skill_name: options.skillName ?? null,
    task: options.prompt,
    // ...
    tools: JSON.stringify([]),
    capabilities: JSON.stringify([]),
    trigger: options.trigger,
    parent_agent_id: options.parentAgentId ?? null,
    head_id: options.headId,
    color_slot: colorSlot,
  })
  return this.get(id)!
}
```

**New additions:**

Add to `AgentRow`:
```typescript
deliver_to_head_ids: string   // JSON-encoded string[], DEFAULT '[]' in SQL
```

Add to `rowToState` (always present from the DEFAULT, so no conditional spread needed):
```typescript
deliverToHeadIds: JSON.parse(row.deliver_to_head_ids) as string[],
```

Add `deliver_to_head_ids` to `stmtCreate` INSERT column list and VALUES (`@deliver_to_head_ids`).

Add to `create()` binding:
```typescript
deliver_to_head_ids: JSON.stringify(options.deliverToHeadIds ?? []),
```

Use `for...of` (not index access) when iterating the deserialized array — `noUncheckedIndexedAccess` makes `arr[i]` return `string | undefined`.

---

### `src/sub-agents/local.ts` (service, event-driven)

**Analog:** existing `completeAgent`, `suspendAsQuestion`, `resumeSuspended` — same file

**`resumeSuspended()` — preserves head identity from `state`, not `this.headId`** (lines 394–404):
```typescript
private async resumeSuspended(agentId: string, state: import('../types/agent.js').AgentState): Promise<void> {
  const savedVerbose = this.verboseCallbacks.get(agentId)
  const options: SpawnOptions = {
    prompt: state.task,
    model: state.model,
    trigger: state.trigger,
    headId: state.headId,   // Phase 34 D-RUNNER-HEADID: preserve head identity across resume
    ...(state.skillName ? { skillName: state.skillName } : {}),
    ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
    ...(savedVerbose ? { onVerbose: savedVerbose } : {}),
  }
```

**`completeAgent()` — top-level single `enqueue` to `this.headId`** (lines 971–991):
```typescript
private completeAgent(
  agentId: string,
  output: string,
  options: SpawnOptions,
  history: Message[],
): void {
  this.agentStore.complete(agentId, output)
  if (options.parentAgentId) {
    this.inboxStore.write(options.parentAgentId, 'sub_agent_completed',
      JSON.stringify({ subWorkerId: agentId, output }))
    this.emitters.get(options.parentAgentId)?.emit('inbox')
  } else {
    this.queueStore.enqueue({
      type: 'agent_completed',
      id: generateId('qe'),
      agentId: agentId,
      output,
      createdAt: now(),
    }, PRIORITY.AGENT_COMPLETED, this.headId)   // <-- fan-out replaces this single enqueue
  }
}
```

**`suspendAsQuestion()` — top-level single `enqueue` to `this.headId`** (lines 993–1007):
```typescript
private suspendAsQuestion(
  agentId: string, question: string, options: SpawnOptions, history: Message[],
): void {
  this.agentStore.suspend(agentId, question)
  if (options.parentAgentId) {
    this.inboxStore.write(options.parentAgentId, 'sub_agent_question',
      JSON.stringify({ subWorkerId: agentId, question }))
    this.emitters.get(options.parentAgentId)?.emit('inbox')
  } else {
    this.queueStore.enqueue({
      type: 'agent_question', id: generateId('qe'),
      agentId, question, createdAt: now(),
    }, PRIORITY.AGENT_QUESTION, this.headId)   // unchanged — stays single-head
  }
}
```

**`buildAgentExecutor` `ctx.complete` closure — second `agent_completed` enqueue site** (lines 1025–1034):
```typescript
complete: (output: string) => {
  this.agentStore.complete(agentId, output)
  this.queueStore.enqueue({
    type: 'agent_completed',
    id: generateId('qe'),
    agentId: agentId,
    output,
    createdAt: now(),
  }, PRIORITY.AGENT_COMPLETED, this.headId)   // <-- fan-out replaces this too
  state.completed = true
},
```

**Changes to make:**

`resumeSuspended` — add delivery set preservation after `headId` (conditional spread mirrors existing `skillName`/`parentAgentId` pattern):
```typescript
...(state.deliverToHeadIds.length ? { deliverToHeadIds: state.deliverToHeadIds } : {}),
```

`completeAgent` top-level `else` — replace single `enqueue` with fan-out loop:
```typescript
} else {
  const deliverySet = [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
  for (const targetHeadId of deliverySet) {
    this.queueStore.enqueue({
      type: 'agent_completed',
      id: generateId('qe'),
      agentId,
      output,
      createdAt: now(),
    }, PRIORITY.AGENT_COMPLETED, targetHeadId)
  }
}
```

`buildAgentExecutor` `ctx.complete` closure — apply the identical fan-out (same `options` is in scope as the closure's enclosing parameter):
```typescript
complete: (output: string) => {
  this.agentStore.complete(agentId, output)
  const deliverySet = [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
  for (const targetHeadId of deliverySet) {
    this.queueStore.enqueue({
      type: 'agent_completed',
      id: generateId('qe'),
      agentId,
      output,
      createdAt: now(),
    }, PRIORITY.AGENT_COMPLETED, targetHeadId)
  }
  state.completed = true
},
```

`suspendAsQuestion` — add trigger gate at top, before `agentStore.suspend`:
```typescript
// D-06: scheduled agents have no human attached — force completion instead of suspension.
if (options.trigger === 'scheduled') {
  this.completeAgent(agentId, question, options, history)
  return
}
```

`agent_failed` — no change needed. All `agent_failed` enqueue sites use `this.headId` directly. D-05 (owner-only) is already the structural behavior.

---

### `src/head/activation.ts` (service, request-response)

**Analog:** existing `handleScheduleTrigger` spawn site — same file

**Existing spawn call** (lines 1282–1289):
```typescript
await this.opts.toolExecutorOpts.agentRunner.spawn({
  agentId,
  prompt,
  trigger: 'scheduled',
  headId: this.opts.headId,   // Phase 34 D-EXEC-OPTION: scheduled agents inherit the head's identity
  skillName: taskName!,
  ...(scheduledModel ? { model: scheduledModel } : {}),
})
```

The conditional spread `...(scheduledModel ? { model: scheduledModel } : {})` is the pattern for optionally adding fields — mirrors exactly what the new `deliverToHeadIds` pass-through needs.

**Change to make** — add one more conditional spread after the model spread:
```typescript
await this.opts.toolExecutorOpts.agentRunner.spawn({
  agentId,
  prompt,
  trigger: 'scheduled',
  headId: this.opts.headId,
  skillName: taskName!,
  ...(scheduledModel ? { model: scheduledModel } : {}),
  ...(schedule?.deliverToHeadIds?.length ? { deliverToHeadIds: schedule.deliverToHeadIds } : {}),
})
```

The `schedule` variable is already in scope at this site from `handleScheduleTrigger`'s earlier `getDue()` call. The `?.length` guard satisfies `exactOptionalPropertyTypes` — key is omitted entirely when absent or empty.

---

### `src/dashboard/routes/schedules.ts` (route/controller, request-response)

**Analog:** existing POST `headId` validation + PATCH `headId` reassignment ban — same file

**POST headId validation pattern — fail-fast, admin-404 stance** (lines 31–41):
```typescript
const rawHeadId = (req.body as { headId?: unknown }).headId
if (typeof rawHeadId !== 'string' || !rawHeadId.trim()) {
  res.status(400).json({ error: 'headId is required and must be a non-empty string' })
  return
}
const headId = rawHeadId
const heads = resolveCurrentHeads()
if (!heads.some(h => h.id === headId)) {
  res.status(404).json({ error: `head "${headId}" not found` })
  return
}
```

**POST kind validation + task-only guard pattern** (lines 80–99):
```typescript
const rawKind = (req.body as { kind?: unknown }).kind
if (rawKind !== undefined && rawKind !== 'task' && rawKind !== 'reminder') {
  res.status(400).json({ error: "kind must be 'task' or 'reminder'" })
  return
}
const kind: 'task' | 'reminder' = rawKind === 'reminder' ? 'reminder' : 'task'

if (kind === 'task') {
  if (typeof taskName !== 'string' || !taskName.trim()) {
    res.status(400).json({ error: 'taskName is required for task schedules' })
    return
  }
  // ...
}
```

**POST createOpts conditional assignment pattern** (lines 144–153):
```typescript
const createOpts: import('../../db/schedules.js').CreateScheduleOptions = { id: generateId('sched'), headId, kind }
if (kind === 'task' && typeof taskName === 'string') createOpts.taskName = taskName
if (typeof cron === 'string' && cron) createOpts.cron = cron
// ...
if (ackBool) createOpts.requiresAck = true
if (ackBool && nagNum > 0) createOpts.nagIntervalMinutes = nagNum
```

**PATCH headId-reassignment ban pattern** (lines 171–175):
```typescript
const bodyObj = (req.body !== null && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {}
if (bodyObj['headId'] !== undefined) {
  res.status(400).json({ error: 'headId cannot be reassigned via PATCH. To move a schedule to a different head, delete and recreate.' })
  return
}
```

**PATCH patch-object construction and fallback `scheduleStore.get(id)`** (lines 181–213):
```typescript
const patch: Parameters<typeof scheduleStore.update>[1] = {}
if (typeof enabled === 'boolean') patch.enabled = enabled
// ...
// existing scheduleStore.get(id) for timezone lookup:
const existingForTz = scheduleStore.get(id)
patch.nextRun = nextRunAfter(cron, new Date(), existingForTz?.cronTimezone ?? timezone).toISOString()
```

**New additions:**

POST — after the `kind` determination (line 85), add the `deliverToHeadIds` block (task-only, validate, dedupe):
```typescript
// Phase 44 D-08: deliverToHeadIds — task-only, validate, dedupe
let deliverToHeadIds: string[] | undefined
if (kind === 'task') {
  const rawDeliverTo = (req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds
  if (rawDeliverTo !== undefined) {
    if (!Array.isArray(rawDeliverTo)) {
      res.status(400).json({ error: 'deliverToHeadIds must be an array of head id strings' })
      return
    }
    const ids = rawDeliverTo as unknown[]
    if (!ids.every(id => typeof id === 'string' && (id as string).trim())) {
      res.status(400).json({ error: 'deliverToHeadIds must contain non-empty strings' })
      return
    }
    const currentHeads = resolveCurrentHeads()
    for (const hid of ids) {
      if (!currentHeads.some(h => h.id === hid)) {
        res.status(404).json({ error: `deliverToHeadIds: head "${hid as string}" not found` })
        return
      }
    }
    const deduped = [...new Set(ids as string[])]
    if (deduped.length > 0) deliverToHeadIds = deduped
  }
} else if ((req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds !== undefined) {
  // 400 on reminders — clearer than silently ignoring (D-08)
  res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
  return
}
```

Then in `createOpts` construction: `if (deliverToHeadIds !== undefined) createOpts.deliverToHeadIds = deliverToHeadIds`

PATCH — add after the ack/nag block. Note `bodyObj['deliverToHeadIds'] !== undefined` check (not key-presence) mirrors the existing D-13 `bodyObj['headId'] !== undefined` pattern:
```typescript
// Phase 44 D-08: delivery set is editable via PATCH (unlike headId, which is banned)
const rawDeliverTo = bodyObj['deliverToHeadIds']
if (rawDeliverTo !== undefined) {
  const existing = scheduleStore.get(id)
  if (!existing) { res.status(404).json({ error: 'Not found' }); return }
  if (existing.kind !== 'task') {
    res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
    return
  }
  if (!Array.isArray(rawDeliverTo) || !(rawDeliverTo as unknown[]).every(x => typeof x === 'string' && (x as string).trim())) {
    res.status(400).json({ error: 'deliverToHeadIds must be an array of non-empty head id strings' })
    return
  }
  const ids = rawDeliverTo as string[]
  const currentHeads = resolveCurrentHeads()
  for (const hid of ids) {
    if (!currentHeads.some(h => h.id === hid)) {
      res.status(404).json({ error: `deliverToHeadIds: head "${hid}" not found` })
      return
    }
  }
  patch.deliverToHeadIds = [...new Set(ids)]  // empty array = cleared (owner-only after store.update)
}
```

---

### `dashboard/src/types/api.ts` (model)

**Analog:** existing `Schedule.headId` field — same file (lines 252–269):
```typescript
export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder'
  // ...
  requiresAck: boolean
  nagIntervalMinutes: number | null
  ackPending: boolean
  createdAt: string
  updatedAt: string
}
```

**New field to add** (optional, tasks only, mirrors `src/db/schedules.ts` shape):
```typescript
/** Phase 44 — delivery set for task schedules. Absent = owner-only. */
deliverToHeadIds?: string[]
```

---

### `dashboard/src/pages/SchedulesPage.tsx` (component, request-response)

**Analog:** existing `HEAD_COLORS` + single chip render + `AddScheduleForm` head `<select>` — same file

**HEAD_COLORS palette + hash helpers** (lines 32–52):
```typescript
const HEAD_COLORS: Array<{ bg: string; border: string }> = [
  { bg: '#5865F20d', border: '#5865F2' },
  { bg: '#26A5E40d', border: '#26A5E4' },
  { bg: '#4A154B0d', border: '#4A154B' },
  { bg: '#25D3660d', border: '#25D366' },
  { bg: '#E423180d', border: '#E42318' },
]

function hashHeadId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

function headColor(id: string): string {
  return HEAD_COLORS[hashHeadId(id) % HEAD_COLORS.length]!.bg
}

function headColorBorder(id: string): string {
  return HEAD_COLORS[hashHeadId(id) % HEAD_COLORS.length]!.border
}
```

**Single chip render in `ScheduleRow`** (lines 161–168):
```tsx
<div className="w-24 shrink-0 text-xs">
  <span
    className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-full"
    style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}
    title={`Head: ${schedule.headId}`}
  >
    {schedule.headId}
  </span>
</div>
```

**Owner head `<select>` in `AddScheduleForm`** (lines 289, 354–365):
```typescript
const [headId, setHeadId] = useState<string>('')
// ...
<select
  value={headId}
  onChange={e => setHeadId(e.target.value)}
  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
  required
>
  {(headsQuery.data?.heads ?? []).length === 0
    ? <option disabled value="">No heads configured</option>
    : (headsQuery.data?.heads ?? []).map(h => (
        <option key={h.id} value={h.id}>{h.id}</option>
      ))}
</select>
```

**`createMutation` conditional spread pattern** (lines 323–336):
```typescript
return api.schedules.create({
  headId,
  taskName: target,
  kind: 'task',
  ...(type === 'repeating' ? { cron } : { runAt: new Date(runAt).toISOString() }),
  ...(conditions ? { conditions } : {}),
  ...(agentContext ? { agentContext } : {}),
  ...(type === 'repeating' && startAt ? { startAt: new Date(startAt).toISOString() } : {}),
})
```

**Edit modal `createPortal` pattern** (lines 202–269): modal opened by `setEditing(true)`, state seeded in `useEffect` before the portal renders. PATCH fields are built directly into `updateMutation.mutate(...)`.

**`localStorage 'active-head'` seed pattern** (lines 309–321):
```typescript
useEffect(() => {
  if (headId) return
  const heads = headsQuery.data?.heads ?? []
  if (heads.length === 0) return
  const stored = readActiveHeadFromStorage()
  if (stored && heads.some(h => h.id === stored)) {
    setHeadId(stored)
  } else {
    setHeadId(heads[0]!.id)
  }
}, [headsQuery.data, headId])
```

**New additions:**

`ScheduleRow` chip area — replace the single `w-24` div with flex-wrap, map over effective set (deduped). Keep `headColor`/`headColorBorder` helpers unchanged:
```tsx
<div className="min-w-24 shrink-0 text-xs flex flex-wrap gap-1">
  {[schedule.headId, ...(schedule.deliverToHeadIds ?? [])].filter((v, i, a) => a.indexOf(v) === i).map(hid => (
    <span key={hid}
      className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-full"
      style={{ backgroundColor: headColor(hid), borderLeft: `2px solid ${headColorBorder(hid)}` }}
      title={`Head: ${hid}`}
    >
      {hid}
    </span>
  ))}
</div>
```

`AddScheduleForm` — add state and a second multi-select below the "Head" single-select (two controls — owner vs delivery — is clearer than one combined control):
```typescript
const [deliverToHeadIds, setDeliverToHeadIds] = useState<string[]>([])
```

The "Also deliver to" control: a `<select multiple>` using the same `headsQuery.data?.heads` source, excluding the owner `headId` from selectable options (the owner is always included implicitly — D-03). Wire with `Array.from(e.target.selectedOptions, o => o.value)`.

In `createMutation`: add `...(deliverToHeadIds.length ? { deliverToHeadIds } : {})` to the `api.schedules.create(...)` call.

Edit modal in `ScheduleRow` — add a state var `editDeliverToHeadIds: string[]` (seeded from `schedule.deliverToHeadIds ?? []` when `setEditing(true)` is called) and a matching multi-select in the modal `<div className="space-y-3">` block. Include in `updateMutation.mutate(...)`.

---

### `tests/integration/multi-head-task-delivery.test.ts` (test, event-driven)

**Analog:** `tests/integration/multi-head-agent-lifecycle.test.ts` — full pattern

**Test file structure** (lines 1–161):
- Self-contained: no shared fixtures with other integration tests
- `freshDb()` — `:memory:` + `runMigrations(db, MIGRATIONS_DIR)` (lines 49–53)
- `makeLLMRouter(responses: LLMResponse[])` — sequential stub responses (lines 55–64)
- `makeEndTurnResponse(content)` — minimal end_turn LLM response (lines 74–83)
- `makeRunnerForHead(headId, db, llmRouter)` — full `LocalAgentRunner` construction with all stubs; returns `{ runner, agentStore, inboxStore, queueStore, usageStore }` (lines 111–161)
- `waitForQueueEvent(db, type, agentId, timeoutMs)` — polls `queue_events` via direct SQL (lines 163–179)
- `waitForStatus(agentStore, agentId, status, timeoutMs)` — polls `agentStore.get()` (lines 181–192)

**makeRunnerForHead construction** (lines 142–158):
```typescript
const runner = new LocalAgentRunner({
  headId,
  agentStore,
  inboxStore,
  queueStore,
  usageStore,
  skillLoader,
  skillsDir: '/tmp',
  workspacePath: null,
  mcpRegistry,
  identityLoader,
  agentIdentityLoader,
  llmRouter,
  pollIntervalMs: 50,
  checkStatusTimeoutMs: 500,
  timezone: 'UTC',
})
```

**Test 2 — queue stamping pattern** (lines 226–258):
```typescript
it('completeAgent enqueues agent_completed with head_id matching the runner headId ...', async () => {
  const llmRouter = makeLLMRouter([
    makeToolCallResponse('bash', { description: 'noop', command: 'echo done' }),
    makeEndTurnResponse('All done.'),
    { content: '{"type": "done"}', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
  ])
  const { runner } = makeRunnerForHead('work', db, llmRouter)
  const agentId = await runner.spawn({ prompt: 'finish quickly', name: 'quick', trigger: 'manual', headId: 'work' })
  await runner.awaitAll(3000)

  const row = await waitForQueueEvent(db, 'agent_completed', agentId, 3000)
  expect(row).toBeDefined()
  expect(row?.head_id).toBe('work')

  const literalRow = db.prepare(
    "SELECT head_id FROM queue_events WHERE type = 'agent_completed' AND payload LIKE ? LIMIT 1",
  ).get(`%${agentId}%`) as { head_id: string } | undefined
  expect(literalRow?.head_id).toBe('work')
})
```

**New file — five test cases to implement:**

1. **Fan-out**: `runner.spawn({ headId: 'a', deliverToHeadIds: ['b'], trigger: 'scheduled', ... })` — assert two `agent_completed` queue_events (one `head_id='a'`, one `head_id='b'`), same `agentId`, one agents row.

2. **Dedup**: owner in both `headId` and `deliverToHeadIds` → only one `agent_completed` event for the owner (total: one event, not two).

3. **No delivery set regression**: `deliverToHeadIds` absent → single event (byte-equivalent to pre-Phase-44 behavior).

4. **Question-suppression** (D-06): spawn with `trigger: 'scheduled'`, LLM stub returns a completion-steward response classifying output as `question` — assert agent reaches `status: 'completed'`, not `'suspended'`.

5. **`agent_failed` owner-only** (D-05): failing agent with `deliverToHeadIds: ['b']` → exactly one `agent_failed` event, `head_id='a'` (owner), no event for `head_id='b'`.

For the multi-event tests, use `waitForQueueEvent` twice with different `head_id` assertions. Verify single agents row with `db.prepare('SELECT COUNT(*) AS n FROM agents WHERE ...').get(agentId)`.

**Steward stub pattern for question-suppression test** — use `makeStewardQuestionResponse` (lines 97–106 in the analog):
```typescript
function makeStewardQuestionResponse(question: string): LLMResponse {
  return {
    content: JSON.stringify({ type: 'question', question }),
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}
```

The `makeRunnerForHead` function can be copied verbatim from the analog — it does not need modification since `LocalAgentRunner` now accepts `deliverToHeadIds` via `SpawnOptions`.

---

## Shared Patterns

### exactOptionalPropertyTypes compliance
**Source:** throughout `src/db/schedules.ts`, `src/sub-agents/local.ts`, `src/head/activation.ts`
**Apply to:** All files that construct objects containing `deliverToHeadIds`

The pattern: never assign `undefined` to an optional field. Use conditional spread when constructing, `delete obj.field` when clearing.
```typescript
// Constructing — correct:
...(arr.length ? { deliverToHeadIds: arr } : {})
// Clearing — correct:
delete existing.deliverToHeadIds
// Wrong (TS2322 under exactOptionalPropertyTypes):
existing.deliverToHeadIds = undefined
```

### noUncheckedIndexedAccess compliance
**Source:** `src/db/agents.ts` `rowToState` iteration patterns
**Apply to:** `src/sub-agents/local.ts` fan-out loop, any iteration over `deliverToHeadIds`

Use `for...of` or spread (both avoid index-typed `T | undefined`). The `[...new Set([headId, ...(options.deliverToHeadIds ?? [])])]` spread pattern is safe — spread does not introduce `T | undefined` items.
```typescript
// Correct — for...of:
for (const targetHeadId of deliverySet) { ... }
// Correct — spread dedup:
const deliverySet = [...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]
// Wrong — index access:
deliverySet[i]  // typed string | undefined
```

### JSON column serialization/deserialization
**Source:** `src/db/agents.ts` `tools`/`capabilities` columns + `rowToState`
**Apply to:** `src/db/agents.ts` `deliver_to_head_ids` column

```typescript
// Serialize (create):
deliver_to_head_ids: JSON.stringify(options.deliverToHeadIds ?? [])
// Deserialize (rowToState):
deliverToHeadIds: JSON.parse(row.deliver_to_head_ids) as string[]
```

### Admin-404 validation stance
**Source:** `src/dashboard/routes/schedules.ts` lines 31–41 (POST headId check)
**Apply to:** `deliverToHeadIds` validation in POST and PATCH handlers

Use `resolveCurrentHeads()` (already injected), check each id with `.some(h => h.id === hid)`, return 404 on unknown head. No silent fallback.

### `!== undefined` guard (not key-presence) for PATCH body checks
**Source:** `src/dashboard/routes/schedules.ts` line 172 (D-13 headId guard comment)
**Apply to:** `deliverToHeadIds` PATCH guard

```typescript
if (bodyObj['deliverToHeadIds'] !== undefined) { ... }
// NOT: if ('deliverToHeadIds' in bodyObj) { ... }
```
The comment at line 166–170 documents why: `JSON.stringify` drops `undefined` props, so in-process callers with `{ deliverToHeadIds: undefined }` should not accidentally trigger the guard.

---

## No Analog Found

None. All 10 files have exact analogs within the same codebase (most within the same file).

---

## Metadata

**Analog search scope:** `sql/`, `src/db/`, `src/types/`, `src/sub-agents/`, `src/head/`, `src/dashboard/routes/`, `dashboard/src/types/`, `dashboard/src/pages/`, `tests/integration/`
**Files read:** 11 (sql/007, src/db/agents.ts, src/types/agent.ts, src/db/schedules.ts, src/sub-agents/local.ts lines 375–1044, src/head/activation.ts lines 1270–1300, src/dashboard/routes/schedules.ts, dashboard/src/types/api.ts, dashboard/src/pages/SchedulesPage.tsx lines 30–470, tests/integration/multi-head-agent-lifecycle.test.ts lines 1–270)
**Pattern extraction date:** 2026-05-24
