# Phase 44: Multi-Head Task Delivery — Research

**Researched:** 2026-05-24
**Domain:** TypeScript/Node.js — agent lifecycle fan-out, SQLite agents table, JSON file-store schedules, Express route validation, React dashboard form
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01** Tasks only; reminders are completely untouched (kind:'task' schedules only)
- **D-02** Additive optional field `deliverToHeadIds`; absent/empty = today's exact single-head behavior
- **D-03** Owner head spawns; effective delivery set = `dedupe([headId, ...deliverToHeadIds])`
- **D-04** Single fan-out point is `completeAgent` (~line 983-989 in local.ts); delivery set persisted on agent record (survives schedule-row deletion)
- **D-05** `agent_failed` to owner head only
- **D-06** Scheduled agents never suspend-as-question; gate on `options.trigger`
- **D-07** Agent-side `create_schedule` stays single-head (deferred)
- **D-08** API: `deliverToHeadIds` accepted only for `kind:'task'`; validate each id; editable via PATCH; empty = absent
- **D-09** Dashboard: multi-select on task form; multi-chip on task rows; reminder form unchanged

### Claude's Discretion

- Exact field name (research confirms `deliverToHeadIds` is correct)
- Agent-record persistence shape (see Q1 below — JSON column recommended)
- Precise trigger predicate for D-06
- UI affordance for picking owner + delivery heads
- Whether D-05 owner-only is enforced or already implicit

### Deferred Ideas (OUT OF SCOPE)

- Agent-side `create_schedule` delivery set (D-07)
- Multi-head reminders
- Ack-required reminders across heads
- Owner-head reassignment via PATCH
</user_constraints>

---

## Summary

Phase 44 adds a `deliverToHeadIds` field to task schedules so a single agent run delivers its completion event to multiple heads. The codebase already has clean patterns for every piece of this from Phases 34 and 35: a required `headId` column on `agents`, a `migrateLegacySchedule` funnel in `schedules.ts`, the admin-404 stance in `routes/schedules.ts`, and the `HEAD_COLORS` chip render in `SchedulesPage.tsx`. Every question in the objective can be answered by direct extrapolation of those patterns.

The work splits into four natural layers: (1) data model — `Schedule`/`CreateScheduleOptions`/`SchedulePatch` and a new `deliver_to_head_ids` column on the agents table; (2) spawn/complete path — thread `SpawnOptions.deliverToHeadIds` through `AgentState`, `AgentStore.create`, `resumeSuspended`, and the `completeAgent` fan-out; (3) question gate — one early-return guard in `suspendAsQuestion` when `options.trigger === 'scheduled'`; (4) API and dashboard. All of these are small, focused, testable edits.

**Primary recommendation:** Model the agent-side delivery set as a JSON TEXT column `deliver_to_head_ids` on the agents table (same pattern as `head_id` in sql/007). Treat it as non-nullable with a `DEFAULT '[]'` SQL fallback for defense-in-depth, and serialize/deserialize with `JSON.parse`/`JSON.stringify`. This is the minimal-surprise extension of the Phase 34 pattern and is already how `tools`/`capabilities` are stored on the agents row.

[VERIFIED: codebase grep + direct file reads]

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Delivery set storage (schedule) | File-store (JSON) | — | Schedules are JSON files in `{workspacePath}/data/schedules/`; no SQLite |
| Delivery set storage (agent) | SQLite agents table | — | Agent state persists across resume/restart; must survive schedule-row deletion |
| Fan-out at completion | `src/sub-agents/local.ts` (runner) | — | `completeAgent` is the single enqueue site for top-level agents |
| Question suppression | `src/sub-agents/local.ts` (runner) | — | `suspendAsQuestion` is the single question-enqueue site |
| Delivery set pass-through at spawn | `src/head/activation.ts` | — | `handleScheduleTrigger` reads the schedule and builds `SpawnOptions` |
| API validation | `src/dashboard/routes/schedules.ts` | — | POST/PATCH handler already owns head-id validation |
| Dashboard multi-select | `dashboard/src/pages/SchedulesPage.tsx` | — | `AddScheduleForm` owns the task form; `ScheduleRow` owns the chip render |

---

## Q1 — Agent-Record Persistence Shape for the Delivery Set

**Recommendation: new JSON TEXT column `deliver_to_head_ids` on the agents table.**

**Migration file:** `sql/008_agents_deliver_to_head_ids.sql` (next sequential number after 007).

**DDL:**
```sql
-- sql/008_agents_deliver_to_head_ids.sql
-- Phase 44: Persist the delivery set on the agents row.
-- An absent/pre-Phase-44 agents row defaults to '[]' (empty set = owner-only,
-- today's behavior). Mirrors sql/007_agents_head_id.sql pattern exactly.
ALTER TABLE agents ADD COLUMN deliver_to_head_ids TEXT NOT NULL DEFAULT '[]';
```

**Why JSON column over derived/serialized field:**
- `tools` and `capabilities` on the agents row are already stored as JSON TEXT with `JSON.stringify([])` and `JSON.parse()` — this is the established pattern for array data in the agents table.
- The `DEFAULT '[]'` covers all existing rows and any future direct-SQL inserts (defense-in-depth), exactly as `DEFAULT 'default'` covered `head_id`.
- Avoids creating a separate junction table (over-engineered for a small, bounded array).

**AgentStore serialization — `create`:**

In `AgentStore`, the `stmtCreate` prepared statement (`INSERT INTO agents`) already binds `@head_id` from `options.headId`. Add `@deliver_to_head_ids` to the INSERT:

```typescript
// In stmtCreate SQL:
// INSERT INTO agents (... head_id, deliver_to_head_ids, ...) VALUES (... @head_id, @deliver_to_head_ids, ...)

// In create():
this.stmtCreate.run({
  // ...existing fields...
  head_id: options.headId,
  deliver_to_head_ids: JSON.stringify(options.deliverToHeadIds ?? []),
})
```

**AgentStore deserialization — `rowToState` / `AgentRow`:**

Add to `AgentRow`:
```typescript
interface AgentRow {
  // ...existing fields...
  deliver_to_head_ids: string  // JSON-encoded string[]
}
```

Add to `rowToState`:
```typescript
function rowToState(row: AgentRow, history: Message[]): AgentState {
  return {
    // ...existing fields...
    deliverToHeadIds: JSON.parse(row.deliver_to_head_ids) as string[],
  }
}
```

Note: `noUncheckedIndexedAccess` applies to array index access in the deserialized value at call sites — callers must handle `arr[i]` returning `string | undefined`. This is handled naturally in the `for...of` loop in `completeAgent`.

[VERIFIED: direct read of src/db/agents.ts, sql/007_agents_head_id.sql, and the tools/capabilities JSON pattern]

---

## Q2 — Threading Through SpawnOptions → AgentState → Completion

### types/agent.ts additions

Following Phase 34 D-SPAWN-REQUIRED (required field, no silent default):

```typescript
// In AgentState:
/** Delivery set for fan-out at completion. Only present on top-level scheduled agents.
 *  Phase 44: absent (= []) means owner-only delivery — today's exact behavior. */
deliverToHeadIds: string[]

// In SpawnOptions:
/** Optional delivery set (Phase 44). Only meaningful for top-level scheduled agents.
 *  Sub-agents and manual spawns leave this absent (= []). */
deliverToHeadIds?: string[]
```

The field is OPTIONAL on `SpawnOptions` (not required like `headId`) because:
- Sub-agents spawned via `handleSpawnAgent` in `local.ts` never have a delivery set — they inherit only `headId`.
- Manual spawns from the dashboard or agent `spawn_agent` tool do not use a delivery set (D-07).
- Making it optional avoids touching all ~82 call sites that Phase 34 had to update for the required `headId`.

The field is required (non-optional) on `AgentState` because it must always be serializable — `rowToState` always produces a value (an empty array when the column is `'[]'`), so the field is always present after deserialization.

### handleScheduleTrigger (activation.ts ~line 1282)

Current code:
```typescript
await this.opts.toolExecutorOpts.agentRunner.spawn({
  agentId,
  prompt,
  trigger: 'scheduled',
  headId: this.opts.headId,
  skillName: taskName!,
  ...(scheduledModel ? { model: scheduledModel } : {}),
})
```

Add:
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

The spread-with-length-guard honors `exactOptionalPropertyTypes` — when absent, the key is omitted from `SpawnOptions` entirely (not set to `undefined`).

### resumeSuspended (local.ts ~line 394)

Current code reconstructs `SpawnOptions` from `state`:
```typescript
const options: SpawnOptions = {
  prompt: state.task,
  model: state.model,
  trigger: state.trigger,
  headId: state.headId,
  // ...
}
```

Add, mirroring D-RESUME-VS-SUBSPAWN (use `state.deliverToHeadIds`, not `this.headId`):
```typescript
const options: SpawnOptions = {
  prompt: state.task,
  model: state.model,
  trigger: state.trigger,
  headId: state.headId,
  ...(state.deliverToHeadIds.length ? { deliverToHeadIds: state.deliverToHeadIds } : {}),
  // ...
}
```

Sub-agents (with `parentAgentId`) are spawned via `handleSpawnAgent` where `childOptions` is built inline — that path never sets `deliverToHeadIds` (correctly). No change needed there.

[VERIFIED: direct reads of src/sub-agents/local.ts lines 394-404, 1163-1170, src/head/activation.ts lines 1282-1289]

---

## Q3 — The completeAgent Fan-Out

### The primary fan-out site (~line 983-989)

```typescript
private completeAgent(
  agentId: string,
  output: string,
  options: SpawnOptions,
  history: Message[],
): void {
  this.agentStore.complete(agentId, output)
  if (options.parentAgentId) {
    // Sub-agent path — unchanged
    this.inboxStore.write(options.parentAgentId, 'sub_agent_completed', ...)
    this.emitters.get(options.parentAgentId)?.emit('inbox')
  } else {
    // Top-level path — FAN OUT HERE
    this.queueStore.enqueue({...}, PRIORITY.AGENT_COMPLETED, this.headId)
  }
}
```

Change the top-level `else` branch:

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

When `deliverToHeadIds` is absent or empty, `deliverySet = [this.headId]` — exactly one enqueue, byte-equivalent to today's behavior. The `Set` deduplicates in case the owner is also listed in `deliverToHeadIds`.

### The second agent_completed site (~line 1027-1033)

This is the `AgentContext.complete` callback inside `buildAgentExecutor`. The context is created at line 1022 and passed to tool executors. This path is triggered when a tool explicitly calls `ctx.complete(output)` rather than the agent reaching end-of-turn.

This is an **early-exit path for special tools** — the same `options` object (including `deliverToHeadIds`) is in scope at `buildAgentExecutor`. It is a top-level completion path and **must also fan out**:

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

The `options` variable is already captured by the closure at line 1011 (`buildAgentExecutor`'s parameter), so no plumbing is needed. Both completion sites need the identical fan-out change.

### Does agent_failed need fan-out?

No. D-05 states `agent_failed` goes to the owner head only. Looking at the code:
- `agent_failed` is enqueued at the catch-level error handler in `runLoopFrom` and at `makeThrowingLLMRouter`-triggered paths. These all use `this.headId` directly. No change needed — this is already correct behavior.
- The `ctx.fail` path in `buildAgentExecutor` throws, which propagates up to the `runLoopFrom` catch block, which uses `this.headId`. Owner-only is structurally implicit and remains so.

[VERIFIED: direct reads of src/sub-agents/local.ts lines 971-1038]

---

## Q4 — The suspendAsQuestion Trigger Gate (D-06)

### Trigger values in the codebase

From `src/types/agent.ts`:
```typescript
trigger: 'manual' | 'scheduled' | 'ad_hoc'
```

From `src/sub-agents/agents.test.ts` comment at line 824: "proactive agents are spawned via src/head/activation.ts with `trigger: 'scheduled'`" — confirmed: there is no `'proactive'` trigger value in the type. Proactive runs are scheduled runs with `trigger: 'scheduled'`.

So the trigger union is exactly three values. Only `'manual'` has a human attached; `'scheduled'` and `'ad_hoc'` do not.

### Recommended predicate

Gate on `options.trigger !== 'manual'` — i.e., suppress question-suspension for both `'scheduled'` and `'ad_hoc'`. Rationale:

- `'ad_hoc'` is used when sub-agents spawn child agents via `handleSpawnAgent` (`trigger: 'ad_hoc'` at line 1166). However, those children have `parentAgentId` set, so they hit the sub-agent branch of `suspendAsQuestion` (which routes to the parent's inbox), not the outer `agent_question` enqueue. The guard below will only be reached for top-level `'ad_hoc'` agents. There is no human attached to a top-level `'ad_hoc'` spawn either.
- Alternatively, gate exclusively on `trigger === 'scheduled'` to be narrowest and avoid any unintended behavior change for ad-hoc top-level spawns. This is the safer minimum.

**Recommendation: use `options.trigger === 'scheduled'` as the initial guard** — it precisely matches the phase scope (D-06 says "at minimum `trigger === 'scheduled'`") and is the most conservative change. The context also notes that sub-agent question routing to its parent is unchanged regardless.

### Where to put the guard

Inside `suspendAsQuestion`, at the top, before the `agentStore.suspend` call. This is cleaner than at the call site (which would require duplicating the check at every `suspendAsQuestion` callsite). Current `suspendAsQuestion` takes `options: SpawnOptions` as a parameter, so `options.trigger` is available:

```typescript
private suspendAsQuestion(
  agentId: string, question: string, options: SpawnOptions, history: Message[],
): void {
  // D-06: scheduled agents have no human attached — force completion instead of suspension.
  if (options.trigger === 'scheduled') {
    this.completeAgent(agentId, question, options, history)
    return
  }
  this.agentStore.suspend(agentId, question)
  // ... rest unchanged
}
```

Note: `completeAgent` is called with `question` as the output (the agent's last text is already the question; treat it as a completed output since we're forcing completion). This matches the intent: the scheduled agent's output goes to all delivery heads even if the steward wanted to ask a question.

[VERIFIED: direct reads of src/sub-agents/local.ts lines 993-1007, src/types/agent.ts line 43, src/sub-agents/agents.test.ts line 824]

---

## Q5 — schedules.ts Data Model and Migration

### Schedule interface addition

```typescript
export interface Schedule {
  // ...existing fields...
  /** Additional heads to deliver task completion to (Phase 44).
   *  Only meaningful for kind:'task'. Absent on reminders and legacy rows.
   *  Effective delivery set is dedupe([headId, ...deliverToHeadIds]). */
  deliverToHeadIds?: string[]
}
```

The field is typed as `deliverToHeadIds?: string[]` (optional, not `string[] | undefined`) to satisfy `exactOptionalPropertyTypes` — the key may be absent from the object. It is only meaningful on `kind:'task'` schedules; reminder rows will simply not have the key.

### CreateScheduleOptions addition

```typescript
export interface CreateScheduleOptions {
  // ...existing fields...
  deliverToHeadIds?: string[]
}
```

### SchedulePatch addition

```typescript
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' |
  'agentContext' | 'cronTimezone' | 'ackPending' | 'requiresAck' | 'nagIntervalMinutes' |
  'deliverToHeadIds'  // Phase 44 — editable via PATCH (D-08)
>>
```

Note: `headId` is not in `SchedulePatch` (the existing D-13 ban). `deliverToHeadIds` IS in `SchedulePatch` because D-08 explicitly allows editing the delivery set.

### ScheduleStore.create and update

In `create()`:
```typescript
const schedule: Schedule = {
  // ...existing fields...
  ...(options.deliverToHeadIds?.length ? { deliverToHeadIds: options.deliverToHeadIds } : {}),
}
```

The spread-with-length-guard omits the key entirely when the array is absent or empty — `exactOptionalPropertyTypes` compliance.

In `update()`:
```typescript
if (patch.deliverToHeadIds !== undefined) existing.deliverToHeadIds = patch.deliverToHeadIds.length ? patch.deliverToHeadIds : undefined
// then delete the key if empty, per exactOptionalPropertyTypes:
if (existing.deliverToHeadIds !== undefined && existing.deliverToHeadIds.length === 0) {
  delete existing.deliverToHeadIds
}
```

Alternatively, use the same spread pattern as create: `existing.deliverToHeadIds = patch.deliverToHeadIds?.length ? patch.deliverToHeadIds : undefined` — but `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional property. The correct form is `delete existing.deliverToHeadIds` when the value should be absent.

### migrateLegacySchedule — idempotent extension

Extend using the established `'field' in obj` guard:

```typescript
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  // ...existing guards...
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  // Phase 44: deliverToHeadIds is intentionally NOT backfilled on legacy rows.
  // Absent key = owner-only behavior (D-02). No migration needed.
  return { migrated, data: obj as unknown as Schedule }
}
```

No new guard needed in `migrateLegacySchedule` for `deliverToHeadIds` — absent key on a legacy row is the correct, intentional behavior (D-02: absent = today's single-head behavior). Adding a guard would convert absent to `[]`, which is semantically identical at runtime but would (a) mark the file as migrated and update its mtime for no gain, and (b) add noise to task rows that don't use multi-head delivery. Leave it absent on legacy rows.

### noUncheckedIndexedAccess for the array

When iterating `deliverToHeadIds` in the completion fan-out, use `for...of` (not index access). The `[...new Set([headId, ...(options.deliverToHeadIds ?? [])])]` spread is safe — spread of an array does not produce `T | undefined` items.

[VERIFIED: direct reads of src/db/schedules.ts lines 1-225]

---

## Q6 — API Validation (routes/schedules.ts)

### POST handler additions

After the existing `kind` determination (line 85), add:

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
    if (!ids.every(id => typeof id === 'string' && id.trim())) {
      res.status(400).json({ error: 'deliverToHeadIds must contain non-empty strings' })
      return
    }
    // Validate each id is a known head (D-08 / D-11 admin-404 stance)
    const currentHeads = resolveCurrentHeads()
    for (const id of ids) {
      if (!currentHeads.some(h => h.id === id)) {
        res.status(404).json({ error: `deliverToHeadIds: head "${id}" not found` })
        return
      }
    }
    // Dedupe; empty after dedup = absent (D-08)
    const deduped = [...new Set(ids as string[])]
    if (deduped.length > 0) deliverToHeadIds = deduped
  }
} else if ((req.body as { deliverToHeadIds?: unknown }).deliverToHeadIds !== undefined) {
  // Reject on reminders — clearer than silently ignoring (D-08 "400 on reminders is fine")
  res.status(400).json({ error: 'deliverToHeadIds is only valid for task schedules' })
  return
}
```

Then in the `createOpts` construction:
```typescript
if (deliverToHeadIds !== undefined) createOpts.deliverToHeadIds = deliverToHeadIds
```

### PATCH handler — headId reassignment guard vs delivery set edit reconciliation

The existing D-13 guard at line 172 checks `bodyObj['headId'] !== undefined` and rejects. The delivery set field `deliverToHeadIds` is a different key — it does NOT trigger this guard. The PATCH handler continues naturally to build the `patch` object and call `scheduleStore.update(id, patch)`.

Add handling after the existing ack/nag block:

```typescript
// Phase 44 D-08: deliverToHeadIds is editable via PATCH (unlike headId, which is banned)
const rawDeliverTo = bodyObj['deliverToHeadIds']
if (rawDeliverTo !== undefined) {
  // Fetch the existing schedule to check its kind
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
  const deduped = [...new Set(ids)]
  patch.deliverToHeadIds = deduped  // empty array = cleared (owner-only)
}
```

Note: An empty array in a PATCH clears the delivery set (reverting to single-head). This is the correct behavior — "set deliverToHeadIds to []" means "stop delivering to extra heads." The `scheduleStore.update` handler then uses `delete existing.deliverToHeadIds` when the patch value is empty, keeping the JSON file clean.

The `scheduleStore.get(id)` call to check kind may be a second read if PATCH handler already read it earlier (for the ack-off path). This is acceptable — the existing PATCH handler already calls `scheduleStore.get(id)` conditionally in multiple places. The alternative is to hoist a single `existingSchedule` read to the top of the PATCH handler, which is a reasonable cleanup the planner may choose.

[VERIFIED: direct read of src/dashboard/routes/schedules.ts lines 161-299]

---

## Q7 — Dashboard

### dashboard/src/types/api.ts — Schedule type

Add to the `Schedule` interface:
```typescript
export interface Schedule {
  // ...existing fields...
  /** Phase 44 — delivery set for task schedules. Absent = owner-only. */
  deliverToHeadIds?: string[]
}
```

### SchedulesPage.tsx — AddScheduleForm

Add state:
```typescript
const [deliverToHeadIds, setDeliverToHeadIds] = useState<string[]>([])
```

Add a multi-select control after the existing "Head" single-select (which becomes the owner). Suggested affordance: keep the existing "Head" single-select as the owner, add a second "Also deliver to" multi-select below it (checkboxes or a `<select multiple>`). Two controls is clearer than one combined multi-select because ownership and delivery are semantically different.

In `createMutation.mutationFn`:
```typescript
return api.schedules.create({
  headId,
  taskName: target,
  kind: 'task',
  ...(deliverToHeadIds.length ? { deliverToHeadIds } : {}),
  // ...existing fields...
})
```

### SchedulesPage.tsx — ScheduleRow chips

Current render of the single head chip (lines 162-168):
```tsx
<span style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}>
  {schedule.headId}
</span>
```

Replace the `<div className="w-24 shrink-0 text-xs">` with a flex-wrap container and map over the effective set:

```tsx
<div className="shrink-0 text-xs flex flex-wrap gap-1">
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

Note: the width class `w-24` should be removed or increased to accommodate multiple chips. Use `min-w-24` with flex-wrap.

### SchedulesPage.tsx — ScheduleRow edit modal

The existing edit modal (lines 202-270) for task rows handles `cron`, `runAt`, `conditions`, and `agentContext`. Extend it to include a "Deliver to" multi-select. Add state mirroring the add-form pattern, and include `deliverToHeadIds` in the `updateMutation.mutate(...)` call.

The reminder form (`AddReminderForm` and `ReminderRow`) is unchanged per D-01/D-09.

[VERIFIED: direct reads of dashboard/src/pages/SchedulesPage.tsx and dashboard/src/types/api.ts]

---

## Q8 — Test Analogs and Locations

### Existing test files to extend

| File | What to extend |
|------|---------------|
| `src/db/schedules.test.ts` | Add tests: `deliverToHeadIds` persists on disk, absent on legacy rows, round-trips through `get()`, PATCH clears to absent, `migrateLegacySchedule` leaves it absent |
| `src/dashboard/routes/schedules.test.ts` | Add tests: POST task with `deliverToHeadIds` creates; POST reminder with `deliverToHeadIds` returns 400; PATCH adds/removes delivery heads; unknown head id → 404 |
| `tests/integration/multi-head-agent-lifecycle.test.ts` | **Primary fan-out regression test analog** — add a new `describe` block (or extend the existing Phase 34 describe) that verifies: spawning an agent with `deliverToHeadIds:['b']` and headId:'a' produces TWO `agent_completed` queue_events, one with `head_id='a'` and one with `head_id='b'` |
| `src/sub-agents/agents.test.ts` | Add tests: question-classified output on `trigger:'scheduled'` reaches `completeAgent` instead of `suspendAsQuestion` (observable as `status:'completed'` vs `'suspended'`) |

### The closest existing test for fan-out assertion

`tests/integration/multi-head-agent-lifecycle.test.ts` Test 2 (`Queue stamping — agent_completed`) at line ~230 is the canonical analog. It uses `makeRunnerForHead`, spawns an agent, and checks `queue_events.head_id` via `waitForQueueEvent`. The Phase 44 fan-out test should:
1. Spawn via `runner.spawn({ headId: 'a', deliverToHeadIds: ['b'], trigger: 'scheduled', ... })`
2. Wait for two `agent_completed` events: one for `head_id='a'`, one for `head_id='b'`
3. Assert the `agentId` is the same in both
4. Assert only ONE agents row was created (the work ran once)

### Self-contained regression test (D-SELF-CONTAINED-REGRESSION-TEST analog)

Create `tests/integration/multi-head-task-delivery.test.ts` using the same `makeRunnerForHead` pattern. Pin:
1. Fan-out: one agent, two `agent_completed` events (one per delivery head)
2. Dedup: owner in both `headId` and `deliverToHeadIds` produces only one event for owner
3. No delivery set: `deliverToHeadIds` absent → single event (byte-equivalent to today)
4. Question-suppression: `trigger:'scheduled'` + steward returning `question` → agent reaches `completed` status, not `suspended`
5. `agent_failed` owner-only: failure enqueues only to `head_id='a'` even when `deliverToHeadIds: ['b']`

[VERIFIED: direct reads of tests/integration/multi-head-agent-lifecycle.test.ts and src/sub-agents/agents.test.ts]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Array deduplication | Custom dedup logic | `[...new Set([...])]` — already used throughout the codebase |
| Head id validation | Custom lookup | `resolveCurrentHeads()` — already injected into `createSchedulesRouter` |
| JSON serialization | Custom encoding | `JSON.stringify` / `JSON.parse` — established agents-table pattern for `tools`/`capabilities` |
| Migration idempotency | Custom guard | `'field' in obj` guard — established `migrateLegacySchedule` pattern |

---

## Common Pitfalls

### Pitfall 1: exactOptionalPropertyTypes — assigning undefined to optional field
**What goes wrong:** TypeScript errors `TS2322: Type 'undefined' is not assignable to type 'string[]'` when setting `existing.deliverToHeadIds = undefined` or `options.deliverToHeadIds = undefined`.
**Why it happens:** `exactOptionalPropertyTypes` is enabled — optional fields may be absent but cannot be explicitly set to `undefined`.
**How to avoid:** Use `delete existing.deliverToHeadIds` to clear the field; use conditional spread `...(arr.length ? { deliverToHeadIds: arr } : {})` when constructing objects.

### Pitfall 2: noUncheckedIndexedAccess on deserialized array
**What goes wrong:** `deliverToHeadIds[i]` is typed `string | undefined`, causing TS errors when passed to places that require `string`.
**How to avoid:** Use `for...of` for iteration. The `[...new Set([headId, ...(deliverToHeadIds ?? [])])]` spread pattern avoids index access entirely.

### Pitfall 3: Fan-out in buildAgentExecutor closure too — missing the second site
**What goes wrong:** Only `completeAgent` is updated. The `ctx.complete` callback inside `buildAgentExecutor` (~line 1025-1034) still uses a single `this.headId`. Tools that call `ctx.complete()` directly (bypassing `completeAgent`) deliver to only the owner head.
**How to avoid:** Update both sites. They share the same `options: SpawnOptions` in scope (parameter of `buildAgentExecutor`).

### Pitfall 4: Schedule JSON file format — setting deliverToHeadIds to [] vs absent
**What goes wrong:** `store.update(id, { deliverToHeadIds: [] })` calls `scheduleStore.update`, which does `if (patch.deliverToHeadIds !== undefined) existing.deliverToHeadIds = []`. The JSON file now has `"deliverToHeadIds": []` instead of the key being absent. This is semantically equivalent but adds noise.
**How to avoid:** In `ScheduleStore.update`, when `patch.deliverToHeadIds` is set and empty, use `delete existing.deliverToHeadIds` rather than `existing.deliverToHeadIds = []`.

### Pitfall 5: PATCH guard — checking for key presence triggers on explicit undefined
**What goes wrong:** The existing PATCH headId guard `bodyObj['headId'] !== undefined` would fire if a TypeScript caller constructs `{ headId: undefined }`. The comment in the existing code documents this as intentional (JSON.stringify drops undefined, only real reassignment attempts should 400). The same logic applies to `deliverToHeadIds` in the PATCH handler — check `rawDeliverTo !== undefined` (which JSON.stringify-undefined callers won't trigger) rather than `'deliverToHeadIds' in bodyObj`.
**How to avoid:** Mirror the existing pattern exactly — check `!== undefined` not key presence.

---

## Validation Architecture

Nyquist validation enabled (`workflow.nyquist_validation` absent from config.json = enabled).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | vitest.config.ts (existing) |
| Quick run command | `npx vitest run src/db/schedules.test.ts src/dashboard/routes/schedules.test.ts src/sub-agents/agents.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Behavior | Test Type | Automated Command | File Exists? |
|----------|-----------|-------------------|-------------|
| `deliverToHeadIds` persists in schedule JSON, round-trips through `get()` | unit | `npx vitest run src/db/schedules.test.ts` | Extend existing |
| Absent `deliverToHeadIds` on legacy row — migrateLegacySchedule leaves it absent | unit | `npx vitest run src/db/schedules.test.ts` | Extend existing |
| POST task with valid `deliverToHeadIds` → schedule created with field | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | Extend existing |
| POST reminder with `deliverToHeadIds` → 400 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | Extend existing |
| POST task with unknown head in `deliverToHeadIds` → 404 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | Extend existing |
| PATCH task `deliverToHeadIds` — add, remove, clear | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | Extend existing |
| Fan-out: one agent + `deliverToHeadIds:['b']` → two `agent_completed` queue events (same agentId) | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | Create new |
| Dedup: owner in both headId and deliverToHeadIds → one event, not two | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | Create new |
| No delivery set: `deliverToHeadIds` absent → single event (regression) | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | Create new |
| Question-suppression: `trigger:'scheduled'` + steward returns `question` → `completed`, not `suspended` | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | Create new |
| `agent_failed` owner-only: failure with `deliverToHeadIds:['b']` → one event, `head_id='a'` | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | Create new |
| `deliver_to_head_ids` SQL column exists on agents table, DEFAULT '[]' | db unit | `npx vitest run src/db/db.test.ts` | Extend existing |

### Sampling Rate
- **Per task commit:** quick run (3 files above)
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/integration/multi-head-task-delivery.test.ts` — new file, covers fan-out + question-suppression + agent_failed owner-only
- [ ] `sql/008_agents_deliver_to_head_ids.sql` — new migration file (no test file, but `src/db/db.test.ts` can verify column exists after migration)

---

## Architecture Patterns

### Recommended Wave Structure

```
Wave 1: Data model (types + schedules.ts + SQL migration + agents.ts)
  - sql/008_agents_deliver_to_head_ids.sql
  - src/types/agent.ts  (SpawnOptions.deliverToHeadIds?, AgentState.deliverToHeadIds)
  - src/db/schedules.ts (Schedule, CreateScheduleOptions, SchedulePatch, update())
  - src/db/agents.ts    (AgentRow, rowToState, stmtCreate, create())
  [tsc should be GREEN after this wave — field is optional on SpawnOptions,
   so no callers break; AgentState field always present from rowToState]

Wave 2: Spawn/run/complete path (local.ts + activation.ts)
  - src/sub-agents/local.ts  (completeAgent fan-out ×2, suspendAsQuestion gate, resumeSuspended)
  - src/head/activation.ts   (handleScheduleTrigger delivery set pass-through)

Wave 3: API validation
  - src/dashboard/routes/schedules.ts  (POST + PATCH deliverToHeadIds handling)

Wave 4: Dashboard
  - dashboard/src/types/api.ts        (Schedule.deliverToHeadIds?)
  - dashboard/src/pages/SchedulesPage.tsx  (multi-select + multi-chip)

Wave 5: Tests
  - tests/integration/multi-head-task-delivery.test.ts  (new regression test)
  - extend src/db/schedules.test.ts
  - extend src/dashboard/routes/schedules.test.ts
```

### Project Structure Unchanged

No new directories. All files are modifications to existing files, plus two new files:
- `sql/008_agents_deliver_to_head_ids.sql`
- `tests/integration/multi-head-task-delivery.test.ts`

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| One schedule row per head | One schedule row, delivery set on agent record | Agent runs once; N heads each run relay/work-summary steward independently |
| agent_completed always to `this.headId` | agent_completed fan-out to `deliverySet` | No structural change to how each head processes its own completion event |

---

## Environment Availability

No external dependencies. This phase is code/config changes only within an existing Node.js/TypeScript project with SQLite.

---

## Security Domain

No new attack surface introduced. `deliverToHeadIds` is validated against `resolveCurrentHeads()` on every POST/PATCH — only known head ids are accepted. There is no cross-tenant scope (all heads share one process). The admin-404 stance mirrors Phase 35 D-11.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `'proactive'` is not a separate trigger value — proactive runs use `trigger: 'scheduled'` | Q4 | If a `'proactive'` trigger value exists somewhere, the D-06 guard `trigger === 'scheduled'` would miss it. Mitigated: verified against `src/types/agent.ts` type union and `agents.test.ts` comment. |
| A2 | The `ctx.complete` path in `buildAgentExecutor` is reachable for scheduled top-level agents | Q3 | If this path is only reachable via specific tools that scheduled tasks never use, skipping fan-out there is safe. Conservative to update both sites. |

---

## Sources

### Primary (HIGH confidence)
- Direct reads: `src/db/schedules.ts` (full file) — Schedule/CreateScheduleOptions/SchedulePatch/migrateLegacySchedule patterns
- Direct reads: `src/db/agents.ts` (full file) — AgentRow/rowToState/stmtCreate JSON column patterns
- Direct reads: `src/sub-agents/local.ts` (lines 394-1177) — completeAgent, suspendAsQuestion, buildAgentExecutor, resumeSuspended
- Direct reads: `src/head/activation.ts` (lines 1230-1290) — handleScheduleTrigger spawn site
- Direct reads: `src/dashboard/routes/schedules.ts` (full file) — POST/PATCH validation patterns
- Direct reads: `dashboard/src/pages/SchedulesPage.tsx` (full file) — HEAD_COLORS, AddScheduleForm, ScheduleRow
- Direct reads: `dashboard/src/types/api.ts` (full file) — Schedule dashboard type
- Direct reads: `src/types/agent.ts` (full file) — SpawnOptions, AgentState, trigger union
- Direct reads: `sql/007_agents_head_id.sql` — migration template
- Direct reads: `.planning/STATE.md` §"Decisions (Phase 34)" and §"Decisions (Phase 35)"
- Direct reads: `.planning/phases/44-multi-head-task-delivery/44-CONTEXT.md`
- Direct reads: `tests/integration/multi-head-agent-lifecycle.test.ts` (lines 1-200) — test pattern template

### Secondary (MEDIUM confidence)
- `src/sub-agents/agents.test.ts` line 824 comment confirming `'scheduled'` is the trigger for proactive agents

---

## Metadata

**Confidence breakdown:**
- Data model (schedules.ts + agents.ts): HIGH — full reads, direct pattern extrapolation
- Fan-out (completeAgent × 2 sites): HIGH — both sites directly verified
- Question gate (suspendAsQuestion): HIGH — full function read; trigger union verified
- API validation: HIGH — full routes/schedules.ts read; existing pattern is identical
- Dashboard: HIGH — full SchedulesPage.tsx read; HEAD_COLORS pattern confirmed

**Research date:** 2026-05-24
**Valid until:** 2026-06-24 (stable codebase, no fast-moving deps)
