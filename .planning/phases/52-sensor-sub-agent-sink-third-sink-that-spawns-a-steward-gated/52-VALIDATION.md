---
phase: 52
slug: sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-20
---

# Phase 52 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (CI shards into 6 parallel runs) |
| **Config file** | `vitest.config.ts` / `vite.config.ts` |
| **Quick run command** | `npx vitest run src/sensors/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~10–30 seconds (quick) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/sensors/ src/scheduler/ src/head/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 52-XX-XX | TBD | 1 | SENSOR-18 | — | `headEvent` key enqueues `sensor_event`; old `event` key no longer enqueues | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ W0 | ⬜ pending |
| 52-XX-XX | TBD | 1 | SENSOR-17 | — | `subAgentEvent:{prompt}` enqueues `sensor_sub_agent_trigger`; malformed silently skipped | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ W0 | ⬜ pending |
| 52-XX-XX | TBD | 2 | SENSOR-19 | — | `runSensorDispatchDecision` returns RUN on LLM failure (fail-open) | unit | `npx vitest run src/scheduler/proactive.test.ts` | extend existing | ⬜ pending |
| 52-XX-XX | TBD | 2 | SENSOR-19 | — | `handleSensorSubAgentTrigger` spawns with `trigger:'sensor'`; head never woken | unit | `npx vitest run src/head/activation.test.ts` | extend existing | ⬜ pending |

*Final Task IDs assigned by the planner. Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/sensors/runner.test.ts` — locate or create; extend with Phase 52 sink tests (headEvent rename, subAgentEvent enqueue, malformed-skip)
- [ ] `src/head/activation.test.ts` — add `handleSensorSubAgentTrigger` cases (spawn with `trigger:'sensor'`, head-not-woken)
- [ ] `src/scheduler/proactive.test.ts` — add `runSensorDispatchDecision` fail-open case

*If existing infrastructure already provides these test files, extend rather than create.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| End-to-end silent dispatch (example-sensor `subAgentEvent` demo spawns an agent without any head chatter) | SENSOR-17/19 | Requires a live workspace + running activation loop + steward LLM | Trigger the example-sensor tick; confirm xray shows a `sensor:<slug>`-labelled spawn and the conversational head produced no message |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
