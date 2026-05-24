# Phase 44: Multi-head task delivery - Context

**Gathered:** 2026-05-24
**Status:** Ready for planning

> Context gathered conversationally (discuss-phase skipped by operator choice). The
> design space was explored against the live codebase before scoping; the decisions
> below are locked.

<domain>
## Phase Boundary

Today a scheduled **task** is owned by exactly one head. To report a task's result to
more than one head you must create N copies of the schedule — which runs the work N times.
This phase makes a scheduled task **run once and deliver its result to a set of heads**.

The enabling insight (verified against the code): a scheduled task's execution is already
**head-agnostic**. The spawned agent gets only the task body as its prompt (no head history
is passed — `getHistory` wiring exists only for the head's manual `spawn_agent` tool, not the
scheduled path), identity is **global** (`identityDir = config.identityDir`, a single dir
shared by all heads — not per-head), and the agent's tool/LLM execution never reads `headId`.
The only thing `headId` does for a scheduled task is **routing/delivery**: the per-head
`LocalAgentRunner` stamps `this.headId` on the `agent_completed` event at completion, and that
head's activation loop relays + delivers to its own channel. So "deliver to many heads" =
"fan out the completion event," not "re-run the work."

**In scope (tasks only):**
- A new opt-in **delivery set** on task schedules. Absent ⇒ today's exact single-head behavior.
- The delivery set travels with the spawned agent (persisted), so a one-time task's schedule
  row can be deleted at fire time (as it is today) and the set still survives to completion.
- `completeAgent` **fans out** `agent_completed` to each head in the delivery set (deduped),
  so each head independently runs its own relay/work-summary steward and delivers to its own
  channel. **The agent runs once.**
- Scheduled agents **never suspend-as-question** — force completion regardless of the
  completion-steward's `question` classification (there is no human attached to a scheduled
  run to answer). This also removes the only mid-execution head-routing ambiguity multi-head
  would have introduced.
- API + dashboard support to pick the delivery set when creating/editing a **task** schedule.

**Out of scope (do NOT build here):**
- **Anything touching reminders.** Reminders stay single-head: no `deliverToHeadIds`, no
  multi-select in the reminder form, no schema/migration change to the reminder path. (If a
  user wants a reminder on two heads, they make two reminders — by explicit decision.)
- **Ack-required reminders across heads** — N/A (reminders are single-head) and explicitly
  rejected: `ackPending`/nag is single-row state that can't represent independent per-head acks.
- **Agent-side multi-head targeting.** The `create_schedule` agent tool stays single-head
  (deferred — D-07). Multi-head is dashboard/API-only for v1.
- **Reassigning the owner head** via PATCH — the existing Phase 35 D-13 ban stands
  (delete-and-recreate to move the owner). *Editing the delivery set* is allowed (D-08).

</domain>

<decisions>
## Implementation Decisions

### D-01 — Tasks only; reminders are completely untouched
Scope is `kind: 'task'` schedules. The reminder code path, schema, UI form, and ack/nag
machinery do not change. No multi-select for reminders. Rationale: reminders deliver a fixed
message (no work to dedupe), so fan-out has no value; per-head reminders are trivially made
as separate reminders.

### D-02 — Additive optional field; absent = today's behavior
Add an optional delivery set to the `Schedule` record (working name `deliverToHeadIds: string[]`).
- **Absent / empty ⇒ behaves exactly as a single-head task today** (delivery to the owner only).
- Migration is trivial: extend the existing `migrateLegacySchedule` funnel so the field is
  simply absent on legacy rows (no value to backfill). Respect `exactOptionalPropertyTypes`
  (omit the key rather than set `undefined`) and `noUncheckedIndexedAccess`.
- Field name, and whether to model it as "additional heads" vs "the full delivery set incl.
  owner," are Claude's discretion — but the **owner head is always implicitly included** (see D-03).

### D-03 — Owner head spawns; delivery set = `[headId, ...deliverToHeadIds]` deduped
The schedule keeps its existing single `headId` as the **owner**: the scheduler still enqueues
the `schedule_trigger` to `schedule.headId`, that head's activation loop processes it in
`handleScheduleTrigger`, and the agent spawns under that head (the spawn site is functionally
arbitrary since execution is head-agnostic, but the owner is the natural, already-wired choice).
The effective **delivery set** is the owner plus the extra heads, **deduplicated** so a head
that is both owner and listed never gets two completions.

### D-04 — The single fan-out point is `completeAgent` (src/sub-agents/local.ts:983-989)
Thread the delivery set: `SpawnOptions` → persisted on the agent record (`AgentState` / agents
row) → read in `completeAgent`. At completion, the top-level branch (no `parentAgentId`) enqueues
one `agent_completed` per head in the deduped delivery set (instead of only `this.headId`).
- **Persist the set on the agent** (not re-read from the schedule at completion): one-time task
  rows are deleted at fire time before the agent finishes, so the schedule is unavailable later.
  This mirrors how Phase 34 persisted `head_id` on the agents row; the exact persistence shape
  (JSON column vs derived) is for research/planner to choose, but it MUST survive resume/restart.
- Sub-agents (with `parentAgentId`) are unaffected — fan-out lives only in the top-level branch.
- Each delivery head's loop independently runs its own relay steward + work-summary steward and
  delivers to its own channel. Running those N times is intended (per-head personalization); the
  **expensive work — the agent — still runs exactly once.**

### D-05 — `agent_failed` fans out to the OWNER head only
A failure is operational noise, not a deliverable. Only the owner head is notified of an
`agent_failed`; the extra delivery heads are not. (Keeps the failure path simple and avoids
N copies of an error nobody asked to receive.)

### D-06 — Scheduled agents never suspend-as-question
There is no "agent_question tool" — the question path is the **completion-steward
classification** in `local.ts` (`runCompletionSteward` → `suspendAsQuestion` when it labels the
output `question`). Gate `suspendAsQuestion` on `options.trigger`: for scheduled runs, force
`completeAgent` instead of suspending. `options.trigger` is already in scope at that call site.
- This is independently valuable (a long-standing want: a scheduled run has nobody to answer)
  and it eliminates the only execution-time head-routing question multi-head would raise.
- The exact trigger predicate is Claude's discretion (at minimum `trigger === 'scheduled'`;
  consider whether `proactive`/other non-`manual` triggers should also never suspend). Sub-agent
  (`parentAgentId`) question routing to its parent is unchanged.

### D-07 — Agent-side `create_schedule` stays single-head (deferred)
The per-head agent tool registry continues to stamp only the spawning head's id; no
`deliverToHeadIds` is exposed in the `create_schedule` / `update_schedule` input schemas this
phase. Multi-head is set via the dashboard/API only. (Revisit later if there's demand.)

### D-08 — API: accept + validate the delivery set for tasks; allow editing it
`POST` and `PATCH /api/schedules`:
- Accept `deliverToHeadIds` **only for `kind: 'task'`** (reject or ignore on reminders — pick
  the stricter, clearest behavior; a 400 on reminders is fine).
- Validate every id is a known head (reuse the existing `resolveCurrentHeads` check; mirror the
  Phase 35 D-11 admin-404/400 stance — schedules are administrative, no silent fallback).
- Dedupe; an empty array is equivalent to absent (single-head).
- The owner `headId` still **cannot** be reassigned via PATCH (Phase 35 D-13 stands). But the
  **delivery set IS editable** via PATCH — "add/remove a delivery head" is a normal edit, not a
  reassignment of ownership.

### D-09 — Dashboard: multi-select on the task form only; multi-chip on task rows
In `dashboard/src/pages/SchedulesPage.tsx`:
- The **task** add/edit form gains a "deliver to" head **multi-select** (the existing single
  head `<select>` becomes the owner/primary; extra heads are the delivery set — or present one
  combined multi-select where the first selection is the owner; affordance is Claude's discretion).
- The **reminder** form is unchanged (single head).
- Task rows render **one colored chip per delivery head** — the existing `HEAD_COLORS` hash
  palette already supports N chips; the single-chip render just becomes a map.
- Update the dashboard `Schedule` type in `dashboard/src/types/api.ts` to match the new field.

### Claude's Discretion
- Exact field name (`deliverToHeadIds` vs alternative) and whether the stored value includes or
  excludes the owner (must dedupe to the same effective set either way).
- Agent-record persistence shape for the delivery set (JSON column on agents vs other), provided
  it survives resume/restart.
- The precise trigger predicate for D-06 question-suppression.
- The exact UI affordance for picking owner + delivery heads (two controls vs one multi-select).
- Whether `agent_failed` owner-only (D-05) is enforced in `local.ts` or is already implicit.
- Plan/wave breakdown (natural seam: schema+migration+types → spawn/runner fan-out + question
  gate → API → dashboard).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Data model & scheduling
- `src/db/schedules.ts` — `Schedule` interface, `CreateScheduleOptions`, `SchedulePatch`,
  `migrateLegacySchedule` (the lazy-migration funnel to extend), `create/update/list/getDue`,
  `deleteAllForHead`. **The single `headId` field is the owner; the new delivery set lives here.**
- `src/scheduler/index.ts` — `tick()` enqueues the `schedule_trigger` to `schedule.headId`
  (owner). Unchanged by this phase (fan-out happens at completion, not at trigger).

### Spawn → run → complete (the fan-out path)
- `src/head/activation.ts` — `handleScheduleTrigger` (task branch): spawns the agent with
  `headId: this.opts.headId`; this is where the schedule's delivery set is read and passed to
  `spawn()`.
- `src/sub-agents/local.ts` — **`completeAgent` (≈983-989)** is the fan-out point;
  **`suspendAsQuestion` (≈993-1009)** is the question gate (D-06); `runCompletionSteward` call
  (≈944-955) is where `question` vs `done` is classified. `this.headId` is stamped on all
  enqueues; the delivery set must override that for completion.
- `src/types/agent.ts` — `SpawnOptions`, `AgentState` (carry the delivery set; required-at-type
  precedent set by Phase 34's `headId`).
- `src/db/agents.ts` — `AgentStore` (persist the delivery set on the agents row, mirroring the
  Phase 34 `head_id` column work).

### API & dashboard
- `src/dashboard/routes/schedules.ts` — POST/PATCH validation; the Phase 35 D-11 (admin-404),
  D-13 (no headId reassignment) precedents to mirror/extend.
- `dashboard/src/pages/SchedulesPage.tsx` — the add/edit forms, the head `<select>`,
  `HEAD_COLORS` chip rendering, `active-head` seeding.
- `dashboard/src/types/api.ts` — the dashboard `Schedule` type.

### Prior-phase context (carry-forward — the multi-head foundations this builds on)
- `.planning/STATE.md` § "Decisions (Phase 34)" — `head_id` persisted on agents row;
  `D-ALL-SIX` (all 6 `enqueue()` callsites stamp `this.headId`); `D-RUNNER-HEADID`.
- `.planning/STATE.md` § "Decisions (Phase 35)" — per-head scheduling; `D-11` admin-404,
  `D-13` no-headId-reassignment, `D-16/17` head-delete cascade (`deleteAllForHead`).
- `.planning/phases/35-*/35-CONTEXT.md` (in `milestones/` if archived) — the per-head
  scheduling boundary this extends.

</canonical_refs>

<code_context>
## Existing Code Insights

### Verified facts (drove the scope)
- **Execution is head-agnostic.** Scheduled spawn passes no head history (only the head's
  manual `spawn_agent` tool path passes `getHistory()` — `activation.ts`). Identity is a single
  global dir (`system.ts`: `identityDir = config.identityDir`), not per-head. The agent's work
  never reads `headId`.
- **`headId` on a scheduled agent is purely routing.** In `local.ts` `this.headId` is used only
  at the enqueue sites (`agent_completed`/`agent_failed`/`agent_question`/`agent_response`),
  plus stamping agent-created schedules and child inheritance. None gate the work.
- **The runner is per-head** (`buildSystem` is called once per head in `index.ts`; `headId` is
  fixed at `LocalAgentRunner` construction). The delivery set must therefore be carried on the
  spawn/agent, not inferred from "which runner ran it."
- **One-time task rows are deleted at fire time** (`handleScheduleTrigger`, `cron === null`),
  before the agent completes — so the delivery set cannot be re-read from the schedule later; it
  must be persisted on the agent (D-04).

### Established patterns to mirror
- Phase 34's `head_id` column + required `SpawnOptions.headId` (type-required, SQL DEFAULT as
  defense-in-depth) is the template for persisting the delivery set on the agents row.
- Lazy idempotent JSON migration via `'field' in obj` guards (`migrateLegacySchedule`) — extend,
  don't rewrite; keep mtime stable on repeat reads.
- Phase 35 admin-route stance (404/400, no silent fallback) for the new API validation.
- `HEAD_COLORS` hash palette in `SchedulesPage.tsx` already supports N chips.

### Integration points
- New field on `Schedule` (`src/db/schedules.ts`) + dashboard type mirror (`types/api.ts`).
- New persisted field on the agent (`types/agent.ts`, `db/agents.ts`, possibly a `sql/0NN_*.sql`).
- Fan-out edit in `completeAgent`; question gate in `suspendAsQuestion` (`local.ts`).
- Read+pass the set in `handleScheduleTrigger` (`activation.ts`).
- Validation in `routes/schedules.ts`; form + chips in `SchedulesPage.tsx`.

</code_context>

<specifics>
## Specific Ideas

- **The user's framing:** "Save the work that would happen in a task from being done multiple
  times just because the results are being reported to multiple heads." The success test is:
  one task scheduled to deliver to heads A + B causes **one** agent run and **two** deliveries
  (one per head, each through that head's own channel + relay).
- **Reminders explicitly excluded** to keep it simple — there's no work to save on a reminder.
- **Question-suppression for scheduled agents** is wanted in its own right, independent of
  multi-head — fold it in here since it removes the multi-head routing ambiguity too.

</specifics>

<deferred>
## Deferred Ideas

- **Agent-side multi-head schedules** (`create_schedule` delivery set) — D-07; dashboard-only for v1.
- **Multi-head reminders** and **ack-required reminders across heads** — explicitly rejected.
- **Owner-head reassignment via PATCH** — stays banned (Phase 35 D-13); delete-and-recreate.
- **Per-head delivery customization beyond the existing relay/work-summary stewards** — each head
  already personalizes via its own stewards; nothing extra this phase.

</deferred>

---

*Phase: 44-multi-head-task-delivery*
*Context gathered: 2026-05-24 (discuss-phase skipped — scoped conversationally against the live codebase)*
