---
phase: 44-multi-head-task-delivery
reviewed: 2026-05-24T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - dashboard/src/lib/api.ts
  - dashboard/src/pages/SchedulesPage.tsx
  - dashboard/src/types/api.ts
  - sql/008_agents_deliver_to_head_ids.sql
  - src/dashboard/routes/schedules.test.ts
  - src/dashboard/routes/schedules.ts
  - src/db/agents.ts
  - src/db/schedules.test.ts
  - src/db/schedules.ts
  - src/head/activation.ts
  - src/sub-agents/local.ts
  - src/types/agent.ts
  - tests/integration/multi-head-task-delivery.test.ts
findings:
  critical: 2
  warning: 4
  info: 3
  total: 9
status: remediated
remediation:
  fixed: [CR-01, CR-02, WR-02]
  deferred: [WR-01, WR-03, WR-04, IN-01, IN-02, IN-03]
---

> **Remediation (2026-05-24, during execute-phase):**
> - **CR-01 fixed** — `suspendAsQuestion` returns `'completed'|'suspended'`; caller exits the loop on force-completion (commit `fix(44): terminate run-loop after scheduled force-completion`). Regression locked in via a new `activeTaskCount` assertion in the integration suite (Test 4), which now runs in ~0.3s instead of ~5.3s.
> - **CR-02 fixed** — `commitEdit` now folds delivery-set dirtiness into both "nothing changed" guards (commit `fix(44): persist delivery-set-only task edit`).
> - **WR-02 fixed** — `rowToState` parses `deliver_to_head_ids` defensively, degrading a corrupt row to owner-only (commit `fix(44): defensively parse deliver_to_head_ids column`). This also subsumes WR-04's intent (settlement is now asserted).
> - **Deferred (non-blocking quality follow-ups, do not affect phase must-haves):** WR-01 (strip owner from stored set — fan-out already dedups, so delivery is correct), WR-03 (single-row-read PATCH refactor), IN-01/IN-02/IN-03 (redundant client dedup, stale add-form selection on owner change, SQL comment wording).


# Phase 44: Code Review Report

**Reviewed:** 2026-05-24T00:00:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 44 fans out a scheduled task's `agent_completed` event to every head in the
deduped set `[headId, ...deliverToHeadIds]`, adds a scheduled-question-suppression gate,
persists a new JSON column (`agents.deliver_to_head_ids`) plus a `Schedule.deliverToHeadIds`
field, and wires validation through the schedules POST/PATCH routes and the dashboard.

The **core fan-out is correct**: both completion sites (`completeAgent` and the `ctx.complete`
closure) use the same `[...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]` dedup,
`agent_failed` stays owner-only, the resume path now re-threads `deliverToHeadIds`, and the
`agent_completed` payload carries no delivery set so a delivery head cannot re-fan-out. The
store's empty-as-absent contract (`length ? {...} : {}` on create, `delete` on empty PATCH) is
consistent across `create`/`update`/route, and the SQL column mirrors the 007 pattern.

However, the **scheduled-question-suppression gate introduces a forever-spinning agent loop**
(CR-01), and the **dashboard task-edit modal silently drops a delivery-set-only change** (CR-02).
The integration test's `awaitAll` timeout masks CR-01 rather than catching it. Several
secondary validation/consistency gaps are noted below.

## Critical Issues

### CR-01: Force-completed scheduled agent leaks a forever-spinning loop (timer/promise leak + "completed but loop alive")

**File:** `src/sub-agents/local.ts:951-955` (caller) and `src/sub-agents/local.ts:997-1004` (`suspendAsQuestion` D-06 gate)
**Issue:**
The new D-06 gate makes `suspendAsQuestion` *force-complete* a scheduled agent instead of
suspending it:

```ts
private suspendAsQuestion(agentId, question, options, history): void {
  if (options.trigger === 'scheduled') {
    this.completeAgent(agentId, question, options, history)   // marks 'completed', enqueues, returns
    return
  }
  this.agentStore.suspend(...)
  ...
}
```

But the only caller still treats every `question` outcome as a *suspension*:

```ts
if (stewardResult.type === 'question') {
  this.suspendAsQuestion(agentId, output, options, history)
  isSuspended = true     // ← wrong for the force-completed scheduled path
  continue               // ← re-enters the loop
}
```

For a scheduled agent the row is now `completed`, yet the loop is re-entered with
`isSuspended = true`. At the top of the loop (`local.ts:753-757`):

```ts
if (isSuspended) {
  await waitForInbox(emitter, this.pollIntervalMs)
  continue
}
```

A scheduled agent has no human to ever send a signal, so the inbox stays empty and the loop
spins on `waitForInbox` every `pollIntervalMs` *forever*. Consequences:
- The task `Promise` in `this.tasks` never resolves, so the `.finally` cleanup at
  `local.ts:227-231` never runs — `emitters`, `tasks`, and `abortControllers` entries leak
  for the agent, and a `setTimeout` timer is rearmed indefinitely.
- These accumulate once per scheduled task whose output the completion steward classifies as a
  "question" — a steady leak on any server running scheduled tasks.
- At shutdown, `agentRunner.awaitAll(5_000)` (`src/index.ts:775`) cannot resolve early because
  the leaked task never settles, so shutdown always burns the full 5s; and the stuck agent is
  not in `getByStatus('running')` (it's `completed`), so the retract sweep never touches it.

The integration test (Test 4) hides this: it asserts on `status === 'completed'` (which is set)
and uses `awaitAll(5000)` which is a `Promise.race` against a timeout, so the never-resolving
task is silently swallowed by the race.

**Fix:** After force-completion the loop must terminate, not re-enter as suspended. Make the
caller honor the completed status, e.g.:

```ts
if (stewardResult.type === 'question') {
  this.suspendAsQuestion(agentId, output, options, history)
  if (this.agentStore.get(agentId)?.status === 'completed') return  // D-06 force-completed
  isSuspended = true
  continue
}
```

Or have `suspendAsQuestion` return a discriminator (`'completed' | 'suspended'`) and branch on
it. Either way add a regression test that asserts the runner's task promise *resolves* for the
force-completed scheduled case (e.g. `await Promise.race([task, sleep]); expect(settled).toBe(true)`)
rather than only checking final status.

### CR-02: Dashboard task-edit silently drops a delivery-set-only change

**File:** `dashboard/src/pages/SchedulesPage.tsx:134-149` (`ScheduleRow.commitEdit`)
**Issue:**
`commitEdit` for a task schedule sends `deliverToHeadIds` in the PATCH payload, but the
early-return "nothing changed" guards do **not** include delivery-set dirtiness:

```ts
if (schedule.cron !== null) {
  if (trimmed === schedule.cron && conditionsUnchanged && agentContextUnchanged) { setEditing(false); return }
  updateMutation.mutate({ cron: trimmed, ..., deliverToHeadIds: editDeliverToHeadIds })
  return
}
const runAtUnchanged = d.toISOString() === schedule.runAt
if (runAtUnchanged && conditionsUnchanged && agentContextUnchanged) { setEditing(false); return }
updateMutation.mutate({ runAt: d.toISOString(), ..., deliverToHeadIds: editDeliverToHeadIds })
```

If the user opens the edit modal and changes *only* the "Also deliver to" multi-select (leaving
cron/runAt, conditions, and prompt-addition untouched), both guards evaluate true, the modal
closes via `setEditing(false); return`, and **no PATCH is sent** — the delivery-set edit is lost.
This is the exact bug class the sibling `ReminderRow.commitEdit` explicitly fixed for ack/nag
(see its comment at `SchedulesPage.tsx:588-591`: "an ack-only ... edit ... closes the modal
without sending a PATCH and the change is lost"). The task row regressed the same way.

**Fix:** Fold delivery-set dirtiness into both guards:

```ts
const deliverUnchanged =
  JSON.stringify([...editDeliverToHeadIds].sort()) ===
  JSON.stringify([...(schedule.deliverToHeadIds ?? [])].sort())
// cron branch:
if (trimmed === schedule.cron && conditionsUnchanged && agentContextUnchanged && deliverUnchanged) { setEditing(false); return }
// runAt branch:
if (runAtUnchanged && conditionsUnchanged && agentContextUnchanged && deliverUnchanged) { setEditing(false); return }
```

## Warnings

### WR-01: POST route never rejects/strips the owner head appearing in `deliverToHeadIds`

**File:** `src/dashboard/routes/schedules.ts:87-115`
**Issue:**
The POST handler validates `deliverToHeadIds` entries against known heads and dedups within the
array, but does not exclude (or reject) the *owner* `headId` if the client includes it. A
schedule created with `headId:'a', deliverToHeadIds:['a','b']` persists `deliverToHeadIds:['a','b']`.
Fan-out still produces the correct result because `[...new Set([this.headId, ...])]` dedups at
delivery — so this is not a delivery-correctness bug — but the stored set is misleading and the
dashboard owner-pill/dedup display logic (`SchedulesPage.tsx:169`) then has to re-dedup. The
PATCH path has the identical gap (`schedules.ts:323-343`).
**Fix:** After dedup, drop the owner: `deliverToHeadIds = [...new Set(ids)].filter(h => h !== headId)`
(POST) and the analogous filter on PATCH (where the owner is the stored `existing.headId`). Then
treat the resulting empty array as absent, matching the existing empty-as-absent contract.

### WR-02: `rowToState` will throw and crash the read path if `deliver_to_head_ids` is ever non-JSON

**File:** `src/db/agents.ts:49`
**Issue:**
`deliverToHeadIds: JSON.parse(row.deliver_to_head_ids) as string[]` is unguarded. The migration's
`NOT NULL DEFAULT '[]'` and the `create` path (`JSON.stringify(...)`) keep the column valid today,
so this is not currently reachable — but every other nullable string field in `rowToState` is
defensively guarded, and a single hand-edited row or a future writer that forgets to stringify
would throw inside `JSON.parse`, taking down `get`/`getActive`/`getByStatus`/`getRecent` (all map
through `rowToState`). A corrupt row should degrade to owner-only, not crash agent listing.
**Fix:** Parse defensively:

```ts
let deliverToHeadIds: string[] = []
try { const p = JSON.parse(row.deliver_to_head_ids); if (Array.isArray(p)) deliverToHeadIds = p as string[] }
catch { /* corrupt column → owner-only */ }
```

### WR-03: PATCH `deliverToHeadIds` validation runs after cron/ack mutations are staged but the route still re-reads the row 3x; 404-after-partial-validation ordering is fragile

**File:** `src/dashboard/routes/schedules.ts:193-346`
**Issue:**
The PATCH handler stages `patch.cron`/`patch.nextRun`/`patch.requiresAck`/`patch.nagIntervalMinutes`
*before* it validates `deliverToHeadIds` (lines 323-344), and the `deliverToHeadIds` block is the
first place a missing row yields a 404 (`if (!existing) { res.status(404)... }`). Because nothing
is persisted until the single `scheduleStore.update(id, patch)` at line 346, this happens to be
safe today (no partial write). But the ordering is brittle: any future change that persists earlier
(e.g. a `markSkipped` side-effect) would let a doomed-to-404 request mutate the row first. It also
calls `scheduleStore.get(id)` up to three times (cron recompute, ack-off, deliverTo) for one
request. Recommend reading the row once at the top, validating all fields against that snapshot,
then issuing a single update. (Flagged as consistency/robustness, not a live data-loss bug.)
**Fix:** Hoist a single `const existing = scheduleStore.get(id); if (!existing) return 404` to the
top of the handler and reuse it for the cron-timezone, ack-off, and deliverTo branches.

### WR-04: Integration test `awaitAll`-based assertions mask non-termination

**File:** `tests/integration/multi-head-task-delivery.test.ts:240,286,322,361`
**Issue:**
Every test does `await runner.awaitAll(5000)` then asserts on DB state. `awaitAll` is
`Promise.race([allSettled(tasks), sleep(timeoutMs)])` (`local.ts:334-341`), so a task that never
settles (CR-01) is silently tolerated — the test passes despite a leaked loop, and adds a hidden
5s wall-clock cost to Test 4. The phase's own header promises the suite will "fail … [if a
refactor] removes the scheduled-question gate," but it cannot detect the gate *leaking* because it
never asserts task settlement.
**Fix:** For the question-suppression test (Test 4), assert the spawned task promise actually
resolves (capture the promise via a runner hook or `awaitAll` with a *short* timeout and assert it
returns before the timeout), not just that `status === 'completed'`.

## Info

### IN-01: Owner-pill dedup logic duplicated between server and client

**File:** `dashboard/src/pages/SchedulesPage.tsx:169`
**Issue:** `[schedule.headId, ...(schedule.deliverToHeadIds ?? [])].filter((v,i,a) => a.indexOf(v) === i)`
re-implements the same dedup the runner does at fan-out and the routes do on persist. With WR-01
fixed (owner stripped on persist), this client-side filter becomes redundant. Low priority.

### IN-02: Stale delivery-set selection survives an owner change in the add form

**File:** `dashboard/src/pages/SchedulesPage.tsx:312-408`
**Issue:** In `AddScheduleForm`, changing the `headId` select does not prune any already-selected
`deliverToHeadIds` that now equal the new owner. The multi-select only *filters its options* by the
current owner, but previously-selected values persist in state. Harmless at delivery (dedup), and
moot once WR-01 strips the owner server-side, but the transient UI state is inconsistent. Consider
pruning `deliverToHeadIds` on owner change.

### IN-03: SQL comment over-claims "single running agent" read scope

**File:** `sql/008_agents_deliver_to_head_ids.sql:7-8`
**Issue:** The comment says the column "is read only at completion fan-out for the single running
agent, never a query filter." It is actually read on *every* `rowToState` call — i.e. for every
`get`/`getActive`/`getByStatus`/`getRecent` row, not only at completion. The "no index" decision is
still correct (it's never a predicate), but the rationale text is inaccurate and could mislead a
future reader into assuming the column is rarely deserialized (cf. WR-02). Tighten the comment.

---

_Reviewed: 2026-05-24T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
