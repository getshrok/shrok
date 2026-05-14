---
phase: 35-per-head-scheduling
reviewed: 2026-05-14T07:32:45Z
depth: standard
files_reviewed: 32
files_reviewed_list:
  - dashboard/src/lib/api.ts
  - dashboard/src/pages/SchedulesPage.tsx
  - dashboard/src/types/api.ts
  - scripts/eval/scenarios/proactive-decision-realistic.ts
  - scripts/eval/scenarios/proactive-decision.ts
  - scripts/eval/scenarios/schedule-management.ts
  - src/dashboard/routes/heads.test.ts
  - src/dashboard/routes/heads.ts
  - src/dashboard/routes/schedules.test.ts
  - src/dashboard/routes/schedules.ts
  - src/dashboard/server.ts
  - src/db/db.test.ts
  - src/db/schedules.test.ts
  - src/db/schedules.ts
  - src/head/activation.test.ts
  - src/head/activation.ts
  - src/head/head.test.ts
  - src/index.ts
  - src/scheduler/index.ts
  - src/scheduler/scheduler.test.ts
  - src/sub-agents/agents.test.ts
  - src/sub-agents/local.ts
  - src/sub-agents/registry.ts
  - src/sub-agents/tool-surface.test.ts
  - src/sub-agents/tool-surface.ts
  - src/system.ts
  - tests/integration/head.test.ts
  - tests/integration/multi-head-scheduling.test.ts
  - tests/scenarios/multi-message-batching.test.ts
  - tests/unit/activation.test.ts
findings:
  critical: 0
  warning: 2
  info: 6
  total: 8
status: issues_found
---

# Phase 35: Code Review Report

**Reviewed:** 2026-05-14T07:32:45Z
**Depth:** standard
**Files Reviewed:** 32 (30 listed + 2 ancillary read for context: `src/db/file-store.ts`, phase context docs)
**Status:** issues_found

## Summary

Phase 35 threads `headId` through the scheduling pipeline cleanly. The implementation closely follows the patterns established in Phases 29/33/34 — single-table-plus-discriminator at the data layer, factory closure capture for tool wiring, lazy migration on first read, and cascade-on-delete for head removal. Test coverage is strong: schedules.test.ts covers store-level filtering and migration idempotence; scheduler.test.ts pins headId stamping on enqueue; heads.test.ts covers cascade DELETE; activation.test.ts covers the D-07 first-channel fallback; and `multi-head-scheduling.test.ts` is a self-contained architectural regression that closes the cross-head leak.

The two Warning items are PATCH-route defects in `src/dashboard/routes/schedules.ts` that allow callers to corrupt schedule rows via runAt — one is pre-existing (carried over from before this phase) but is visible in the route's new shape, and one is a Phase 35 surface area decision about how the `'headId' in body` guard interacts with explicit `undefined`. Info items capture lower-priority concerns (in-place mutation, transactional ordering, runtime-null cast carry-over, defensive-check breadth).

No critical issues. No security regressions. No new attack surface — secrets continue to be masked, route auth is preserved on every handler, and head-id validation against `resolveCurrentHeads()` happens before any state mutation in POST.

## Warnings

### WR-01: PATCH /api/schedules/:id can set `runAt` to an empty string, producing a half-valid schedule

**File:** `src/dashboard/routes/schedules.ts:128-135`
**Issue:** The PATCH handler validates `runAt` with `typeof runAt === 'string'` and then guards `isNaN(new Date(runAt).getTime())` only when `runAt` is truthy. If the client sends `runAt: ''`, both checks pass and the patch sets `patch.runAt = ''` (an empty string) while skipping the `nextRun` recompute. The schedule row on disk ends up with `runAt: ''` — neither a valid ISO timestamp nor null — which downstream code (`getDue()` filters on `s.nextRun !== null && s.nextRun <= now`, but `lastRun`/`runAt` are surfaced to the UI verbatim) treats inconsistently. This is largely pre-existing behavior but was not exercised by the prior test suite and is now reachable via the dashboard SchedulesPage `commitEdit()` path if `editValue.trim()` becomes empty after the existing `!trimmed` guard fires (which currently sets `setEditing(false)` and returns — so the UI doesn't reach this case today, but the route is callable directly).

**Fix:**
```ts
if (typeof runAt === 'string') {
  if (!runAt) {
    res.status(400).json({ error: 'runAt cannot be empty (use cron to make a schedule recurring, or send a valid ISO timestamp)' })
    return
  }
  if (isNaN(new Date(runAt).getTime())) {
    res.status(400).json({ error: 'Invalid runAt date' })
    return
  }
  patch.runAt = runAt
  patch.nextRun = new Date(runAt).toISOString()
}
```

### WR-02: `'headId' in body` guard in PATCH rejects requests where headId is explicitly `undefined`

**File:** `src/dashboard/routes/schedules.ts:116-119`
**Issue:** The reassignment guard `'headId' in (req.body as Record<string, unknown>)` returns true whenever the property key is present on the body object, even if its value is `undefined`. This causes a 400 for clients (or future dashboard code) that idiomatically construct request bodies with the field always present:
```ts
const patch = { enabled, headId: undefined }
api.schedules.update(id, patch)  // 400 — but no reassignment was intended
```
JSON.stringify drops `undefined` properties so this won't affect real network traffic from typical fetch callers, but in-process callers (tests, helper functions, or any future server-side code that calls the route via a test client) can trip it. The agent-side `update_schedule` check at `src/sub-agents/registry.ts:847` uses the same `'in'` pattern with the same minor over-broadness, but agents are unlikely to construct that shape.

**Fix:**
```ts
const bodyObj = (req.body !== null && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {}
if (bodyObj['headId'] !== undefined) {
  res.status(400).json({ error: 'headId cannot be reassigned via PATCH. To move a schedule to a different head, delete and recreate.' })
  return
}
```
The semantics shift from "key present" to "value present" — defensible because the only way to reach this code with `headId: undefined` is a programmer mistake, not a reassignment attempt.

## Info

### IN-01: `migrateLegacyHeadId` mutates its `raw` argument in place

**File:** `src/db/schedules.ts:48-56`
**Issue:** The helper mutates the input object (`obj['headId'] = 'default'`) and then returns `{ data: obj as unknown as Schedule }`. Because `this.store.list()` and `this.store.get()` return references that callers may pass elsewhere, this in-place mutation can surprise readers who expect the migration step to be a pure transformation. In practice it's safe — the caller immediately writes the migrated record back — but the convention in the rest of the codebase (e.g., `maskChannel`, `migrateChannelConfig` patterns) is to construct a new object.
**Fix:** Either rename to make the side effect explicit (`stampLegacyHeadIdInPlace`) or return a fresh object:
```ts
function migrateLegacyHeadId(raw: unknown): { migrated: boolean; data: Schedule | null } {
  if (raw === null || typeof raw !== 'object') return { migrated: false, data: null }
  const obj = raw as Record<string, unknown>
  if ('headId' in obj) return { migrated: false, data: obj as unknown as Schedule }
  return { migrated: true, data: { ...obj, headId: 'default' } as unknown as Schedule }
}
```

### IN-02: `DELETE /api/heads/:id` cascade runs after the SQL transaction commits — partial-failure recovery is documented but un-asserted

**File:** `src/dashboard/routes/heads.ts:289-308`
**Issue:** The handler runs the SQL transaction (messages/queue/app_state wipe) first, then calls `scheduleStore.deleteAllForHead(id)`, then rewrites `config.json`. The inline comment explains this ordering is the T-35-12 mitigation (FS deletes are non-transactional but idempotent). However, if `scheduleStore.deleteAllForHead` throws partway through the loop (e.g., disk full mid-delete), the response surfaces a 500 with no detail about which schedules survived, and the user's mental model — "head is deleted" — diverges from disk reality. The mitigation is "re-run DELETE" but the head row will be gone from config.json (it isn't yet at this point — but if the cascade succeeds and config.json write fails, the head appears alive in the API but its schedules are gone).
**Fix:** Either wrap `scheduleStore.deleteAllForHead` in its own try/catch and surface per-schedule failure counts in the response (additive to D-17's `deletedSchedules`/`deletedReminders`), or document that the cleanup endpoint exists to mop up orphaned schedules after a partial cascade.

### IN-03: GET-only stub in `server.ts` wires `null` casts for `db`/`queue`/`scheduleStore`

**File:** `src/dashboard/server.ts:179-194`
**Issue:** When the dashboard server is constructed without `db` or `queue`, the heads router is still mounted but with `db: null as unknown as DatabaseSync`, `queue: null as unknown as QueueStore`, and now `scheduleStore: null as unknown as ScheduleStore`. The comment explains the intent (GET-only path; mutations will NPE if called), but Phase 35 widens the surface — any code path that calls `deps.scheduleStore.deleteAllForHead` against this stub will crash, including the DELETE handler. This is a pre-existing pattern but is worth flagging as the cascade widens the blast radius.
**Fix:** Either split the heads router into a GET-only sub-router that doesn't require mutating deps, or assert at server start that GET-only mode disables DELETE/POST/PATCH explicitly via a route guard (`router.delete('/:id', (_req, res) => res.status(503).json({ error: 'head mutation requires a configured db' }))`). Either change is larger than this phase; a one-line `if (!deps.db || !deps.queue || !deps.scheduleStore) { res.status(503); return }` at the top of the cascade-running handlers is the minimal hardening.

### IN-04: `runAt` value not echoed back consistently in PATCH response shape

**File:** `src/dashboard/routes/schedules.ts:128-135` (PATCH) vs `src/db/schedules.ts:116-132` (update)
**Issue:** When PATCH receives `runAt`, it sets `patch.runAt` and `patch.nextRun` separately, but `ScheduleStore.update` does not normalize the two — if `runAt` is set but the client also sends a `cron` value, the cron branch overwrites `nextRun` (line 146) but does not clear `runAt`. The resulting row carries both a cron and a runAt, which is a contradictory state (`Schedule.cron` and `Schedule.runAt` are documented as mutually exclusive — see `src/db/schedules.ts:8-9`).
**Fix:** When `cron` is set in PATCH, also send `patch.runAt = null`. When `runAt` is set, also send `patch.cron = null`. Mirrors the create-time invariant.

### IN-05: `buildScheduleTools` import comment in `tool-surface.test.ts` audit grep is brittle

**File:** `src/sub-agents/tool-surface.test.ts:111-119`
**Issue:** The test reads `tool-surface.ts` and slices `source.slice(source.indexOf('function buildSkillsListing'), source.indexOf('function buildSkillsListing') + 1200)` to assert `unifiedLoader` doesn't appear in `buildSkillsListing`. If `buildSkillsListing` grows beyond ~1200 chars or another function is inserted between it and the next 1200-char window, this assertion silently changes scope. The audit is valuable but fragile.
**Fix:** Use a more durable scope marker — read the source, locate the `function buildSkillsListing(` start, then slice up to the next `\nfunction ` at the top level:
```ts
const startIdx = source.indexOf('function buildSkillsListing')
const endIdx = source.indexOf('\nfunction ', startIdx + 1)
const listingBlock = source.slice(startIdx, endIdx >= 0 ? endIdx : startIdx + 1200)
expect(listingBlock).not.toContain('unifiedLoader')
```

### IN-06: `headColor` palette length assumed >0 — silent crash if the array is emptied

**File:** `dashboard/src/pages/SchedulesPage.tsx:46-52`
**Issue:** `HEAD_COLORS[hashHeadId(id) % HEAD_COLORS.length]!.bg` uses a non-null assertion. If a future refactor empties `HEAD_COLORS`, modulo-by-zero would yield `NaN`, the index lookup returns `undefined`, and the `!.bg` access throws at render time, crashing the SchedulesPage instead of falling back gracefully. The palette currently has 5 entries hardcoded.
**Fix:** Add a fallback:
```ts
function headColor(id: string): string {
  const palette = HEAD_COLORS.length > 0 ? HEAD_COLORS : [{ bg: '#3f3f4666', border: '#71717a' }]
  return palette[hashHeadId(id) % palette.length]!.bg
}
```
Defensive; not worth blocking a merge over.

---

_Reviewed: 2026-05-14T07:32:45Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
