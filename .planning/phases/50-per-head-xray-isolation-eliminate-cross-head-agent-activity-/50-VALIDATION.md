---
phase: 50
slug: per-head-xray-isolation-eliminate-cross-head-agent-activity
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-18
---

# Phase 50 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^2.1.0 |
| **Config file** | `vitest.config.ts` (root, `include: ['src/**/*.test.ts']`) + `dashboard/vitest.config.ts` (`src/**/*.test.{ts,tsx}`) |
| **Quick run command** | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` |
| **Full suite command** | `npm test` (root, 6 CI shards) + `cd dashboard && npx vitest run` |
| **Estimated runtime** | ~60 seconds quick / full suite sharded on CI |

---

## Sampling Rate

- **After every task commit:** Run `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` (fast, covers the per-head filter logic) — plus the relevant server quick-run for store/migration tasks (`npx vitest run src/db/steward_runs.test.ts`).
- **After every plan wave:** Run `npm test` (full root suite) + `cd dashboard && npx vitest run` (full dashboard suite).
- **Before `/gsd:verify-work`:** Both suites must be green.
- **Max feedback latency:** ~60 seconds (quick run).

---

## Per-Task Verification Map

| Item | Behavior | Test Type | Automated Command | File Exists | Status |
|------|----------|-----------|-------------------|-------------|--------|
| D-01 `agent_message_added` | `streamFilter` drops `agent_message_added` when `event.headId !== selectedHead` | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | ✅ (needs new cases) | ⬜ pending |
| D-01 `memory_retrieval` | `streamFilter` drops `memory_retrieval` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | ✅ (needs new cases) | ⬜ pending |
| D-01 `steward_run_added` | `streamFilter` drops `steward_run_added` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | ✅ (needs new cases) | ⬜ pending |
| D-01 `agent_status_changed` | `streamFilter` drops `agent_status_changed` for wrong head | unit | `cd dashboard && npx vitest run src/hooks/streamFilter.test.ts` | ✅ (needs new cases) | ⬜ pending |
| D-01 xray backfill | `AgentStore.getRecent(50, headId)` returns only that head's agents | unit | `npx vitest run src/db/agents.test.ts` | ✅ | ⬜ pending |
| D-01 steward backfill (store) | `StewardRunStore.getRecent(N, headId)` returns only that head's runs | unit | `npx vitest run src/db/steward_runs.test.ts` | ❌ W0 | ⬜ pending |
| D-01 xray backfill route | `GET /api/agents/xray-history?head=A` returns only head A's agent messages | integration | `npx vitest run src/dashboard/routes/agents.test.ts` | ❌ W0 (if route test added) | ⬜ pending |
| D-02 limit | Per-head backfill window of 50 preserved (no new limit constant) | unit | `npx vitest run src/db/agents.test.ts` | ✅ | ⬜ pending |
| D-04 migration | `sql/010` runs without error; existing rows get `head_id='default'` | unit | `npx vitest run src/db/db.test.ts` | ✅ (runs all migrations) | ⬜ pending |
| D-04 single-head compat | Single-head deployment sees identical behavior | smoke | manual | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/db/steward_runs.test.ts` — new file covering `getRecent(limit, headId?)` head-scoping (mirror `src/db/agents.test.ts` shape).
- [ ] New cases in `dashboard/src/hooks/streamFilter.test.ts` — the existing file has explicit "always delivers … (scope: out of phase)" cases for the four leaky event types that must flip to "drops for wrong head, delivers for matching head."
- [ ] (Optional) `src/dashboard/routes/agents.test.ts` head-scoping case for `?head=` if a route-level integration test is added.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Two-head isolation (the operator UAT bar) | D-01 | Requires two live heads each running agents + a browser; SSE + backfill + head-switch interaction is end-to-end | Run two heads, each with active agents/steward runs/memory retrievals. Select head A → confirm zero activity from B (timeline, steward rows, memory retrievals, agent pills). Select B → confirm zero from A. Switch back and forth; confirm no leftover items leak across the switch. Verify both on initial backfill AND live streaming. |
| Single-head no-change | D-04 | Visual regression check on a single-head deployment | Deploy/run with one head; confirm timeline, steward rows, memory retrievals, and pills behave identically to pre-phase. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (`steward_runs.test.ts`, streamFilter new cases)
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
