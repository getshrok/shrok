# Phase 37: Schema & Tool Params - Pattern Map

**Mapped:** 2026-05-23
**Files analyzed:** 4 modified (no new files)
**Analogs found:** 6 / 6 (all analogs are IN-FILE — this phase extends existing test-pinned patterns)

> This phase MODIFIES existing files; it creates none. Every "analog" lives inside the
> file being edited (the sibling field that already does the thing the new field must do).
> The planner copies the in-file idiom verbatim and adds two fields. All line numbers
> below were re-verified against current source this session and match RESEARCH.md.

## File Classification

| Modified File | Role | Data Flow | Closest Analog (in-file) | Match Quality |
|---------------|------|-----------|--------------------------|---------------|
| `src/db/schedules.ts` — `Schedule` + `CreateScheduleOptions` + `create()` | model / store | CRUD | existing `cron`/`runAt`/`conditions` field decl + `?? null` default in same struct | exact (sibling field) |
| `src/db/schedules.ts` — `migrateLegacyHeadId` (→ `migrateLegacySchedule`) | model / store | transform (lazy migration) | the existing `'headId' in obj` idempotent guard (same function) | exact (extend in place) |
| `src/sub-agents/registry.ts` — `create_reminder.execute()` validations | tool surface / controller | request-response (validate→reject) | existing `message`/`cron`/`triggerAt`/IANA-tz `{ error, message }` blocks (same fn) | exact (sibling validation) |
| `src/sub-agents/registry.ts` — `createOpts` assembly | tool surface / controller | transform (build opts) | existing conditional `if (cronExpression !== null) createOpts.cron = ...` (same fn) | exact (sibling assignment) |
| `src/sub-agents/registry.ts` — description + param docs | tool surface / config | request-response (schema doc) | existing `description` + `triggerAt`/`cron` param-doc strings (same definition) | exact (edit in place) |
| `src/db/schedules.test.ts` + `src/sub-agents/agents.test.ts` | test | n/a | existing round-trip / mtime-stable / `JSON.parse(result).error` / property-order tests | exact (extend describe blocks) |

## Pattern Assignments

### 1. `src/db/schedules.ts` — new fields on `Schedule` + `CreateScheduleOptions` + `create()` defaults (D-07)

**Role:** model/store · **Data flow:** CRUD · **Analog:** the sibling `cron`/`runAt`/`conditions` fields in the SAME three structs.

**Field declaration analog** — `Schedule` interface, `schedules.ts:3-20`. Add the two new fields here, mirroring `cron: string | null` / `cronTimezone: string | null`:
```typescript
export interface Schedule {
  id: string
  headId: string
  taskName: string | null
  kind: 'task' | 'reminder'
  cron: string | null        // null for one-time
  runAt: string | null       // null for repeating
  // ...
  conditions: string | null
  agentContext: string | null
  cronTimezone: string | null  // per-schedule timezone override; null = use workspace default
  createdAt: string
  updatedAt: string
}
```
New fields (D-07): `requiresAck: boolean` + `nagIntervalMinutes: number | null` (final name encodes units — D-02).

**Optional-options analog** — `CreateScheduleOptions`, `schedules.ts:22-33`. Add two OPTIONAL fields mirroring `cron?`/`conditions?` (do NOT make them required):
```typescript
export interface CreateScheduleOptions {
  id: string
  headId: string
  taskName?: string
  kind?: 'task' | 'reminder'
  cron?: string
  runAt?: string
  nextRun?: string
  conditions?: string
  agentContext?: string
  cronTimezone?: string
}
```
Add: `requiresAck?: boolean` + `nagIntervalMinutes?: number | null`.

**Default-application analog** — `ScheduleStore.create()`, `schedules.ts:65-87`. Every field gets a `?? null` / hard default in the literal. Add two lines mirroring `cron: options.cron ?? null`:
```typescript
  create(options: CreateScheduleOptions): Schedule {
    const now = new Date().toISOString()
    const schedule: Schedule = {
      id: options.id,
      headId: options.headId,
      taskName: options.taskName ?? null,
      kind: options.kind ?? 'task',
      cron: options.cron ?? null,
      runAt: options.runAt ?? null,
      enabled: true,
      // ...
      conditions: options.conditions ?? null,
      cronTimezone: options.cronTimezone ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.store.save(schedule)
    return schedule
  }
```
Add: `requiresAck: options.requiresAck ?? false,` and `nagIntervalMinutes: options.nagIntervalMinutes ?? null,`. The `?? false` / `?? null` default lives HERE, not at the call site (avoids the `exactOptionalPropertyTypes` landmine — see Shared Pattern A).

> **DO NOT touch `SchedulePatch` (schedules.ts:35) or `update()` (116-132).** D-09: creation-only this phase; no caller for an edit path until Phase 39.

---

### 2. `src/db/schedules.ts` — extend lazy migration `migrateLegacyHeadId` → `migrateLegacySchedule` (D-08, ACK-09)

**Role:** model/store · **Data flow:** transform · **Analog:** the existing `'headId' in obj` idempotent guard in the SAME function.

**Exact current body** — `schedules.ts:48-56` (the contract to preserve):
```typescript
function migrateLegacyHeadId(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  if (!('headId' in obj)) {
    obj['headId'] = 'default'
    return { migrated: true, data: obj as unknown as Schedule }
  }
  return { migrated: false, data: obj as unknown as Schedule }
}
```

**Extension contract (preserve EXACTLY):** rename to `migrateLegacySchedule`, switch to a `let migrated = false` accumulator, and OR one independent `if (!('field' in obj))` guard per new field — same `'field' in obj` presence check, NOT a `?? ` coalesce:
```typescript
function migrateLegacySchedule(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  let migrated = false
  if (!('headId' in obj)) { obj['headId'] = 'default'; migrated = true }
  if (!('requiresAck' in obj)) { obj['requiresAck'] = false; migrated = true }
  if (!('nagIntervalMinutes' in obj)) { obj['nagIntervalMinutes'] = null; migrated = true }
  return { migrated, data: obj as unknown as Schedule }
}
```

**Rename the 4 call sites** (all funnel through this helper — `migrated`→re-save): `get()` `schedules.ts:92`, `list()` `schedules.ts:101`, `getDue()` `schedules.ts:143`. (Mutators `markFired`/`advanceNextRun`/`markSkipped` at 152/162/171 read via `this.get(id)`, so they migrate transitively — no edit needed there.) The fire path reads via `scheduleStore.get()` so legacy reminders are stamped before firing → ACK-09 / SC2.

> **CRITICAL — mtime-stable contract.** A naive `obj['requiresAck'] = obj['requiresAck'] ?? false` (unconditional assign) functionally works but BREAKS the idempotency test at `schedules.test.ts:127-171` (it pins `mtimeMs` + byte equality across 3 reads). Use the `'field' in obj` guard so a fully-populated row returns `migrated: false` and is NOT rewritten.

---

### 3. `src/sub-agents/registry.ts` — new ack/nag boundary validations in `create_reminder.execute()` (D-03/D-04/D-05/D-06)

**Role:** tool surface · **Data flow:** request-response (validate→reject) · **Analog:** the existing `message`/`cron`/`triggerAt`/IANA-tz validation blocks in the SAME `execute()`.

**Input-bag read analog** — `registry.ts:955-959`. Read new slots the same way (`as number | undefined`, then runtime-validate — never trust the cast alone):
```typescript
      execute: async (input, _ctx) => {
        const message = input['message'] as string
        const triggerAtArg = input['triggerAt'] as string | undefined
        const cronArg = input['cron'] as string | undefined
        const conditionsArg = input['conditions'] as string | undefined
```
New: `const requiresAckArg = input['requiresAck'] as boolean | undefined`, `const nagMinutes = input['nagMinutes'] as number | undefined` (and `nagHours`, `nagDays`).

**Validation-block idiom to mirror** — `registry.ts:962-977` (all return `JSON.stringify({ error: true, message })`, never throw):
```typescript
        // T-12-01: validate message at tool boundary
        if (typeof message !== 'string' || message.trim().length === 0) {
          return JSON.stringify({ error: true, message: 'message must be a non-empty string' })
        }
        if (message.length > 2000) {
          return JSON.stringify({ error: true, message: 'message must be 2000 characters or fewer' })
        }

        if (!triggerAtArg && !cronArg) {
          return JSON.stringify({ error: true, message: 'Either triggerAt or cron is required.' })
        }
```

**Cadence + IANA-tz reject idiom** (same fn, `registry.ts:976-988`) — second example of the `{ error, message }` shape, including the try/catch-around-`Intl.DateTimeFormat` validation style:
```typescript
          if (!isValidCadence(cronArg)) {
            return JSON.stringify({ error: true, message: CADENCE_ERROR_MESSAGE })
          }
          const cronTimezoneArg = input['cronTimezone'] as string | undefined
          if (cronTimezoneArg !== undefined) {
            try {
              Intl.DateTimeFormat(undefined, { timeZone: cronTimezoneArg })
            } catch {
              return JSON.stringify({
                error: true,
                message: `Invalid cronTimezone: '${cronTimezoneArg}'. Must be a valid IANA timezone string (e.g. "America/New_York").`,
              })
            }
          }
```

**New validations to add (each as a `{ error, message }` early-return, mirroring the above):**
1. Per-slot integer guard — each present slot must be `Number.isInteger(x) && x >= 0` (mirror `message`'s `typeof`/range guard). Reject non-integer / negative / NaN.
2. Sum present slots → `nagSum` (0 if all absent).
3. D-04: `requiresAckArg === true && nagSum < 5` → reject ("requiresAck requires a nag interval ≥ 5 minutes: nagMinutes/nagHours/nagDays").
4. D-05: `nagSum > 0 && requiresAckArg !== true` → reject ("nag slots only apply when requiresAck is true").
5. D-03 ceiling: `nagSum > 43200` → reject ("nag interval must be ≤ 30 days (43200 minutes)").

Exact wording/order is Claude's discretion (CONTEXT.md). Place the new block alongside the existing validations (after the message guard, near the triggerAt/cron presence check). Tests assert on `parsed.message` via `.toMatch(/nag interval/i)` style — keep error strings stable enough to match.

---

### 4. `src/sub-agents/registry.ts` — `createOpts` assembly with new fields (D-02, exactOptionalPropertyTypes-safe)

**Role:** tool surface · **Data flow:** transform · **Analog:** the existing conditional `if (cronExpression !== null) createOpts.cron = ...` in the SAME fn.

**Exact current assembly** — `registry.ts:1018-1035`:
```typescript
        const id = generateId('rem')

        // Phase 35 D-09: headId comes from the factory closure (per-head tool registry).
        const createOpts: import('../db/schedules.js').CreateScheduleOptions = {
          id,
          headId,
          kind: 'reminder',
          agentContext: message,
          runAt: triggerAt ?? undefined,
          nextRun: triggerAt ?? undefined,
        }
        if (cronExpression !== null) {
          createOpts.cron = cronExpression
        }
        if (conditionsArg !== undefined) {
          createOpts.conditions = conditionsArg
        }
        scheduleStore.create(createOpts)

        return JSON.stringify({ ok: true, id })
```
Add — mirroring the `if (conditionsArg !== undefined) createOpts.conditions = ...` conditional-assign (NOT always-assign, which fails `exactOptionalPropertyTypes`):
```typescript
        if (requiresAckArg !== undefined) createOpts.requiresAck = requiresAckArg
        // nagIntervalMinutes = summed nagSum, assigned only when ack-required (else leave to the ?? null default in create())
        if (nagSum > 0) createOpts.nagIntervalMinutes = nagSum
```
Note `generateId('rem')` at line 1018 — keep using it (tests assert `/^rem/`).

---

### 5. `src/sub-agents/registry.ts` — description reword (SCHED-04) + new param docs (D-10)

**Role:** tool surface / config · **Data flow:** schema documentation · **Analog:** the current `description` + `triggerAt`/`cron` param strings in the SAME definition. EDIT IN PLACE; backend behavior unchanged.

**Current description** — `registry.ts:925-927`:
```typescript
        description: 'Create a reminder that fires a notification to the user at a specified time. ' +
          'Use triggerAt (ISO 8601 datetime) for a one-time reminder, or cron for a recurring one. ' +
          'The reminder message should be written as if it is being delivered to the user at fire time.',
```
SCHED-04 reword (D-10a): document `triggerAt` alone = one-time; `cron` alone = recurring (first fire from cron); `triggerAt` + `cron` together = start-then-repeat (first fire at `triggerAt`, then repeat on `cron`). Plus new-param docs (D-10b): `requiresAck` "marks the reminder acknowledgment-required — it keeps nagging every nag interval until the user explicitly acknowledges it" and the `nagMinutes`/`nagHours`/`nagDays` slots as the nag cadence.

**Current `triggerAt` param doc** — `registry.ts:939-942` (remove the misleading "for one-time reminders only" wording):
```typescript
            triggerAt: {
              type: 'string',
              description: 'ISO 8601 datetime for one-time reminders (e.g. "2026-04-01T09:00:00Z"). Required if cron is not provided.',
            },
```

**Current `cron` param doc** — `registry.ts:943-946` (context for the start-then-repeat reword; keep the cadence list intact):
```typescript
            cron: {
              type: 'string',
              description: 'Cron expression for recurring reminders. Must be one of: every N minutes (*/N * * * * with N ∈ {5,10,15,30,45,60}), hourly (M * * * *), daily (M H * * *), weekdays Mon–Fri (M H * * 1-5), weekly (M H * * D), every N days (0 H */N * * with N ∈ {1..7}), monthly (M H D * *), yearly (M H D Mo *). For custom timing logic, use the conditions argument.',
            },
```

**inputSchema properties block** — `registry.ts:930-952`. Add `requiresAck` / `nagMinutes` / `nagHours` / `nagDays` property entries here. ⚠️ **Insertion ORDER is test-pinned** — see Pitfall in Test analogs below; pick a deliberate order and update the property-order test to match.

**Backend already correct — DO NOT change (verify only):** the `triggerAt`+`cron` combine logic at `registry.ts:992-1003` and the scheduler `advanceNextRun`-from-cron at `src/scheduler/index.ts:88-91`. SCHED-04 is description text only (Pitfall 6 in RESEARCH.md — editing the scheduler risks regressing 1400+ tests).

**Optional (Claude's discretion):** `list_reminders` projection at `registry.ts:915-919` currently maps `{ id, message, runAt, cron, createdAt }`. Adding `requiresAck`/`nagIntervalMinutes` is a trivial 2-key add (read-only, no validation). Lean include (helps Phase 38). If included, add a one-line assertion to the `list_reminders` test (`agents.test.ts:1299-1308`).

---

### 6. Test analogs — `src/db/schedules.test.ts` + `src/sub-agents/agents.test.ts`

**Role:** test · **Analog:** the existing round-trip / mtime-stable / `JSON.parse(result).error` / property-order tests. Extend the existing describe blocks; no new test files (fixtures already exist).

**Store round-trip analog** — `schedules.test.ts:39-51` (`describe('ScheduleStore — headId')`, tmpDir + `ScheduleStore` in `beforeEach`):
```typescript
  it("create({ headId: 'default' }) round-trips through get()", () => {
    store.create({
      id: 's-default',
      headId: 'default',
      kind: 'task',
      taskName: 'x',
      runAt: '2026-01-01T00:00:00Z',
      nextRun: '2026-01-01T00:00:00Z',
    })
    const s = store.get('s-default')
    expect(s).not.toBeNull()
    expect(s!.headId).toBe('default')
  })
```
New round-trip: `store.create({ ..., kind:'reminder', requiresAck:true, nagIntervalMinutes:60 })` → `store.get(id)` → `expect(s!.requiresAck).toBe(true)` / `expect(s!.nagIntervalMinutes).toBe(60)`. Also a `kind:'task'` row WITHOUT ack fields → defaults `requiresAck:false`, `nagIntervalMinutes:null` (D-07 inert-for-tasks).

**Legacy-JSON-write fixture analog** — `schedules.test.ts:92-125` (writes synthetic legacy JSON, asserts field absent before, defaulted after). For SC2: write a legacy reminder JSON with NO `requiresAck`/`nagIntervalMinutes`, read via `get()`, assert defaults stamped + file rewritten once:
```typescript
    const filePath = path.join(tmpDir, `${id}.json`)
    fs.writeFileSync(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8')
    const beforeRaw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect('headId' in beforeRaw).toBe(false)        // ← mirror: expect('requiresAck' in beforeRaw).toBe(false)
    const s = store.get(id)
    expect(s!.headId).toBe('default')                 // ← mirror: expect(s!.requiresAck).toBe(false)
    const afterRaw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Schedule
    expect(afterRaw.headId).toBe('default')
```

**mtime-stable idempotency analog** — `schedules.test.ts:127-171`. This test MUST still pass after the new stamps. Its body (do NOT weaken — it pins the D-08 contract):
```typescript
    store.get(id)
    const mtimeAfterFirst = fs.statSync(filePath).mtimeMs
    const bytesAfterFirst = fs.readFileSync(filePath)
    await new Promise(r => setTimeout(r, 50))
    store.get(id)   // second read: must not rewrite
    const mtimeAfterSecond = fs.statSync(filePath).mtimeMs
    // ...
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
    expect(bytesAfterSecond.equals(bytesAfterFirst)).toBe(true)
```
The legacy fixture in this test (lines 128-145) lacks the new fields, so the FIRST read now stamps 3 fields then stabilizes — the existing assertions (mtime stable on read 2 & 3) still hold IF the `'field' in obj` guard is used. Consider adding a sibling test that writes a row already containing all new fields and asserts ZERO rewrites on the first read too.

**Tool-boundary reject analog** — `agents.test.ts:1282-1288` (inside `describe('buildReminderTools')`, helper `getReminderTools()` at 1255-1268 returns `{ createReminder, listReminder, cancelReminder, scheduleStore }`, `ctx` at 1253):
```typescript
  it('create_reminder with empty message returns error JSON (T-12-01)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: '  ', triggerAt: '2099-01-01T09:00:00Z' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/non-empty/i)
  })
```
New rejects (D-03/04/05) follow this exact shape — `createReminder.execute({ message, triggerAt, requiresAck:true }, ctx)` → `expect(parsed.error).toBe(true)` + `.toMatch(/nag interval/i)`. Add: D-04 (ack no nag), D-05 (nag no ack), D-03 floor (<5), D-03 ceiling (>43200), non-integer slot.

**Tool→store round-trip / slot-sum analog** — `agents.test.ts:1327-1349` (`conditions` stored / null tests — the closest analog for "field threads tool→store"):
```typescript
  it('create_reminder stores conditions on the reminder schedule row (C-01)', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute(
      { message: 'Check the build', triggerAt: '2099-01-01T09:00:00Z', conditions: 'Only on weekdays' },
      ctx,
    )
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows[0]!.conditions).toBe('Only on weekdays')
  })
```
New (D-01/D-02): `execute({ message, triggerAt, requiresAck:true, nagHours:1, nagMinutes:30 })` → `expect(rows[0]!.nagIntervalMinutes).toBe(90)` and `rows[0]!.requiresAck` `toBe(true)`. Also a no-ack default test: `expect(rows[0]!.requiresAck).toBe(false)` / `nagIntervalMinutes` `toBeNull()` (mirror the conditions-null test at 1341-1349).

**inputSchema-declares-property analog** — `agents.test.ts:1351-1358` (for SC3 description assertion + new-param-declared assertions):
```typescript
  it('create_reminder inputSchema declares conditions property', async () => {
    const { createReminder } = await getReminderTools()
    const schema = createReminder.definition.inputSchema as {
      properties: { conditions?: { type: string } }
    }
    expect(schema.properties.conditions).toBeDefined()
    expect(schema.properties.conditions!.type).toBe('string')
  })
```
New: assert `requiresAck`/`nagMinutes`/`nagHours`/`nagDays` declared; SC3 — assert `description` no longer contains "for one-time reminders only" and DOES document start-then-repeat.

**⚠️ property-order test — MUST be UPDATED** — `agents.test.ts:1453-1460` (inside `describe('phase 23: cronTimezone field')`):
```typescript
  it('create_reminder: cronTimezone appears BEFORE triggerAt in property order', async () => {
    const scheduleStore = await makeScheduleStore()
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'default')
    const create = tools.find(t => t.definition.name === 'create_reminder')!
    const keys = Object.keys(create.definition.inputSchema.properties as object)
    expect(keys).toEqual(['message', 'cronTimezone', 'triggerAt', 'cron', 'conditions'])
  })
```
Adding new properties WILL fail this assertion (RESEARCH.md Pitfall 3). Update the expected array to the deliberate new key order including `requiresAck`/`nagMinutes`/`nagHours`/`nagDays`. This is expected churn, NOT a regression — the planner must flag it.

## Shared Patterns

### A. `exactOptionalPropertyTypes`-safe field assignment (THE phase landmine)
**Source:** `src/sub-agents/registry.ts:1029-1034` (conditional assign) + `src/db/schedules.ts:65-87` (`?? null`/`?? false` defaults in `create()`).
**Apply to:** every new optional field crossing the tool→store boundary.
```typescript
// At the CALL SITE (registry.ts) — conditional, never always-assign:
if (conditionsArg !== undefined) { createOpts.conditions = conditionsArg }
// In the STORE (schedules.ts create()) — the default lives here:
conditions: options.conditions ?? null,
```
You CANNOT write `createOpts.x = maybeUndefinedValue` for an `exactOptionalPropertyTypes` optional. Either conditionally assign, or omit the key and let `create()`'s `?? false`/`?? null` apply. Warning sign: `tsc` TS2375.

### B. Tool-boundary validation → `{ error: true, message }` (never throw)
**Source:** `src/sub-agents/registry.ts:962-988`.
**Apply to:** all new ack/nag validations (D-03/04/05/06).
```typescript
if (<bad condition>) {
  return JSON.stringify({ error: true, message: '<actionable message>' })
}
```
The model retries on this shape; tests assert `JSON.parse(result).error === true` + `.message` matcher.

### C. Lazy-migration idempotent guard (`'field' in obj`, NOT `??`)
**Source:** `src/db/schedules.ts:48-56`.
**Apply to:** both new stamped fields in `migrateLegacySchedule`.
```typescript
if (!('field' in obj)) { obj['field'] = <default>; migrated = true }
```
Coalesce (`obj.x = obj.x ?? d`) breaks the mtime-stable test at `schedules.test.ts:127`.

### D. `noUncheckedIndexedAccess` in tests — non-null assert array reads
**Source:** `agents.test.ts:1278` (`rows[0]!.agentContext`) / `schedules.test.ts` (`s!.headId`).
**Apply to:** all new test assertions reading `rows[0]` / `store.get()` results — use `rows[0]!` / `s!`.

## No Analog Found

None. Every change has an exact in-file sibling pattern (this phase is pure extension of test-pinned idioms). RESEARCH.md confirms there is NO pre-existing `requiresAck`/`nag*` concept, so the analogs are the structurally-identical neighboring fields, not prior ack code.

## Metadata

**Analog search scope:** `src/db/schedules.ts`, `src/db/schedules.test.ts`, `src/sub-agents/registry.ts` (lines 900-1063), `src/sub-agents/agents.test.ts` (buildReminderTools block 1250-1359 + property-order test 1453-1460).
**Files scanned:** 4 (all 4 are the files being modified).
**Line numbers:** re-verified against current source 2026-05-23; all match RESEARCH.md citations.
**Pattern extraction date:** 2026-05-23
