---
phase: 39
slug: dashboard-reminder-ui
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-23
---

# Phase 39 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `39-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing — version per `package.json`) |
| **Config file** | `vitest.config.ts` (project root) |
| **Quick run command** | `npm test -- --reporter=verbose src/dashboard/routes/schedules.test.ts src/db/schedules.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | TBD — measure on first full run (backend-only vitest; tests are sharded on CI) |

> Test include pattern: `src/**/*.test.ts`, `tests/**/*.test.ts`. Backend-only — the vitest config has **no jsdom / @testing-library**, so React component behavior (badge rendering, reveal-on-toggle, client-side validation) is verified manually (see Manual-Only Verifications) or indirectly via the backend integration tests.

---

## Sampling Rate

- **After every task commit:** `npm test -- --reporter=verbose src/dashboard/routes/schedules.test.ts src/db/schedules.test.ts`
- **After every plan wave:** `npm test` (full suite)
- **Before `/gsd:verify-work`:** Full suite green **and** `npx tsc --noEmit` clean
- **Max feedback latency:** quick run should stay under ~30s; if it grows, narrow the per-task command

---

## Per-Task Verification Map

> Task IDs are assigned by the planner — fill the `Task ID` column after `PLAN.md` files exist. Rows below are the requirement-level behaviors that MUST map to at least one task's `<automated>` verify.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | SCHED-01 | — | POST reminder w/ `requiresAck`+`nagIntervalMinutes` round-trips | integration | `npm test -- src/dashboard/routes/schedules.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 | T-INPUT | POST `requiresAck=true` + no nag → 400 (coupling) | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 | T-INPUT | POST nag slots + `requiresAck=false` → 400 (coupling) | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 | T-INPUT | POST `nagSum < 1` → 400 (floor=1) | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 | T-INPUT | POST `nagSum > 43200` → 400 (30-day ceiling) | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 (D-11) | T-INPUT | PATCH updates `requiresAck`/`nagIntervalMinutes` (round-trip) | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-01 (D-11) | — | `SchedulePatch` + `update()` apply new fields | unit | `npm test -- src/db/schedules.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-02 | — | `requiresAck`/`nagIntervalMinutes` reach frontend `Schedule` type | type-check | `npx tsc --noEmit` | ❌ W0 (type update) | ⬜ pending |
| TBD | TBD | TBD | SCHED-03 | T-INPUT | POST `cron`+`startAt` → `nextRun = startAt`, `cron` retained | integration | `npm test -- src/dashboard/routes/schedules.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SCHED-03 | T-INPUT | POST `startAt` in the past → 400 | integration | same | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-03 | — | registry.ts `nagSum < 1` → error; `nagSum = 1` ok (floor=1) | unit | `npm test -- src/sub-agents/agents.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-12 | — | PATCH `requiresAck` true→false while `ackPending=true` clears nag + recomputes `nextRun` | integration | `npm test -- src/db/schedules.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/dashboard/routes/schedules.test.ts` — extend with: `requiresAck`+`nagIntervalMinutes` on POST (happy path + all coupling / floor=1 / ceiling rejections); `startAt`+`cron` on POST (happy: `nextRun = startAt`; reject: past `startAt`); PATCH `requiresAck`/`nagIntervalMinutes` (D-11 round-trip).
- [ ] `src/db/schedules.test.ts` — extend with: `update()` applies `requiresAck`+`nagIntervalMinutes` (D-11); D-12 transition (`requiresAck` true→false + `ackPending=true` → clears `ackPending` + recomputes `nextRun`).
- [ ] `src/sub-agents/agents.test.ts` (or equivalent) — extend for D-03 floor: `nagSum=1` ok, `nagSum=0` with `requiresAck` → error, `nagSum<1` → error.

*If these files do not exist yet, Wave 0 creates them before feature tasks run.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `NAGS` badge renders on ack-required reminder rows + inline nag-cadence sub-label | SCHED-02 (D-05) | No jsdom/@testing-library in vitest config | In dashboard, create a reminder with "Requires acknowledgment" on; confirm the `NAGS` badge appears on its row and the schedule sub-label shows the nag cadence (e.g. "· nags every 1h"). Confirm ordinary reminders show no badge. |
| Reveal-when-on: nag-slot inputs hidden until ack toggle is on | SCHED-01 (D-02) | Frontend interaction, no component test infra | Open the reminder create + edit forms; confirm the minutes/hours/days nag inputs are hidden until "Requires acknowledgment" is toggled on, then appear. |
| Client-side validation blocks submit (coupling, floor=1, ceiling) with inline message | SCHED-01 (D-04) | Frontend interaction | Try to submit with ack on + empty nag, with `nagSum<1`, and with `nagSum>43200`; confirm the Create/Save button is disabled with a clear inline message until valid. |
| Optional start-date/time field appears in repeating mode + rejects past dates inline | SCHED-03 (D-07/D-09) | Frontend interaction | In repeating mode on both create forms, set a future start datetime → first fire at that time; set a past datetime → inline "Start date must be in the future" + blocked submit. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
