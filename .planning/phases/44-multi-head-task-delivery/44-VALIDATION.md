---
phase: 44
slug: multi-head-task-delivery
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-24
---

# Phase 44 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `44-RESEARCH.md` § Validation Architecture. Task IDs are assigned by the planner;
> rows below are keyed by behavior until plans land.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `vitest.config.ts` (existing) |
| **Quick run command** | `npx vitest run src/db/schedules.test.ts src/dashboard/routes/schedules.test.ts src/sub-agents/agents.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | quick ~seconds; full suite is sharded 6× on CI (4 GB heap each) |

Also gating (from AGENTS.md): `npx tsc --noEmit` must be clean (noUncheckedIndexedAccess + exactOptionalPropertyTypes enabled); dashboard build green.

---

## Sampling Rate

- **After every task commit:** Run the quick run command.
- **After every plan wave:** Run the full suite command + `npx tsc --noEmit`.
- **Before `/gsd:verify-work`:** Full suite must be green, tsc clean, dashboard build green.
- **Max feedback latency:** quick run completes in seconds.

---

## Per-Task Verification Map

> Keyed by behavior (task IDs TBD by planner). Wave numbers follow RESEARCH § Recommended Wave Structure.

| Behavior | Wave | Test Type | Automated Command | File | Status |
|----------|------|-----------|-------------------|------|--------|
| `deliver_to_head_ids` SQL column exists on agents table, `DEFAULT '[]'` | 1 | db unit | `npx vitest run src/db/db.test.ts` | extend | ⬜ pending |
| `deliverToHeadIds` persists in schedule JSON, round-trips through `get()` | 1 | unit | `npx vitest run src/db/schedules.test.ts` | extend | ⬜ pending |
| Legacy schedule row — `migrateLegacySchedule` leaves `deliverToHeadIds` absent (owner-only) | 1 | unit | `npx vitest run src/db/schedules.test.ts` | extend | ⬜ pending |
| Fan-out: one agent + `deliverToHeadIds:['b']` → two `agent_completed` events, same agentId | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| Dedup: owner present in both `headId` and `deliverToHeadIds` → one event, not two | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| Regression: `deliverToHeadIds` absent → single completion event (today's behavior) | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| Both completion enqueue sites fan out (`completeAgent` + `ctx.complete` closure) | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| Question-suppression: `trigger:'scheduled'` + steward returns `question` → completed, not suspended | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| `agent_failed` owner-only: failure with `deliverToHeadIds:['b']` → one event, `head_id` = owner | 2 | integration | `npx vitest run tests/integration/multi-head-task-delivery.test.ts` | **new** | ⬜ pending |
| POST task with valid `deliverToHeadIds` → schedule created with field | 3 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | extend | ⬜ pending |
| POST reminder with `deliverToHeadIds` → 400 (tasks-only) | 3 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | extend | ⬜ pending |
| POST task with unknown head in `deliverToHeadIds` → 404 | 3 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | extend | ⬜ pending |
| PATCH task `deliverToHeadIds` — add / remove / clear (while owner `headId` reassignment stays 400) | 3 | unit | `npx vitest run src/dashboard/routes/schedules.test.ts` | extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/multi-head-task-delivery.test.ts` — new file; fan-out (×2 sites) + dedup + regression + question-suppression + agent_failed owner-only. Analog: `tests/integration/multi-head-agent-lifecycle.test.ts` (Phase 34 — asserts per-event `head_id` stamping).
- [ ] `sql/008_agents_deliver_to_head_ids.sql` — new migration (no own test; column existence asserted via `src/db/db.test.ts`).
- Existing infrastructure (vitest + the three quick-run files) covers all other requirements.

---

## Manual-Only Verifications

| Behavior | Why Manual | Test Instructions |
|----------|------------|-------------------|
| Dashboard task form "deliver to" multi-select renders + persists; reminder form unchanged; task rows show N head chips | React UI; covered by dashboard build, not unit tests | In the dashboard, create a task schedule, select 2+ heads in "deliver to", save; confirm the row shows N colored chips. Open a reminder form; confirm it has only the single head select. |
| End-to-end: a scheduled task delivered to heads A+B runs the agent once and reports to both channels | Requires a live multi-head workspace + real scheduled fire | Configure two heads with distinct channels; schedule a task delivering to both; on fire, confirm one agent run and a delivered report on each head's channel. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (new integration test + SQL migration)
- [ ] No watch-mode flags
- [ ] `nyquist_compliant: true` set in frontmatter (after planner maps task IDs)

**Approval:** pending
