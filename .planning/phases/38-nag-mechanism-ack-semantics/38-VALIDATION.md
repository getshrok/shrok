---
phase: 38
slug: nag-mechanism-ack-semantics
status: ready
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-23
---

# Phase 38 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (`"test": "vitest run"` in package.json) |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `npx vitest run src/db/schedules.test.ts src/scheduler/scheduler.test.ts src/head/activation.test.ts src/head/head-tools.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~20-40 seconds for the quick set; full suite is sharded 6 ways on CI |

Type gate: `npx tsc --noEmit` (the SchedulePatch + apply-block extension in Plan 01 is the gating tsc fix for the whole phase).

---

## Sampling Rate

- **After every task commit:** Run the touched test file via `npx vitest run <file>` + `npx tsc --noEmit`
- **After every plan wave:** Run the quick run command
- **Before `/gsd:verify-work`:** `npm test` must be green and `npx tsc --noEmit` must exit 0
- **Max feedback latency:** < 45 seconds (single-file vitest runs)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 38-01-01 | 01 | 1 | ACK-03/04/05/06 (foundation) | T-38-01 | Migration stamps ackPending:false only when absent; idempotent | unit | `npx tsc --noEmit` | ✅ src/db/schedules.ts | ⬜ pending |
| 38-01-02 | 01 | 1 | ACK-09 continuation | T-38-01 | Legacy row migrates to ackPending:false, mtime-stable; update round-trips | unit | `npx vitest run src/db/schedules.test.ts` | ✅ src/db/schedules.test.ts | ⬜ pending |
| 38-02-01 | 02 | 2 | ACK-03 | T-38-04 | Nag re-arm never flips enabled=false for one-time ack reminder | unit | `npx tsc --noEmit` | ✅ src/scheduler/index.ts | ⬜ pending |
| 38-02-02 | 02 | 2 | ACK-03, ACK-06 | T-38-03 / T-38-04 | Re-arm = now+nagInterval, disable path not taken; recurring re-arms to nag not cron | unit | `npx vitest run src/scheduler/scheduler.test.ts` | ✅ src/scheduler/scheduler.test.ts | ⬜ pending |
| 38-03-01 | 03 | 2 | ACK-05, ACK-07, ACK-08 | T-38-05 / T-38-06 / T-38-07 | Steward bypassed; ackPending set before enqueue; one-time row survives; user-invisible ack instruction | unit | `npx tsc --noEmit` | ✅ src/head/activation.ts | ⬜ pending |
| 38-03-02 | 03 | 2 | ACK-07 | T-38-07 | Enqueued event has requires-ack="true" + reminderId; steward not called; ordinary reminder unchanged | unit | `npx vitest run src/head/activation.test.ts` | ✅ src/head/activation.test.ts | ⬜ pending |
| 38-04-01 | 04 | 2 | ACK-04/05/06/07 (wiring) | — | scheduleStore + timezone reach production executor; no new construction site | unit | `npx tsc --noEmit` | ✅ src/head/index.ts, src/system.ts | ⬜ pending |
| 38-04-02 | 04 | 2 | ACK-04, ACK-05, ACK-06, ACK-08 | T-38-08 / T-38-09 / T-38-10 / T-38-11 | One-time delete; recurring cron-resume; hard error on ordinary/task; benign no-op on stale | unit | `npx tsc --noEmit` | ✅ src/head/index.ts | ⬜ pending |
| 38-04-03 | 04 | 2 | ACK-04, ACK-05, ACK-06, ACK-08 | T-38-08..T-38-11 | All ack-by-type + scoping + no-op behaviors pinned by tests | unit | `npx vitest run src/head/head-tools.test.ts` | ✅ src/head/head-tools.test.ts (new) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → Test coverage (all six ACK-03..ACK-08 mapped)

| Req | Automated test(s) |
|-----|-------------------|
| ACK-03 | `scheduler.test.ts` nag re-arm: nextRun = now+nagInterval, enabled stays true |
| ACK-04 | `head-tools.test.ts` one-time ack → `scheduleStore.delete` called |
| ACK-05 | `head-tools.test.ts` recurring ack → `update({ ackPending:false, nextRun: cron-resume })`; `activation.test.ts` one-time ack row survives fire |
| ACK-06 | `head-tools.test.ts` row deleted (one-time) / nextRun re-pointed (recurring); `scheduler.test.ts` nag always pre-armed |
| ACK-07 | `activation.test.ts` enqueued event text contains `requires-ack="true"` + `reminderId="s1"` |
| ACK-08 | `head-tools.test.ts` hard error on `requiresAck===false` and on `kind!=='reminder'`; benign no-op on not-found / ackPending===false |

---

## Wave 0 Requirements

Wave 0 scaffolding is folded into the plans (no separate Wave 0 plan needed — the test-helper edits ride with the plan that consumes them):

- [x] `src/scheduler/scheduler.test.ts` — `makeSchedule()` helper gains `ackPending: false` (Plan 02 Task 2)
- [x] `src/head/activation.test.ts` — reminder `scheduleRow` fixture gains `requiresAck`, `nagIntervalMinutes`, `ackPending`, `headId`, `cronTimezone` (Plan 03 Task 2)
- [x] `src/head/head-tools.test.ts` — NEW file; first test for a head-direct tool that touches `scheduleStore` (Plan 04 Task 3)
- [x] `src/db/schedules.test.ts` — extend with ackPending migration + round-trip (Plan 01 Task 2)

Framework already present (vitest) — no install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| HEAD_TOOLS acknowledge_reminder description is "airtight" | ACK-08 | Natural-language scoping quality is not machine-asserted | Code review the description: must contain (1) requiresAck-only scope, (2) "never on an ordinary reminder", (3) "only when the user has explicitly confirmed", (4) "reminderId is in the reminder event" |

All other phase behaviors have automated verification.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (test helpers/fixtures + new head-tools test file)
- [x] No watch-mode flags (all commands use `vitest run`)
- [x] Feedback latency < 45s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-23
