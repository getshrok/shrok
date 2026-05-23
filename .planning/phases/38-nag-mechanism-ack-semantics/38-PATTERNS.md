# Phase 38: Nag Mechanism & Ack Semantics — Pattern Map

**Mapped:** 2026-05-23
**Files analyzed:** 5 (4 modified in place + 1 new test file)
**Analogs found:** 5 / 5

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/db/schedules.ts` | model/store | CRUD | self (Phase 37 added `requiresAck`/`nagIntervalMinutes` in same file) | exact — same lazy-migration + SchedulePatch extension pattern |
| `src/scheduler/index.ts` | service | event-driven | self (existing cron-advance / one-time-disable branches right beside insertion point) | exact — same branch structure, same `advanceNextRun` call |
| `src/head/activation.ts` | service | event-driven | self (existing ordinary-reminder delivery path in same branch) | exact — same delivery path with new requiresAck guard |
| `src/head/index.ts` | controller | request-response | `cancel_agent` / `write_identity` / `send_file` cases in same file | exact — same HEAD_TOOLS entry + dispatch() case shape |
| `src/head/head.test.ts` (extend or new `head-tools.test.ts`) | test | request-response | `src/head/head.test.ts` lines 190–300 (`HeadToolExecutor` describe block) + `src/head/activation.test.ts` lines 1–241 (`makeFixture`/`fire` harness) | exact for tool dispatch; exact for activation reminder fixture |

---

## Pattern Assignments

### `src/db/schedules.ts` (model/store, CRUD)

**Analog:** Self — Phase 37 additions in the same file (lines 3–41, 55–63, 72–96, 125–141)

**The four surgical changes and their direct analog lines:**

#### 1. `Schedule` type — add `ackPending: boolean` (lines 3–24)

Copy the JSDoc + field pattern from `requiresAck` / `nagIntervalMinutes` (lines 18–21):

```typescript
// src/db/schedules.ts:3-24 — VERIFIED
export interface Schedule {
  // ...existing fields...
  /** Whether this reminder requires explicit user acknowledgment before it stops nagging. */
  requiresAck: boolean
  /** Total nag cadence in minutes — the interval between repeated nag fires. Null/inert when requiresAck is false (D-07). */
  nagIntervalMinutes: number | null
  // Phase 38 adds after nagIntervalMinutes:
  // ackPending: boolean   ← matches same JSDoc + boolean pattern
  createdAt: string
  updatedAt: string
}
```

#### 2. `CreateScheduleOptions` — add optional `ackPending?: boolean` (lines 26–39)

Mirror `requiresAck?: boolean` at line 37 exactly:

```typescript
// src/db/schedules.ts:26-39 — VERIFIED
export interface CreateScheduleOptions {
  // ...
  requiresAck?: boolean       // ← Phase 37 pattern to copy
  nagIntervalMinutes?: number | null
  // Phase 38: ackPending?: boolean   ← same optional boolean pattern
}
```

#### 3. `SchedulePatch` — extend the `Pick<>` union (line 41)

Current state (must be extended — VERIFIED as missing `ackPending`):

```typescript
// src/db/schedules.ts:41 — VERIFIED
export type SchedulePatch = Partial<Pick<Schedule,
  'cron' | 'runAt' | 'enabled' | 'nextRun' | 'lastRun' | 'conditions' | 'agentContext' | 'cronTimezone'
>>
// Phase 38: add | 'ackPending' to the Pick union
```

#### 4. `migrateLegacySchedule` — append one `'field' in obj` guard (lines 55–63)

**This is the primary pattern to copy.** The Phase 37 additions are lines 60–61:

```typescript
// src/db/schedules.ts:55-63 — VERIFIED
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  // Phase 38 appends:
  // if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

**Guard form:** `!('field' in obj)` NOT `obj['field'] === undefined`. This is intentional — `'field' in obj` is mtime-stable (D-03 / Phase 35 D-MIGRATION-IDEMPOTENT).

#### 5. `ScheduleStore.create()` defaults — add `ackPending` (lines 72–96)

Copy the `requiresAck: options.requiresAck ?? false` pattern at line 89:

```typescript
// src/db/schedules.ts:72-96 — VERIFIED
create(options: CreateScheduleOptions): Schedule {
  const now = new Date().toISOString()
  const schedule: Schedule = {
    // ...
    requiresAck: options.requiresAck ?? false,      // ← Phase 37 pattern
    nagIntervalMinutes: options.nagIntervalMinutes ?? null,
    // Phase 38 adds: ackPending: options.ackPending ?? false
    createdAt: now,
    updatedAt: now,
  }
  this.store.save(schedule)
  return schedule
}
```

#### 6. `ScheduleStore.update()` apply-block — add `ackPending` case (lines 125–141)

Copy any existing apply line (e.g. line 136: `if (patch.agentContext !== undefined) existing.agentContext = patch.agentContext`):

```typescript
// src/db/schedules.ts:125-141 — VERIFIED
update(id: string, patch: SchedulePatch): Schedule | null {
  const existing = this.get(id)
  if (!existing) return null
  if (patch.cron !== undefined) existing.cron = patch.cron
  if (patch.runAt !== undefined) existing.runAt = patch.runAt
  if (patch.enabled !== undefined) existing.enabled = patch.enabled
  if (patch.nextRun !== undefined) existing.nextRun = patch.nextRun
  if (patch.lastRun !== undefined) existing.lastRun = patch.lastRun
  if (patch.conditions !== undefined) existing.conditions = patch.conditions
  if (patch.agentContext !== undefined) existing.agentContext = patch.agentContext
  if (patch.cronTimezone !== undefined) existing.cronTimezone = patch.cronTimezone
  // Phase 38 adds: if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending
  existing.updatedAt = new Date().toISOString()
  this.store.save(existing)
  return existing
}
```

---

### `src/scheduler/index.ts` (service, event-driven)

**Analog:** Self — existing advance block at lines 87–99

**Core pattern (entire file is 103 lines — VERIFIED):**

```typescript
// src/scheduler/index.ts:87-99 — VERIFIED current shape
try {
  if (schedule.cron) {
    const tz = schedule.cronTimezone ?? this.timezone
    const next = nextRunAfter(schedule.cron, now, tz)
    this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())
  } else if (enqueued) {
    // Disable so the tick won't re-fire, but keep the row — activation
    // needs it to read agentContext and cron before deleting it after firing.
    this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
  }
} catch (err) {
  log.error(`[scheduler] Failed to advance schedule ${schedule.id}:`, (err as Error).message)
}
```

**Phase 38 transformation — insert `requiresAck` branch BEFORE the `if (schedule.cron)` branch:**

The new branch must come first because a `requiresAck=true` one-time reminder (cron===null) must NOT fall into the `else if (enqueued)` disable path. Use `advanceNextRun` (not `update`) because:
- `advanceNextRun` only updates `nextRun`, leaving `enabled=true` untouched
- The one-time-disable path (`update({ enabled: false, nextRun: null })`) is exactly what must be bypassed

```typescript
// After Phase 38 — the transformed advance block
try {
  if (schedule.requiresAck && schedule.nagIntervalMinutes !== null) {
    // ACK-03 nag re-arm: keep enabled=true, point nextRun to now+nagInterval
    const nagNext = new Date(now.getTime() + schedule.nagIntervalMinutes * 60_000)
    this.scheduleStore.advanceNextRun(schedule.id, nagNext.toISOString())
  } else if (schedule.cron) {
    const tz = schedule.cronTimezone ?? this.timezone
    const next = nextRunAfter(schedule.cron, now, tz)
    this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())
  } else if (enqueued) {
    this.scheduleStore.update(schedule.id, { enabled: false, nextRun: null })
  }
} catch (err) {
  log.error(`[scheduler] Failed to advance schedule ${schedule.id}:`, (err as Error).message)
}
```

**Imports:** `nextRunAfter` is already imported at line 5 — no new imports needed.

---

### `src/head/activation.ts` (service, event-driven)

**Analog:** Self — the reminder branch at lines 1075–1146. Three insertion points.

**Current shape of the reminder branch (VERIFIED):**

```typescript
// src/head/activation.ts:1080-1145 — VERIFIED
if (kind === 'reminder') {
  const schedule = this.opts.scheduleStore.get(event.scheduleId)
  if (!schedule) { log.warn(...); return }

  // [lines 1087-1104] channel resolve + first-channel fallback

  // [lines 1106-1130] steward block (guarded by proactiveShadow || proactiveEnabled)
  if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
    // ...runReminderDecision...
    if (this.opts.config.proactiveEnabled && decision.action === 'skip') {
      if (schedule.cron === null) { this.opts.scheduleStore.delete(event.scheduleId) }
      else { this.opts.scheduleStore.markSkipped(...) }
      return
    }
  }

  // [lines 1132-1136] one-time self-delete or lastRun update
  if (schedule.cron === null) {
    this.opts.scheduleStore.delete(event.scheduleId)
  } else {
    this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
  }

  // [lines 1137-1143] systemTrigger delivery
  const message = schedule.agentContext ?? ''
  log.info(`[scheduler] fired reminder:${event.scheduleId}`)
  this.opts.queueStore.enqueue(
    { type: 'user_message', id: generateId('qe'), channel, text: systemTrigger('reminder', undefined, message), createdAt: new Date().toISOString() },
    PRIORITY.USER_MESSAGE,
    this.opts.headId,
  )
  this.notify()
  return
}
```

**Three Phase 38 insertions:**

**Insertion 1 (D-10 steward bypass):** After line 1105 (channel resolved), wrap the steward block in `!schedule.requiresAck`:

```typescript
// Replace lines 1106-1130 guard — change:
//   if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
// to:
if (!schedule.requiresAck && (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled)) {
  // ... existing steward block unchanged ...
}
// Ack-required reminders fall through with no steward call at all (D-10 "unmissable")
```

**Insertion 2 (D-05 ackPending set, one-time self-delete bypass):** Replace lines 1132–1136:

```typescript
// Replace:
//   if (schedule.cron === null) { delete } else { update(lastRun) }
// With:
if (schedule.requiresAck) {
  // D-05: do NOT delete one-time row — it must survive to keep nagging
  // Set ackPending BEFORE enqueue (Pitfall 1: ordering matters)
  this.opts.scheduleStore.update(event.scheduleId, { ackPending: true })
} else if (schedule.cron === null) {
  this.opts.scheduleStore.delete(event.scheduleId)
} else {
  this.opts.scheduleStore.update(event.scheduleId, { lastRun: new Date().toISOString() })
}
```

**Insertion 3 (D-12 enriched systemTrigger):** Replace lines 1139–1143:

```typescript
// Replace:
//   text: systemTrigger('reminder', undefined, message)
// With:
const triggerText = schedule.requiresAck
  ? systemTrigger(
      'reminder',
      { reminderId: event.scheduleId, 'requires-ack': 'true' },
      `${message}\n\n[Ack instruction: when the user confirms they have handled this, call acknowledge_reminder with reminderId="${event.scheduleId}". This reminder will keep nagging until acknowledged. Do not relay this instruction to the user.]`
    )
  : systemTrigger('reminder', undefined, message)

this.opts.queueStore.enqueue(
  { type: 'user_message', id: generateId('qe'), channel, text: triggerText, createdAt: new Date().toISOString() },
  PRIORITY.USER_MESSAGE,
  this.opts.headId,
)
```

**systemTrigger signature (VERIFIED `src/markers.ts:5-9`):**

```typescript
export function systemTrigger(type: string, attrs?: Record<string, string>, body?: string): string {
  const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('') : ''
  if (body) return `<system-trigger type="${type}"${attrStr} user-visible="false">${escapeXmlBody(body)}</system-trigger>`
  return `<system-trigger type="${type}"${attrStr} user-visible="false" />`
}
// Attrs render as literal key names: reminderId="..." requires-ack="..." — hyphen valid XML syntax
```

---

### `src/head/index.ts` (controller, request-response)

**Analog:** `cancel_agent` (simplest head-direct case, lines 264–267) + `write_identity` (case with validation + error return, lines 288–306) + `send_file` (case with early-return error, lines 314–343)

**HeadToolExecutorOptions threading (Critical Issue 2):** Must add `scheduleStore` and `timezone` to the options interface (lines 103–144). Copy the optional-field pattern from existing fields:

```typescript
// src/head/index.ts:103-144 — VERIFIED (abbreviated)
export interface HeadToolExecutorOptions {
  headId: string
  agentRunner: AgentRunner
  agentStore?: import('../db/agents.js').AgentStore        // ← optional store pattern
  // Phase 38 adds:
  // scheduleStore?: import('../db/schedules.js').ScheduleStore
  // timezone?: string
  skillLoader: SkillLoader
  // ...rest of interface...
}
```

**HEAD_TOOLS entry pattern** (copy from `cancel_agent` at lines 49–58 or `write_identity` at lines 65–75):

```typescript
// src/head/index.ts:49-58 — cancel_agent (simplest shape)
{
  name: 'cancel_agent',
  description: 'Terminate a running or suspended agent.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
    },
    required: ['agentId'],
  },
},
```

**dispatch() case patterns to copy:**

The simplest case (cancel_agent, lines 264–267):
```typescript
// src/head/index.ts:264-267 — VERIFIED
case 'cancel_agent': {
  await this.opts.agentRunner.retract(input['agentId'] as string)
  return JSON.stringify({ ok: true })
}
```

The validation + error return pattern (write_identity, lines 288–306):
```typescript
// src/head/index.ts:288-306 — VERIFIED (key pattern: early error return)
case 'write_identity': {
  const file = input['file'] as string
  const baseName = path.basename(file)
  const knownFiles = this.opts.identityLoader.listFiles()
  if (!knownFiles.includes(baseName)) {
    return JSON.stringify({ error: true, message: `Identity file "${baseName}" does not exist. ...` })
  }
  // ... do work ...
  return JSON.stringify({ ok: true })
}
```

**New `acknowledge_reminder` dispatch case** (D-06, D-07, D-08, D-09):

```typescript
case 'acknowledge_reminder': {
  const reminderId = input['reminderId'] as string
  const schedule = this.opts.scheduleStore?.get(reminderId) ?? null
  if (!schedule) {
    // D-09: already acked + deleted (one-time) → benign no-op
    return JSON.stringify({ ok: true, note: 'Reminder already acknowledged or not found.' })
  }
  if (schedule.requiresAck === false || schedule.kind !== 'reminder') {
    // D-08: hard error — misfire on ordinary reminder or task
    return JSON.stringify({ error: true, message: `Reminder '${reminderId}' does not require acknowledgment. Use cancel_reminder if you want to cancel it.` })
  }
  if (!schedule.ackPending) {
    // D-09: recurring, already acked (between occurrences)
    return JSON.stringify({ ok: true, note: 'Reminder already acknowledged.' })
  }
  if (schedule.cron === null) {
    // ACK-04: one-time → delete entirely
    this.opts.scheduleStore!.delete(reminderId)
  } else {
    // ACK-05 + ACK-06: recurring → stop nag, resume base cadence
    const tz = this.opts.timezone ?? 'UTC'
    const { nextRunAfter } = await import('../scheduler/cron.js')
    const resumeAt = nextRunAfter(schedule.cron, new Date(), tz).toISOString()
    this.opts.scheduleStore!.update(reminderId, { ackPending: false, nextRun: resumeAt })
  }
  return JSON.stringify({ ok: true })
}
```

**Return idiom:** `JSON.stringify({ ok: true })` for success; `JSON.stringify({ error: true, message: '...' })` for hard errors; `JSON.stringify({ ok: true, note: '...' })` for benign no-ops. All three forms are already present in existing cases.

---

### New test file: `src/head/head-tools.test.ts` (test, request-response)

**Primary analog:** `src/head/head.test.ts` lines 190–300 — the existing `HeadToolExecutor` describe block.

**Secondary analog:** `src/head/activation.test.ts` lines 1–241 — for the `scheduleStore` mock shape (lines 126–132) and the `toolExecutorOpts` threading pattern (lines 212–222).

**Harness to clone — from `head.test.ts` lines 223–254:**

```typescript
// src/head/head.test.ts:223-254 — VERIFIED
describe('HeadToolExecutor', () => {
  let runner: AgentRunner
  let memory: Memory
  let skillLoader: SkillLoader
  let usageStore: UsageStore
  let executor: HeadToolExecutor
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-test-'))
    // ...setup...
    runner = makeWorkerRunner()     // vi.fn() mocks on spawn/retract/update/etc
    memory = makeTopicMemory()
    usageStore = makeUsageStore()
    skillLoader = { load: vi.fn(), listAll: vi.fn(), write: vi.fn(), delete: vi.fn(), watch: vi.fn() } as unknown as SkillLoader
    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)
    executor = new HeadToolExecutor({
      headId: 'default', agentRunner: runner, skillLoader, topicMemory: memory,
      usageStore, identityDir: tmpDir, identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
    })
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })
  // tests...
})
```

**scheduleStore mock shape to add** — from `activation.test.ts` lines 126–132:

```typescript
// src/head/activation.test.ts:126-132 — VERIFIED
const scheduleStore = {
  get: vi.fn().mockReturnValue(scheduleRow),
  update: vi.fn(),
  markSkipped: vi.fn(),
  delete: vi.fn(),
  count: vi.fn().mockReturnValue(0),
} as unknown as ScheduleStore
```

**For `head-tools.test.ts`, the executor must be constructed with `scheduleStore` and `timezone` threaded in (Phase 38 additions to `HeadToolExecutorOptions`):**

```typescript
// Pattern: construct executor with scheduleStore for acknowledge_reminder tests
let scheduleStore: ScheduleStore
beforeEach(() => {
  scheduleStore = {
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ScheduleStore

  executor = new HeadToolExecutor({
    headId: 'default',
    agentRunner: runner,
    skillLoader,
    topicMemory: memory,
    usageStore,
    identityDir: tmpDir,
    identityLoader,
    messages: { getAll: () => [] } as unknown as MessageStore,
    scheduleStore,     // Phase 38 new field
    timezone: 'UTC',   // Phase 38 new field
  })
})
```

**Test case shapes to write** (copy `cancel_agent` test at lines 296–300 as the execute() call pattern):

```typescript
// src/head/head.test.ts:296-300 — VERIFIED execute() call shape
it('cancel_agent calls runner.retract and returns ok', async () => {
  const result = await executor.execute({ id: 'tc1', name: 'cancel_agent', input: { agentId: 't1' } })
  expect(runner.retract).toHaveBeenCalledWith('t1')
  expect(JSON.parse(result.content)).toMatchObject({ ok: true })
})
```

The same `executor.execute({ id, name, input })` → `JSON.parse(result.content)` shape applies to all acknowledge_reminder tests.

**Test cases needed (ACK-04, ACK-05, ACK-06, ACK-08, D-09):**

```typescript
// One-time ack: deletes row (ACK-04, ACK-06)
it('acknowledge_reminder one-time: deletes row, returns ok', ...)
// Recurring ack: sets ackPending=false + nextRun=cron-resume (ACK-05, ACK-06)
it('acknowledge_reminder recurring: resumes base cadence, clears ackPending', ...)
// Hard error on requiresAck===false (ACK-08, D-08)
it('acknowledge_reminder on ordinary reminder: hard error', ...)
// Hard error on task (ACK-08, D-08)
it('acknowledge_reminder on task schedule: hard error', ...)
// Not found → no-op (D-09)
it('acknowledge_reminder row not found: ok no-op', ...)
// ackPending===false → no-op (D-09)
it('acknowledge_reminder already acked: ok no-op', ...)
```

**`makeSchedule` fixture shape for test file** — copy from `scheduler.test.ts` lines 67–89 (add `ackPending`):

```typescript
// src/scheduler/scheduler.test.ts:67-89 — VERIFIED (must add ackPending field for Phase 38)
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched_1', headId: 'default', taskName: 'email', kind: 'task',
    cron: '*/3 * * * *', runAt: null, enabled: true,
    lastRun: null, nextRun: new Date().toISOString(),
    lastSkipped: null, lastSkipReason: null, conditions: null, agentContext: null,
    cronTimezone: null, requiresAck: false, nagIntervalMinutes: null,
    // Phase 38 adds: ackPending: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}
```

---

## Shared Patterns

### Lazy Migration Extension
**Source:** `src/db/schedules.ts:55-63`
**Apply to:** `migrateLegacySchedule` only
```typescript
// Pattern: idempotent 'field' in obj guard — NOT obj['field'] ?? coalesce
if (!('ackPending' in obj)) { obj['ackPending'] = false; migrated = true }
```

### SchedulePatch + update() apply-block Extension
**Source:** `src/db/schedules.ts:41` (SchedulePatch), `src/db/schedules.ts:125-141` (update method)
**Apply to:** Both the type and the method together — they must change in tandem
```typescript
// SchedulePatch: add | 'ackPending' to Pick union
// update(): add if (patch.ackPending !== undefined) existing.ackPending = patch.ackPending
```

### Head-Direct Tool Return Idiom
**Source:** `src/head/index.ts:265-267, 294, 305`
**Apply to:** `acknowledge_reminder` dispatch case
```typescript
return JSON.stringify({ ok: true })                              // success
return JSON.stringify({ error: true, message: '...' })          // hard error
return JSON.stringify({ ok: true, note: '...' })                // benign no-op
```

### execute() Error Wrapping
**Source:** `src/head/index.ts:149-163`
**Apply to:** All head tool tests — `execute()` never throws; errors become `{ error: true }` content
```typescript
async execute(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const result = await this.dispatch(toolCall)
    if (typeof result === 'string') return { toolCallId: toolCall.id, name: toolCall.name, content: result }
    return { ...result, toolCallId: toolCall.id, name: toolCall.name }
  } catch (err) {
    return { toolCallId: toolCall.id, name: toolCall.name,
      content: JSON.stringify({ error: true, message: (err as Error).message ?? 'unknown error' }) }
  }
}
```

### scheduleStore Mock Shape
**Source:** `src/head/activation.test.ts:126-132`
**Apply to:** New `head-tools.test.ts` `beforeEach` — the test executor needs `scheduleStore` with `get`, `update`, `delete` mocks

### Scheduler Test Harness (for extending `scheduler.test.ts`)
**Source:** `src/scheduler/scheduler.test.ts:92-118`
**Apply to:** New requiresAck tick tests — same `queueStore`/`scheduleStore`/`evaluator` `beforeEach` block; same `makeSchedule()` helper; same `vi.mocked(scheduleStore.advanceNextRun).mock.calls[0]` assertion pattern

---

## Test File Extension Map

| Test file | What to extend | Analog lines |
|-----------|---------------|--------------|
| `src/scheduler/scheduler.test.ts` | Add `ackPending: false` to `makeSchedule()` helper; add requiresAck tick tests | lines 67–89 (helper), 183–219 (advance block tests) |
| `src/head/activation.test.ts` | Extend `scheduleRow` reminder fixture with `requiresAck`, `nagIntervalMinutes`, `ackPending`, `headId`, `cronTimezone`; add steward-bypass + ackPending-set + enriched-systemTrigger tests | lines 99–112 (fixture), 300–325 (reminder branch tests) |
| `src/head/head-tools.test.ts` (new) | Clone `HeadToolExecutor` describe block from `head.test.ts:223-254`; add `scheduleStore`+`timezone` to constructor; write 6 acknowledge_reminder cases | `head.test.ts:190–300` (harness + execute pattern) |

---

## No Analog Found

None. All five files have direct analog patterns in the existing codebase. The only truly new capability (`acknowledge_reminder` head tool) maps cleanly onto the `cancel_agent` / `write_identity` shape in `src/head/index.ts`.

---

## Critical Pre-Work (Dependency Order)

Per RESEARCH.md sequencing, the planner must order tasks to respect type dependencies:

1. `src/db/schedules.ts` — `ackPending` to `Schedule` + `CreateScheduleOptions` + `SchedulePatch` + `update()` + `migrateLegacySchedule` + `create()` defaults. **All other files depend on this.**
2. `src/scheduler/index.ts` and `src/head/activation.ts` — can be done in parallel once step 1 is complete.
3. `src/head/index.ts` — depends on `SchedulePatch` having `ackPending` (for `update()` call) and `Schedule` having `ackPending` (for `ackPending` field access).
4. Tests — once production code is complete, or incrementally after each file.

---

## Metadata

**Analog search scope:** `src/db/`, `src/scheduler/`, `src/head/`
**Files read:** `src/db/schedules.ts` (215 lines), `src/scheduler/index.ts` (103 lines), `src/head/activation.ts` (lines 1070–1155), `src/head/index.ts` (lines 1–349), `src/scheduler/scheduler.test.ts` (lines 1–219), `src/head/activation.test.ts` (lines 1–360), `src/head/head.test.ts` (lines 1–310)
**Pattern extraction date:** 2026-05-23
