---
phase: 32-dashboard-head-selector
plan: "01"
subsystem: dashboard-backend-tests
tags: [tdd-red, dashboard, head-selector, backend-tests]
dependency_graph:
  requires: []
  provides: [heads-test-red, messages-filter-test-red]
  affects: [32-02-implementation]
tech_stack:
  added: []
  patterns: [real-express-test, getFreePort, runMigrations-in-test, raw-sql-seeding]
key_files:
  created:
    - src/dashboard/routes/heads.test.ts
    - src/dashboard/routes/messages.test.ts
  modified: []
decisions:
  - "Used raw SQL INSERT for work-head message seeding because MessageStore.append() hardcodes head_id='default' (no headId parameter); this matches the established insertWithHead() pattern in src/db/db.test.ts and is the correct approach until Plan 02 adds the write-side headId param"
  - "tsc --noEmit exits with one error (Cannot find module './heads.js') — this is the expected RED state for heads.test.ts; messages.test.ts compiles cleanly"
metrics:
  duration: ~4 minutes
  completed_date: "2026-05-12"
  tasks_completed: 2
  files_created: 2
---

# Phase 32 Plan 01: Dashboard Head Selector RED Tests Summary

Wave 0 (TDD RED): Created the two backend test files that define the acceptance gate for Plan 02's implementation. Both files are in RED state — heads.test.ts fails on module resolution (./heads.js doesn't exist yet); messages.test.ts fails on assertion mismatches (handler hardcodes 'default', ignores ?head= param).

## What Was Built

### `src/dashboard/routes/heads.test.ts`
- Three test cases covering: multi-head list response shape, single-head fallback, channel-stripping defense
- Imports `createHeadsRouter` from `./heads.js` (does not exist — RED via module-not-found)
- Auth bypass: `res.locals['authenticated'] = true` (matching settings.test.ts pattern)
- Defense-in-depth test asserts `botToken`/`channels`/`SECRET-TOKEN` never appear in response body

### `src/dashboard/routes/messages.test.ts`
- Five test cases covering: `?head=work` filter, `?head=default`, no-param default, `?head=nonexistent` empty list, array-param type guard
- Uses `runMigrations(db, MIGRATIONS_DIR)` on a fresh tmp-file DB — ensures 005_multi_head.sql has run and `head_id` column exists
- Seeds messages via raw SQL INSERT (see Deviations section)
- RED: 2/5 tests fail (head=work, head=nonexistent); 3/5 pass (head=default, no-param, array-param)

## MessageStore Signatures (for Plan 02 executor)

```typescript
// Constructor
new MessageStore(db: DatabaseSync, eventBus?: DashboardEventBus)

// Write (current — Plan 02 must extend this to accept headId):
append(msg: Message): void  // always writes head_id='default' via SQL DEFAULT

// Read (already head-scoped):
getAll(headId: string): Message[]
getRecent(headId: string, tokenBudget: number): Message[]
```

The `stmtInsert` statement in MessageStore does NOT include `head_id` in its column list, so inserts always default to `'default'`. Plan 02 needs to either:
1. Add `headId` parameter to `append()` and update `stmtInsert` to include `head_id`, OR
2. Add a separate `appendForHead(msg: Message, headId: string)` method

## Test Database Setup (for Plan 02 executor)

```typescript
import { initDb } from '../../db/index.js'
import { runMigrations } from '../../db/migrate.js'
import * as url from 'node:url'
import * as path from 'node:path'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../sql')  // from src/dashboard/routes/

const db = initDb(dbPath)
runMigrations(db, MIGRATIONS_DIR)
const store = new MessageStore(db)
```

`initDb` does NOT run migrations — `runMigrations` must be called separately with the path to the `sql/` directory.

## RED State Verification

| Test File | Vitest Result | Failure Reason |
|-----------|---------------|----------------|
| heads.test.ts | FAIL (0/3) | `Cannot find module './heads.js'` — module resolution error |
| messages.test.ts | FAIL (2/5 failing) | `?head=work` returns default-head content; `?head=nonexistent` returns default-head content |

## Deviations from Plan

### Auto-adapted — MessageStore.add() does not exist

**Found during:** Task 2 (reading src/db/messages.ts)

**Issue:** Plan template called `store.add(makeText('...'), 'work')` but `MessageStore` has no `add()` method. The write method is `append(msg: Message)` which hardcodes `head_id='default'` via SQL DEFAULT column (stmtInsert does not include `head_id` in its column list).

**Fix:** Used raw SQL INSERT pattern `(id, kind, role, content, injected, head_id, created_at)` matching the established `insertWithHead()` helper in `src/db/db.test.ts`. This exercises the same schema that `getAll(headId)` queries, ensuring the head_id filter is tested end-to-end. The `MessageStore` read path is still used via `createMessagesRouter(store)`.

**Files modified:** `src/dashboard/routes/messages.test.ts` (seeding approach only)

**No separate commit** — adjustment made inline within Task 2 before first commit.

## TypeScript Check

`npx tsc --noEmit` exits with 1 error:
```
src/dashboard/routes/heads.test.ts(5,35): error TS2307: Cannot find module './heads.js'
```
This is the expected RED state. `messages.test.ts` compiles cleanly (no errors in isolation).
Plan 02 fixes this by creating `src/dashboard/routes/heads.ts`.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| Task 1 — heads.test.ts RED | 63086e0 | src/dashboard/routes/heads.test.ts |
| Task 2 — messages.test.ts RED | 361ed52 | src/dashboard/routes/messages.test.ts |

## Known Stubs

None. Both files are pure test files with no stub data flowing to UI.

## Self-Check: PASSED
