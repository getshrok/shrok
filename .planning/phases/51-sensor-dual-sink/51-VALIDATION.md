---
phase: 51
slug: sensor-dual-sink
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-18
---

# Phase 51 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Seeded from 51-RESEARCH.md "Validation Architecture". Per-task rows are filled by the planner/nyquist-auditor once task IDs exist.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (`pool: 'forks'`) |
| **Config file** | `vitest.config.ts` (project root) |
| **Quick run command** | `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts src/head/injector.test.ts` |
| **Full suite command** | `npx vitest run && npx tsc --noEmit` |
| **Estimated runtime** | quick ~10–20s; full suite is CI-sharded |

---

## Sampling Rate

- **After every task commit:** `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts src/head/injector.test.ts`
- **After every plan wave:** `npx vitest run && npx tsc --noEmit`
- **Before `/gsd:verify-work`:** full suite green + `npx tsc --noEmit` clean
- **Max feedback latency:** ~20 seconds (quick command)

---

## Per-Requirement Verification Map

*(Task IDs assigned during planning; this is the requirement→test seed from research.)*

| Requirement | Behavior | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|------------|-----------------|-----------|-------------------|-------------|--------|
| SENSOR-13 | JSON parse matrix: both / ambient-only / event-only / empty no-op / malformed→failure-marker | T-51-V5 | type-guard `ambient`/`event.text` as strings; never eval | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-13 | malformed/non-object stdout → `⚠ Sensor failed on last run:` at head-scoped path | T-51-V5 | defensive JSON.parse, bounded by execFile maxBuffer | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-14 | runner writes `ambient/<headId>/<slug>.md` (not flat) | T-51-PT | validate headId charset before path.join | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-14 | `scanAmbient(dir, headId)` reads only that head's dir; head A never sees head B | T-51-PT | per-head dir isolation | unit | `npx vitest run src/sensors/scan.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-14 | assembler + tool-surface inject only the assembling head's ambient | — | N/A | unit | `npx vitest run src/head/assembler.test.ts src/sub-agents/tool-surface.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-15 | `event` payload enqueues a `sensor_event` carrying the schedule's headId | — | N/A | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend (spy on injected sink) | ⬜ pending |
| SENSOR-15 | ambient-only payload does NOT enqueue (SENSOR-06 still holds for pull) | — | N/A | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend | ⬜ pending |
| SENSOR-15 | a `sensor_event` flows through the activation loop → injected `<system-event type="sensor">` + respond trigger → head turn | T-51-INJ | systemEvent escapes body via escapeXmlBody (webhook trust model) | unit | `npx vitest run src/head/injector.test.ts` | ❌ W0 | ⬜ pending |
| SENSOR-16 | scheduler passes `schedule.headId` to runner; event + ambient land under it | — | N/A | unit | `npx vitest run src/scheduler/scheduler.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Extend `src/sensors/runner.test.ts` — JSON parse matrix, dual-sink (mock enqueue sink), head-scoped write path, failure marker at head path.
- [ ] Extend `src/sensors/scan.test.ts` — per-head dir read + head A/B isolation.
- [ ] Add `injectSensorEvent` coverage to `src/head/injector.test.ts` (the one genuinely-new injector method).
- [ ] Extend `src/scheduler/scheduler.test.ts` — assert `run(slug, headId)` for `kind:'script'` dispatch.
- [ ] Extend `src/head/assembler.test.ts` + `src/sub-agents/tool-surface.test.ts` — add the headId dimension to existing ambient-placement tests.

*No framework install needed — vitest is configured.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The live `weather` sensor (head `ashley`) keeps working after migration | SENSOR-13/14 | Touches the real workspace, not the test fixture tree | After deploy: confirm `ambient/ashley/weather.md` exists with JSON-derived body (not a failure marker), and `sensor.mjs` emits the new JSON payload. |

*All other phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (the `injectSensorEvent` test)
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
