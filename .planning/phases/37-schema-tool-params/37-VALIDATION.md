---
phase: 37
slug: schema-tool-params
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-23
---

# Phase 37 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: 37-RESEARCH.md § Validation Architecture (HIGH confidence — framework + commands + timings measured against the live suite).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (running 2.1.9), `environment: 'node'` |
| **Config file** | `vitest.config.ts` (unit) + `vitest.config.integration.ts` (integration) |
| **Quick run command** | `npx vitest run src/db/schedules.test.ts src/sub-agents/agents.test.ts` |
| **Full suite command** | `npx vitest run` then `npx tsc --noEmit` (type gate — SC4) |
| **Estimated runtime** | ~1.6 s for the quick subset (schedules 14 tests ~0.5 s + reminder-tool subset 13 tests ~1.1 s, measured) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/db/schedules.test.ts src/sub-agents/agents.test.ts`
- **After every plan wave:** Run `npx tsc --noEmit` + the two files above
- **Before `/gsd:verify-work`:** `npx tsc --noEmit && npx vitest run` (full suite) must be green
- **Max feedback latency:** ~2 seconds (quick subset)

---

## Per-Task Verification Map

> Task IDs (e.g. `37-01-01`) are assigned when plans are written. Until then this map is keyed by Requirement/Success-Criterion. Each row already names the concrete automated command and the existing test file to extend — the executor wires the task ID in at execution time.

| Req / SC | Behavior | Test Type | Automated Command | File |
|----------|----------|-----------|-------------------|------|
| SC1 / ACK-01, ACK-02 | `requiresAck:true` + nag fields round-trip via `store.create` → `store.get` | unit (store) | `npx vitest run src/db/schedules.test.ts -t "round-trip"` | extend `src/db/schedules.test.ts` |
| SC2 / ACK-09 | Legacy reminder JSON (no new fields) reads back with defaults, still due/fires; no crash | unit (store migration) | `npx vitest run src/db/schedules.test.ts -t "legacy"` | extend `src/db/schedules.test.ts` |
| ACK-09 (D-08) | Migration idempotent / mtime-stable across 3 reads after stamping new fields | unit (store) | `npx vitest run src/db/schedules.test.ts -t "mtime"` | extend `src/db/schedules.test.ts:127` |
| D-03 floor | nag sum < 5 min while `requiresAck:true` → `{ error:true }` | unit (tool boundary) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | extend buildReminderTools block |
| D-03 ceiling | nag sum > 43200 min → `{ error:true }` | unit (tool boundary) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | extend buildReminderTools block |
| D-04 | `requiresAck:true` with no/insufficient nag → `{ error:true }` | unit (tool boundary) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | extend buildReminderTools block |
| D-05 | nag slots present, `requiresAck` false/omitted → `{ error:true }` | unit (tool boundary) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | extend buildReminderTools block |
| D-01 / D-02 | slots (`nagHours:1` + `nagMinutes:30`) sum to stored `nagIntervalMinutes:90` | unit (tool→store) | `npx vitest run src/sub-agents/agents.test.ts -t "create_reminder"` | extend buildReminderTools block |
| D-07 inert-for-tasks | `kind:'task'` row created without ack fields defaults `requiresAck:false`, `nagIntervalMinutes:null` | unit (store) | `npx vitest run src/db/schedules.test.ts` | extend `src/db/schedules.test.ts` |
| SC3 / SCHED-04 | description drops "for one-time reminders only"; documents start-then-repeat | unit (description assertion) | `npx vitest run src/sub-agents/agents.test.ts -t "description"` | NEW assertion in buildReminderTools block |
| SC4 | type-clean + suite green | type + full suite | `npx tsc --noEmit && npx vitest run` | existing gates |
| (property order) | inputSchema key order updated for new params | unit (schema) | `npx vitest run src/sub-agents/agents.test.ts -t "property order"` | **UPDATE** existing `agents.test.ts:1453-1460` |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements.* `src/db/schedules.test.ts` and the `buildReminderTools` describe block in `src/sub-agents/agents.test.ts` already exist with the exact fixtures needed (`getReminderTools()` helper, tmp `ScheduleStore`, legacy-JSON-write pattern). New tests are additions to existing files — no framework install, no new test file, no shared-fixture gap.

- [ ] **Required edit (not a gap):** update the inputSchema property-order assertion at `agents.test.ts:1453-1460` — it will fail once new params are added; update its expected key array.

---

## Manual-Only Verifications

*All phase behaviors have automated verification.* No external services, no network, no UI in this phase — every success criterion maps to a unit test or the type/suite gate above.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (none — existing infra)
- [ ] No watch-mode flags
- [ ] Feedback latency < 2s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
