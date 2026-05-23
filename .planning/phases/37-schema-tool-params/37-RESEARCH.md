# Phase 37: Schema & Tool Params - Research

**Researched:** 2026-05-23
**Domain:** Backend schema extension + LLM tool-surface params (TypeScript / node:sqlite-adjacent JSON file store)
**Confidence:** HIGH (all claims verified directly against current source + a green tsc/test baseline this session)

## Summary

Phase 37 is a small, fully-specified backend phase. CONTEXT.md already locks 10 decisions (D-01..D-10); this research does NOT relitigate them. Its job was to (a) confirm every cited line number/shape is still accurate so the planner's `read_first` targets are trustworthy, (b) surface the exact idioms the new code must mirror, (c) flag landmines, and (d) produce a Validation Architecture section (Nyquist is enabled — no `.planning/config.json` exists and no `nyquist_validation` key is set anywhere, so per the default-enabled rule it is ON).

**Verification result: all cited references are accurate.** The `Schedule` interface, `CreateScheduleOptions`, `migrateLegacyHeadId`, and `ScheduleStore.create()` are at the exact lines CONTEXT.md cites (`schedules.ts:3 / 22 / 48 / 65`). In `registry.ts`, `buildReminderTools` starts at line 903, the description at 925-927, `triggerAt` param at 939-942, the validation block at 955-1016, the `triggerAt`+`cron` combine logic at 994-1003, and the `createOpts` assembly at 1021-1035 — all match. The only drift worth noting: CONTEXT.md cites the `buildReminderTools` *range* as 903-1038, but 1038 is the end of `create_reminder.execute()` only; the full function (including `cancel_reminder`) ends at line 1063. This is harmless. SCHED-04's backend was verified already-working: `scheduler/index.ts:88-91` advances `nextRun` from cron after each fire regardless of whether the first fire came from `triggerAt`, so start-then-repeat is real today — SCHED-04 is reword-only.

Baseline this session: `npx tsc --noEmit` is clean (exit 0); `src/db/schedules.test.ts` 14/14 pass; `src/sub-agents/agents.test.ts -t buildReminderTools` 13/13 pass. There is NO pre-existing `requiresAck`/`nag*` concept anywhere in `src/` (grep confirmed — the only "acknowledgment" hits are unrelated spawn_agent prose).

**Primary recommendation:** Extend, don't invent. Add the two fields to `Schedule` + `CreateScheduleOptions`, default them in `ScheduleStore.create()`, rename `migrateLegacyHeadId` → `migrateLegacySchedule` and stamp both new fields behind the same `'field' in obj` idempotent guard, add `requiresAck`/`nagMinutes`/`nagHours`/`nagDays` params to `create_reminder` with boundary validations that return the existing `{ error: true, message }` shape, and reword the description. Mirror the existing test idioms in `schedules.test.ts` (round-trip + mtime-stable migration) and `agents.test.ts` (tool-boundary `JSON.parse(result).error` assertions).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Acknowledgment field storage | Database / Storage (`src/db/schedules.ts` JSON file store) | — | Fields live on the shared `Schedule` row, written/read through `ScheduleStore` + `createFileStore` JSON. [VERIFIED: src/db/schedules.ts] |
| Backward-compat default migration | Database / Storage (lazy stamp in `ScheduleStore` read funnels) | — | All reads (`get`/`list`/`getDue`, and `markFired`/`advanceNextRun`/`markSkipped` via `this.get`) funnel through `migrateLegacyHeadId`. [VERIFIED: schedules.ts:89-149] |
| Param exposure to the LLM | API / Tool surface (`buildReminderTools` in `src/sub-agents/registry.ts`) | — | The LLM only sees fields declared in `create_reminder.inputSchema.properties`; `execute()` reads them from the `input` bag. [VERIFIED: registry.ts:922-1038] |
| Boundary validation (floor/ceiling/coupling) | API / Tool surface (`create_reminder.execute()`) | — | D-06 mandates tool-boundary validation returning `{ error: true, message }` — matches the existing `message`/cron/timezone validation idiom. [VERIFIED: registry.ts:955-1016] |
| Tool description correctness (SCHED-04) | API / Tool surface (`create_reminder.description` + `triggerAt` param description) | — | Reword only; backend behavior already correct. [VERIFIED: registry.ts:925-942 + scheduler/index.ts:88-91] |

## Project Constraints (from CLAUDE.md / AGENTS.md)

These are load-bearing for this phase — the planner must honor them:

- **Schedules/reminders are JSON files, not SQLite rows** — written via `src/db/file-store.ts` (`createFileStore`). Do NOT add a SQL migration; the "migration" here is the lazy JSON stamp. [VERIFIED: AGENTS.md + schedules.ts:1,62]
- **`write-file-atomic` is the write path** — already used inside `file-store.ts` (`writeJsonFile` → `writeFileSync` from `write-file-atomic`). The store handles this; new code calls `store.save()`, not raw `fs`. [VERIFIED: file-store.ts:3,55-57]
- **`moduleResolution: bundler`** — import paths use `.js` extensions that resolve to `.ts` files (e.g. `import ... from '../db/schedules.js'`). New imports MUST use `.js`. [VERIFIED: tsconfig.json:5 + registry.ts:11]
- **`noUncheckedIndexedAccess: true`** — array indexing returns `T | undefined`; null-check before use (tests already do `rows[0]!`). [VERIFIED: tsconfig.json:10]
- **`exactOptionalPropertyTypes: true`** — you CANNOT set an optional property to `undefined` explicitly; omit the key or `delete` it. This is the #1 landmine for this phase (see Common Pitfalls). [VERIFIED: tsconfig.json:11]
- **`strict: true`**. [VERIFIED: tsconfig.json:9]
- **Tests are sharded 6× on CI; do not raise heap as a first move.** Not relevant to writing tests, but relevant if a future shard OOMs. [from AGENTS.md]
- **`dashboard/dist` rebuild conflicts** — N/A this phase (no dashboard changes; that's Phase 39).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ACK-01 | User can create an ack-required reminder | Add `requiresAck` to `Schedule` + `CreateScheduleOptions` + `create_reminder` param; stored on the row. Full nag mechanism is Phase 38 — Phase 37 only lands the schema + tool param + description. [VERIFIED: schedules.ts, registry.ts] |
| ACK-02 | User can set a nag interval independent of base recurrence | Add `nagMinutes`/`nagHours`/`nagDays` input slots (D-01) summed into a single stored integer-minutes field (D-02). Independent of `cron`. [CITED: CONTEXT.md D-01/D-02] |
| ACK-09 | Pre-milestone reminders fire unchanged via lazy default migration | Extend `migrateLegacyHeadId` to also stamp `requiresAck:false` + `nagIntervalMinutes:null` behind the `'field' in obj` guard. Read funnels already cover `get`/`list`/`getDue`/fire-path. [VERIFIED: schedules.ts:48-149, activation.ts:1081] |
| SCHED-04 | Tool description documents `triggerAt`+`cron` = start-then-repeat | Backend VERIFIED working (scheduler advances `nextRun` from cron after fire). Reword `create_reminder.description` + `triggerAt` param description; remove "for one-time reminders only". [VERIFIED: registry.ts:925-942, scheduler/index.ts:88-91] |

## Standard Stack

No new dependencies. This phase uses only what's already in the repo.

### Core (existing, in-repo)
| Module | Purpose | Why it's the standard here |
|--------|---------|---------------------------|
| `src/db/schedules.ts` (`ScheduleStore`, `Schedule`, `CreateScheduleOptions`) | The schedule/reminder data layer | Reminders are `kind:'reminder'` rows on the shared `Schedule` type (D-07). [VERIFIED] |
| `src/db/file-store.ts` (`createFileStore`) | Atomic JSON persistence | Backs `ScheduleStore`; uses `write-file-atomic`. [VERIFIED] |
| `src/sub-agents/registry.ts` (`buildReminderTools`) | The `create_reminder` tool surface | Where ACK-01/02 params + SCHED-04 description land. [VERIFIED] |
| `src/scheduler/cadence.ts` (`isValidCadence`, `CADENCE_ERROR_MESSAGE`) | Existing tool-boundary validation helpers | Pattern to mirror for new boundary validations. [VERIFIED: registry.ts:16] |
| `src/llm/util.ts` (`generateId`) | ID generation (`generateId('rem')`) | Already used by `create_reminder`. [VERIFIED: registry.ts:15,1018] |

### Test stack (existing)
| Tool | Version | Notes |
|------|---------|-------|
| vitest | ^2.1.0 (running 2.1.9) | `npm test` = `vitest run`. Node `environment: 'node'`. [VERIFIED: package.json] |
| typescript | ^5.6.0 | `npx tsc --noEmit` is the type gate (SC4). [VERIFIED: package.json] |
| node | >=22.0.0 | `node:sqlite` is used elsewhere but NOT for schedules. [VERIFIED: package.json engines] |

**Installation:** None. No `npm install` in this phase.

## Package Legitimacy Audit

Not applicable — this phase installs **zero** external packages. All code uses in-repo modules and existing devDependencies (vitest, typescript) that are already locked in `package.json`. slopcheck/registry verification is moot.

## Architecture Patterns

### Data flow (create → store → read-back round-trip = SC1)

```
LLM tool call
  → create_reminder.execute(input)            [registry.ts:955]
      reads message/triggerAt/cron/conditions  (+ NEW: requiresAck/nagMinutes/nagHours/nagDays)
      validates at boundary → { error, message } on reject   [registry.ts:962-1016]
      sums nag slots → nagIntervalMinutes (NEW)
      assembles CreateScheduleOptions          [registry.ts:1021-1035]
  → scheduleStore.create(createOpts)           [schedules.ts:65]
      applies defaults (requiresAck ?? false, nagIntervalMinutes ?? null)  (NEW)
  → store.save(schedule)                       [file-store.ts:79 → writeJsonFile, atomic]
  ─────────── round-trip ───────────
  → scheduleStore.get(id) / list()             [schedules.ts:89 / 97]
      → migrateLegacySchedule(raw)             [renamed from migrateLegacyHeadId, schedules.ts:48]
          stamps requiresAck/nagIntervalMinutes if absent (idempotent guard)  (NEW)
      → returns Schedule with new fields populated
```

### Pattern 1: Lazy field migration with idempotent guard (D-08 — the ACK-09 mechanism)

**What:** Stamp a default onto legacy JSON on first read, behind a presence check so repeat reads don't rewrite the file (mtime-stable).
**Where to extend:** `src/db/schedules.ts:48` (currently `migrateLegacyHeadId`; rename to `migrateLegacySchedule` per D-08 — encouraged since it now stamps >1 field).
**Current shape (VERIFIED, schedules.ts:48-56):**
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
**Extension shape (the contract to preserve):** check each field independently and OR the `migrated` flag, so a row missing only one field still gets stamped, and a fully-populated row returns `migrated:false` (no rewrite). Example:
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
**Why the guard matters:** The existing test `"second read of an already-migrated file does NOT rewrite (mtime stable)"` (schedules.test.ts:127-171) pins this contract via `fs.statSync().mtimeMs` + byte equality across 3 reads. A naive `obj.requiresAck = obj.requiresAck ?? false` (unconditional assignment) would pass functionally but BREAK mtime stability because `migrated` would never be reliably false — keep the `'field' in obj` presence check, not a `??` coalesce. [VERIFIED: schedules.test.ts:127-171]

**Read funnel coverage (VERIFIED, schedules.ts):** `get()` (89), `list()` (97), `getDue()` (139) all call the migrate helper and re-save when `migrated`. The mutators `markFired` (152), `advanceNextRun` (162), `markSkipped` (171) read via `this.get(id)` (Phase 35 D-03), so they migrate too. The reminder fire path reads via `scheduleStore.get(event.scheduleId)` (activation.ts:1081) — so a legacy reminder gets its new fields stamped at fire time, guaranteeing SC2 backward-compat (no crash, no behavior change).

### Pattern 2: Tool-boundary validation → `{ error: true, message }` (D-06)

**What:** Validate args inside `execute()`; on failure return `JSON.stringify({ error: true, message })` so the model retries. Never throw.
**Current idiom (VERIFIED, registry.ts:962-977):**
```typescript
if (typeof message !== 'string' || message.trim().length === 0) {
  return JSON.stringify({ error: true, message: 'message must be a non-empty string' })
}
if (message.length > 2000) {
  return JSON.stringify({ error: true, message: 'message must be 2000 characters or fewer' })
}
// ...
if (!isValidCadence(cronArg)) {
  return JSON.stringify({ error: true, message: CADENCE_ERROR_MESSAGE })
}
```
**New validations to add (D-03/D-04/D-05) follow this exact shape.** Read slots as `input['nagMinutes'] as number | undefined` etc. Suggested order (decide final wording — Claude's discretion per CONTEXT.md):
1. Sum present slots → `nagSum` (0 if all absent).
2. D-04: `requiresAck === true && nagSum < 5` → reject ("requiresAck requires a nag interval ≥ 5 minutes: nagMinutes/nagHours/nagDays").
3. D-05: `nagSum > 0 && requiresAck !== true` → reject ("nag slots only apply when requiresAck is true").
4. D-03 floor: `requiresAck === true && nagSum < 5` (covered by D-04 if you fold them) → reject.
5. D-03 ceiling: `nagSum > 43200` → reject ("nag interval must be ≤ 30 days (43200 minutes)").
   - Edge: a non-integer or negative slot should also reject — mirror `message`'s type guard. With `noUncheckedIndexedAccess` the values are `unknown` from the bag; cast + validate `Number.isInteger(x) && x >= 0`.

### Pattern 3: Shared-type defaults in `create()` (D-07)

`ScheduleStore.create()` (schedules.ts:65-87) builds the full `Schedule` literal with `?? null` / `?? false` defaults. Add two lines mirroring the existing fields:
```typescript
requiresAck: options.requiresAck ?? false,
nagIntervalMinutes: options.nagIntervalMinutes ?? null,
```
These are inert for tasks (D-07): tasks never set them, so they default false/null. No task code path reads them in Phase 37.

### Recommended file touch list (for the planner)

```
src/db/schedules.ts            # Schedule interface (+2 fields), CreateScheduleOptions (+2 optional),
                               #   create() defaults, migrateLegacyHeadId → migrateLegacySchedule (+2 stamps)
src/db/schedules.test.ts       # extend migration round-trip + mtime-stable tests for new fields
src/sub-agents/registry.ts     # create_reminder: inputSchema params, execute() validation + slot-sum +
                               #   createOpts assembly, description reword (SCHED-04 + new params).
                               #   Optionally list_reminders projection (Claude's discretion).
src/sub-agents/agents.test.ts  # buildReminderTools describe block: new validation + round-trip tests
```

### Anti-Patterns to Avoid
- **SQL migration / new table.** Reminders are JSON files; there is no SQLite row for them. (CLAUDE.md is explicit.)
- **Unconditional default assignment in the migrator** (`obj.x = obj.x ?? false`) — breaks the mtime-stable idempotency contract. Use `if (!('x' in obj))`.
- **Touching `SchedulePatch` / adding an `update_reminder` path** — D-09 forbids it; no caller until Phase 39.
- **Touching the activation fire branch** (`activation.ts:1079-1146`) or scheduler — that's Phase 38. SCHED-04 is description-only.
- **Setting an optional property to `undefined` explicitly** — `exactOptionalPropertyTypes` rejects it. Use conditional spread or omit the key (see Pitfalls).
- **A single `nagInterval` string param** (e.g. `'1h'`/ISO-8601) — explicitly rejected in D-01. Use the three integer slots.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic JSON write | `fs.writeFileSync` | `store.save()` → `write-file-atomic` (already in `file-store.ts`) | Atomicity + 0o644 mode + trailing newline already handled. [VERIFIED] |
| Lazy default migration | A new migration framework | Extend `migrateLegacySchedule` (the proven Phase 35 pattern) | Idempotent guard + read-funnel coverage already exist and are test-pinned. [VERIFIED] |
| Tool error return | `throw` / custom error type | `return JSON.stringify({ error: true, message })` | Established contract the model + tests expect. [VERIFIED: registry.ts] |
| Reminder ID | `crypto.randomUUID()` ad hoc | `generateId('rem')` | Already used; produces `rem`-prefixed IDs tests assert on (`/^rem/`). [VERIFIED: registry.ts:1018, agents.test.ts:1275] |
| Cron validation | New cron parser | `isValidCadence` / `CADENCE_ERROR_MESSAGE` | Already imported and used. [VERIFIED: registry.ts:16] |

**Key insight:** This phase is almost entirely "extend an existing, test-pinned pattern by a couple of fields." The hand-roll risk is reimplementing migration or persistence that already exists.

## Runtime State Inventory

This phase is **additive schema, not a rename/refactor**, so most categories are N/A. The one migration-adjacent concern is the lazy stamp of new fields onto existing on-disk reminder JSON.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing reminder/schedule JSON files under `{workspacePath}/data/schedules/` (per AGENTS.md; dir name historically `schedules/`). These lack `requiresAck`/`nagIntervalMinutes`. | **Lazy code migration only** — `migrateLegacySchedule` stamps defaults on first read. NO bulk data migration needed (matches Phase 35 `headId` approach). The fire path reads via `get()` so legacy rows are stamped before firing → SC2 satisfied. |
| Live service config | None — no external service stores reminder fields. shrok runs in a tmux session (`bin/shrok-daemon`), reminders are local JSON. | None — verified: reminders are an in-process JSON feature, not externalized. |
| OS-registered state | None — no OS scheduler/cron registration; shrok's own scheduler ticks in-process. | None — verified by `src/scheduler/index.ts` being an in-process ticker. |
| Secrets/env vars | None — no new env keys; behavioral only. `ENV_KEY_ALLOWLIST` untouched. | None. |
| Build artifacts | None for this phase — no dashboard build, no `src/icw/` sync, no compiled artifact carries reminder shape. | None. |

**The canonical question — "after every file is updated, what runtime state still has the old shape?":** Only on-disk reminder JSON, and that is handled by the lazy stamp on read (no separate bulk migration task). A running shrok process holds `Schedule` objects in memory only transiently per tick (no long-lived in-memory cache of schedules — `getDue`/`get` re-read from disk each time), so a restart is not even required for correctness; new reads naturally migrate.

## Common Pitfalls

### Pitfall 1: `exactOptionalPropertyTypes` rejects explicit `undefined` on optional `CreateScheduleOptions` fields
**What goes wrong:** Adding `requiresAck?: boolean` to `CreateScheduleOptions`, then writing `createOpts.requiresAck = requiresAckArg` where `requiresAckArg` is `boolean | undefined` fails `tsc` — you cannot assign `undefined` to an `exactOptionalPropertyTypes` optional field.
**Why it happens:** `exactOptionalPropertyTypes: true` (tsconfig.json:11). The existing code already dodges this — note registry.ts:1029-1034 uses **conditional assignment** (`if (cronExpression !== null) createOpts.cron = ...`) rather than always-assign.
**How to avoid:** Mirror that idiom. Only assign the field when defined:
```typescript
if (requiresAckArg !== undefined) createOpts.requiresAck = requiresAckArg
if (nagIntervalMinutes !== null) createOpts.nagIntervalMinutes = nagIntervalMinutes
```
Or pass them through the object literal only when present. The `?? false` / `?? null` default lives in `ScheduleStore.create()`, not at the call site.
**Warning sign:** `tsc` error TS2375 / "Type 'undefined' is not assignable... with 'exactOptionalPropertyTypes: true'".

### Pitfall 2: `noUncheckedIndexedAccess` on the input bag and on result arrays
**What goes wrong:** `input['nagMinutes']` is typed loosely; in tests `rows[0].requiresAck` errors because `rows[0]` is `Schedule | undefined`.
**How to avoid:** Tests already use `rows[0]!` (non-null assertion) — follow suit (agents.test.ts:1278). For the input bag, cast and validate: `const nagMinutes = input['nagMinutes'] as number | undefined`, then `Number.isInteger(nagMinutes)` before use.
**Warning sign:** TS18048 "possibly 'undefined'".

### Pitfall 3: Breaking the property-order test for `create_reminder` inputSchema
**What goes wrong:** There is a test that pins exact property key order: `expect(keys).toEqual(['message', 'cronTimezone', 'triggerAt', 'cron', 'conditions'])` (agents.test.ts:1459). Adding new properties WILL break this test.
**How to avoid:** Decide deliberate insertion order for the new params and **update that test** to match. (This is expected churn, not a bug — but the planner must flag it so it isn't mistaken for a regression.)
**Warning sign:** That one assertion fails after adding params.

### Pitfall 4: Mistaking `migrated ??=`/coalesce for the idempotent guard
**What goes wrong:** Using `obj['requiresAck'] = obj['requiresAck'] ?? false` rewrites the file on every read (mtime churn), failing the mtime-stable test.
**How to avoid:** Strictly `if (!('requiresAck' in obj))`. (See Pattern 1.)
**Warning sign:** `"second read ... does NOT rewrite (mtime stable)"`-style test fails.

### Pitfall 5: SC1's ROADMAP example uses stale `nagInterval: '1h'`
**What goes wrong:** ROADMAP.md:253 says SC1 round-trips `nagInterval: '1h'`, which predates D-01/D-02's multi-slot decision. A verifier comparing literally will flag a "format mismatch."
**How to avoid:** Planner should restate SC1 as: a reminder created with `requiresAck: true` and nag slots (e.g. `nagHours: 1`) summed to a stored integer-minutes field (e.g. `nagIntervalMinutes: 60`) round-trips correctly via `get()`. (CONTEXT.md canonical_refs already calls this out.)

### Pitfall 6: SCHED-04 scope creep into the scheduler
**What goes wrong:** "Make start-then-repeat work" — but it already works (verified). Editing the scheduler risks regressing 1413+ existing tests.
**How to avoid:** SCHED-04 is description text only. Backend verified at `scheduler/index.ts:88-91` + `registry.ts:994-1003`. Do not change execution.

## Code Examples

### Verified existing combine logic (SCHED-04 backend — DO NOT change, only document)
```typescript
// Source: src/sub-agents/registry.ts:992-1003 [VERIFIED this session]
const next = nextRunAfter(cronArg, new Date(), effectiveTz)
if (triggerAtArg) {
  const d = new Date(triggerAtArg)
  if (isNaN(d.getTime())) {
    return JSON.stringify({ error: true, message: `Invalid triggerAt date: ${triggerAtArg}` })
  }
  triggerAt = d.toISOString()        // first fire = triggerAt
} else {
  triggerAt = next.toISOString()     // first fire = computed-from-cron
}
cronExpression = cronArg             // cron retained → scheduler repeats after
```
```typescript
// Source: src/scheduler/index.ts:88-91 [VERIFIED this session]
if (schedule.cron) {
  const tz = schedule.cronTimezone ?? this.timezone
  const next = nextRunAfter(schedule.cron, now, tz)
  this.scheduleStore.advanceNextRun(schedule.id, next.toISOString())   // → repeat
}
// → so triggerAt (first fire) + cron (repeat) = start-then-repeat, today.
```

### Verified createOpts assembly (the conditional-assign idiom to mirror)
```typescript
// Source: src/sub-agents/registry.ts:1021-1035 [VERIFIED this session]
const createOpts: import('../db/schedules.js').CreateScheduleOptions = {
  id, headId, kind: 'reminder', agentContext: message,
  runAt: triggerAt ?? undefined, nextRun: triggerAt ?? undefined,
}
if (cronExpression !== null) createOpts.cron = cronExpression
if (conditionsArg !== undefined) createOpts.conditions = conditionsArg   // ← mirror this for new fields
scheduleStore.create(createOpts)
```

### Verified test idioms to extend
```typescript
// Round-trip via store (Source: src/db/schedules.test.ts:39-51 pattern)
store.create({ id, headId:'default', kind:'reminder', agentContext:'x', requiresAck:true, nagIntervalMinutes:60, ... })
const s = store.get(id)
expect(s!.requiresAck).toBe(true)
expect(s!.nagIntervalMinutes).toBe(60)

// Tool-boundary reject (Source: src/sub-agents/agents.test.ts:1282-1288 pattern)
const result = await createReminder.execute({ message:'x', triggerAt:'2099-01-01T09:00:00Z', requiresAck:true }, ctx)
const parsed = JSON.parse(result as string)
expect(parsed.error).toBe(true)
expect(parsed.message).toMatch(/nag interval/i)
```

## State of the Art

Not applicable — this is in-repo extension work, not an ecosystem-tracking domain. No external library currency concerns.

## Validation Architecture

> Nyquist validation is ENABLED (no `.planning/config.json` and no `nyquist_validation` key anywhere in `.planning/` → default-enabled). This section drives VALIDATION.md.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.x (running 2.1.9), `environment: 'node'` [VERIFIED: package.json, run output] |
| Config file | `vitest.config.ts` (unit) + `vitest.config.integration.ts` (integration) [VERIFIED] |
| Quick run command | `npx vitest run src/db/schedules.test.ts && npx vitest run src/sub-agents/agents.test.ts -t buildReminderTools` |
| Full suite command | `npx vitest run` (then `npx tsc --noEmit` for the type gate — SC4) |

### Phase Requirements → Test Map
| Req / SC | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|-------------------|-------------|
| SC1 / ACK-01,02 | `requiresAck:true` + nag fields round-trip via `store.create` → `store.get` | unit (store) | `npx vitest run src/db/schedules.test.ts -t "round-trip"` | ✅ extend `src/db/schedules.test.ts` |
| SC2 / ACK-09 | Legacy reminder JSON (no new fields) reads back with defaults, still due/fires; no crash | unit (store migration) | `npx vitest run src/db/schedules.test.ts -t "legacy"` | ✅ extend `src/db/schedules.test.ts` |
| ACK-09 (D-08) | Migration idempotent / mtime-stable across 3 reads after stamping new fields | unit (store) | `npx vitest run src/db/schedules.test.ts -t "mtime"` | ✅ extend existing mtime test (schedules.test.ts:127) |
| D-03 floor | nag sum < 5 min while `requiresAck:true` → `{ error:true }` | unit (tool boundary) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | ✅ extend buildReminderTools block |
| D-03 ceiling | nag sum > 43200 min → `{ error:true }` | unit (tool boundary) | (same) | ✅ extend |
| D-04 | `requiresAck:true` with no/insufficient nag → `{ error:true }` | unit (tool boundary) | (same) | ✅ extend |
| D-05 | nag slots present, `requiresAck` false/omitted → `{ error:true }` | unit (tool boundary) | (same) | ✅ extend |
| D-01/D-02 | slots (e.g. `nagHours:1` + `nagMinutes:30`) sum to stored `nagIntervalMinutes:90` | unit (tool→store) | (same) | ✅ extend |
| D-07 inert-for-tasks | a `kind:'task'` row created without ack fields defaults `requiresAck:false`, `nagIntervalMinutes:null` | unit (store) | `npx vitest run src/db/schedules.test.ts` | ✅ extend |
| SC3 / SCHED-04 | description no longer says "for one-time reminders only"; documents start-then-repeat | unit (schema/description assertion) | `npx vitest run src/sub-agents/agents.test.ts -t "description"` | ✅ NEW assertion in buildReminderTools block |
| SC4 | type-clean + suite green | type + full suite | `npx tsc --noEmit && npx vitest run` | ✅ existing gates |
| (property order) | inputSchema key order updated for new params | unit (schema) | `npx vitest run src/sub-agents/agents.test.ts -t "property order"` | ⚠️ UPDATE existing test agents.test.ts:1453 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/db/schedules.test.ts src/sub-agents/agents.test.ts` (~1.6s combined; schedules 14 tests ~0.5s, agents reminder subset 13 tests ~1.1s — measured this session).
- **Per wave merge:** `npx tsc --noEmit` + the two files above.
- **Phase gate:** `npx tsc --noEmit && npx vitest run` (full suite) green before `/gsd:verify-work`. (Full suite is the 1400+ test set across the existing files — CI shards it 6×; locally it runs in one process.)

### Wave 0 Gaps
- [ ] None for infrastructure — `src/db/schedules.test.ts` and the `buildReminderTools` describe block in `src/sub-agents/agents.test.ts` already exist with the exact fixtures needed (`getReminderTools()` helper, tmp `ScheduleStore`, legacy-JSON-write pattern). New tests are additions to existing files, not new files.
- [ ] One existing test MUST be updated (not a gap, but a required edit): the inputSchema property-order assertion at `agents.test.ts:1453-1460` will fail once new params are added — update its expected key array.

*No framework install, no new test file, no shared-fixture gap.*

## Security Domain

`security_enforcement` is not configured (no config.json). This phase has a small, low-risk surface, but the relevant control is **input validation at the trust boundary** — the LLM is an untrusted input source for tool args.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Boundary validation in `create_reminder.execute()` — integer-only, non-negative, floor/ceiling on nag sum; reject with `{ error, message }`. Mirrors existing message-length / cron / IANA-timezone validation. [VERIFIED idiom: registry.ts:962-1016] |
| V2 Authentication | no | No auth surface in this phase. |
| V3 Session Management | no | N/A. |
| V4 Access Control | no | Per-head isolation already enforced by the factory closure `headId` (Phase 35 D-09); no new access surface. |
| V6 Cryptography | no | N/A. |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| LLM supplies absurd nag (1-min spam loop / 1000-day) | Denial of Service (self-inflicted via future Phase 38 nag loop) | D-03 floor (5 min) + ceiling (43200 min) reject at the tool boundary — this is exactly why the bounds exist. [CITED: CONTEXT.md D-03] |
| LLM supplies non-integer / negative / NaN slot | Tampering / malformed-state | `Number.isInteger(x) && x >= 0` guard before summing; reject otherwise. |
| Type confusion in the `input` bag | Tampering | Cast-and-validate (`as number | undefined` then runtime check) — never trust the cast alone (consistent with existing `message`/`triggerAt` handling). |

No injection vector (no SQL — JSON file store; no shell; no template). No secrets touched.

## Open Questions

1. **Final stored field name (Claude's discretion per D-02).**
   - What we know: must encode units; D-02 leans `nagIntervalMinutes: number | null`.
   - Recommendation: use `nagIntervalMinutes` — self-documenting, makes Phase 38's `now + minutes*60000` obvious. Planner may choose otherwise but must keep units in the name.
2. **`list_reminders` projection of the two new fields (Claude's discretion).**
   - What we know: `list_reminders.execute` (registry.ts:915-919) currently projects `{ id, message, runAt, cron, createdAt }`. Adding `requiresAck`/`nagIntervalMinutes` is a trivial 2-key addition to the `.map()` — no gotchas, no validation, read-only.
   - Recommendation: **include** (cheap, helps Phase 38 ack flow, no success criterion blocks it). If included, add a one-line assertion to the `list_reminders` test (agents.test.ts:1299).
3. **Whether to fold D-03 floor and D-04 into one check.** Both reject `requiresAck:true && nagSum < 5`. Recommendation: keep distinct error messages so the model gets actionable feedback ("requires a nag interval" vs "must be ≥ 5 minutes"), even if the predicate overlaps. Pure wording — Claude's discretion.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | runtime + tests | ✓ | >=22 (engines) | — |
| typescript (`tsc`) | SC4 type gate | ✓ | 5.6.x | — |
| vitest | test suite | ✓ | 2.1.9 | — |

No external services, tools, or network dependencies. tsc + the two target test files were run green this session.

## Sources

### Primary (HIGH confidence — verified directly this session)
- `src/db/schedules.ts` — `Schedule` (3), `CreateScheduleOptions` (22), `SchedulePatch` (35), `migrateLegacyHeadId` (48), `create` (65), read funnels `get`/`list`/`getDue` (89/97/139), mutators via `this.get` (152/162/171), `deleteAllForHead` (193).
- `src/db/file-store.ts` — `createFileStore`, `writeJsonFile` → `write-file-atomic` (3/55/79).
- `src/sub-agents/registry.ts` — `buildReminderTools` (903), `list_reminders` (909-920), `create_reminder` definition+description (922-953), validation block (955-1016), combine logic (992-1003), `createOpts` (1021-1035), `cancel_reminder` (1040-1061); validation-helper imports (15-16).
- `src/scheduler/index.ts` — `advanceNextRun` from cron after fire (88-91).
- `src/head/activation.ts` — reminder fire branch reads via `scheduleStore.get` (1079-1146).
- `src/head/assembler.ts` — reminder tools surfaced to agents (450-455).
- `src/db/schedules.test.ts` — migration round-trip + mtime-stable idempotency tests (full file, 14 tests, green).
- `src/sub-agents/agents.test.ts` — `buildReminderTools` describe block (1252-1359), Phase 35 factory-headId block (1558-1616), property-order test (1453-1460), 13 reminder tests green.
- `tsconfig.json` — `moduleResolution:bundler`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (5/9/10/11).
- `package.json` — scripts, vitest ^2.1.0, typescript ^5.6.0, node >=22.
- Live runs: `npx tsc --noEmit` exit 0; `schedules.test.ts` 14/14; `agents.test.ts -t buildReminderTools` 13/13.

### Secondary (project docs — settled decisions, treated as given)
- `.planning/phases/37-schema-tool-params/37-CONTEXT.md` — D-01..D-10.
- `.planning/REQUIREMENTS.md` — ACK-01/02/09, SCHED-04, Out-of-Scope rows.
- `.planning/ROADMAP.md` — Phase 37 goal + SC1-4 (SC1 example flagged stale).
- `.planning/STATE.md` — Phase 35 D-02/D-03 migration-funnel decisions.
- `.planning/seeds/SEED-001-ack-required-reminders.md` — verified-facts + breadcrumbs (all confirmed accurate this session).

### Tertiary (LOW confidence)
- None. All claims verified against source.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Reminder JSON files live under `{workspacePath}/data/schedules/` (dir name per AGENTS.md; historical references say `schedules/`). | Runtime State Inventory | Low — exact dir doesn't change the code; the lazy stamp works regardless of path. Planner needn't act on the literal path. |
| A2 | The workspace currently contains pre-Phase-37 reminder JSON files that will hit the migration. | Runtime State Inventory / SC2 | Low — if none exist, SC2's legacy test still proves the contract via synthetic legacy JSON (the existing test pattern writes its own legacy file). |

**Both assumptions are non-blocking** — the code behavior is identical whether or not legacy files happen to exist, because the migration is exercised by tests writing synthetic legacy JSON (schedules.test.ts:92-125 pattern).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all in-repo, zero new deps, verified by reading the modules.
- Architecture / patterns: HIGH — migration + validation idioms read directly and confirmed test-pinned.
- Line-number verification: HIGH — every CONTEXT.md citation checked against current source (one harmless range note: function ends at 1063, not 1038).
- Pitfalls: HIGH — `exactOptionalPropertyTypes` / mtime-idempotency / property-order test risks confirmed against actual config + tests.
- Validation architecture: HIGH — framework, commands, and timings measured by running the suites this session.

**Research date:** 2026-05-23
**Valid until:** 2026-06-22 (stable in-repo domain; only invalidated if Phase 36 or an unrelated change edits `schedules.ts`/`registry.ts` before planning).
