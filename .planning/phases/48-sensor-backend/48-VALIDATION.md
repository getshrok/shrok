---
phase: 48
slug: sensor-backend
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-17
---

# Phase 48 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` (root) — existing |
| **Quick run command** | `npx vitest run src/sensors src/scheduler` |
| **Full suite command** | `npx vitest run` (6 shards on CI) + `npx tsc --noEmit` |
| **Estimated runtime** | ~30–90 seconds (scoped quick run); full suite minutes |

---

## Sampling Rate

- **After every task commit:** Run the scoped quick command for the touched area (`npx vitest run <dir>`).
- **After every plan wave:** Run `npx vitest run` + `npx tsc --noEmit`.
- **Before `/gsd:verify-work`:** Full suite + typecheck must be green.
- **Max feedback latency:** 90 seconds (scoped quick run).

---

## Per-Task Verification Map

| Task area | Requirement | Test Type | Automated Command | Notes |
|-----------|-------------|-----------|-------------------|-------|
| `Schedule.kind:'script'` type + migration | SENSOR-06 | unit | `npx vitest run src/db` | New kind loads; legacy schedules still parse (lazy migration default). |
| Scheduler `kind:'script'` dispatch bypass | SENSOR-06 | unit | `npx vitest run src/scheduler` | Asserts NO `queueStore.enqueue` call and NO model invocation for a due script schedule; runner invoked inline; `enqueued`/one-time-disable still correct. |
| Runner success → `ambient/<slug>.md` (capped) | SENSOR-07 | unit | `npx vitest run src/sensors` | stdout written atomically, truncated at the cap constant. |
| Runner failure/timeout → overwrite with error | SENSOR-08 | unit | `npx vitest run src/sensors` | throw / non-zero exit / timeout each overwrite the file with trimmed error text; runner never throws out of the tick. |
| Run-on-save (run-now) | SENSOR-09 | unit | `npx vitest run src/sensors` | Creating/enabling a sensor runs it once immediately. |
| Ambient folder scan (filename heading, uncached) | SENSOR-10 | unit | `npx vitest run src/head src/llm` | `weather.md`→`## Weather`; assert block lands AFTER `\n\nCurrent time:` (uncached side of `toAnthropicSystem`). |
| Shared scan feeds all 3 consumers | SENSOR-11 | unit | `npx vitest run src/head src/sub-agents` | assembler, proactive, and `tool-surface.ts` all render the scan. |
| Legacy `AMBIENT.md` removed | SENSOR-12 | unit | `npx vitest run` + `grep` assertion | No source reads `{workspace}/AMBIENT.md`; no above-the-split injection remains. |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/sensors/runner.test.ts` — runner success/failure/timeout/cap (new file; new `src/sensors/` dir).
- [ ] `src/sensors/scan.test.ts` — ambient folder scan: filename→heading, concatenation, empty-folder no-op.
- [ ] Extend `src/scheduler/scheduler.test.ts` — `kind:'script'` dispatch bypass (no enqueue, no model).
- [ ] Extend `src/head/assembler.test.ts` — ambient block placement below the `Current time:` marker; AMBIENT.md path gone.

*Existing vitest infrastructure (config, fixtures, `getNow` clock injection) covers the rest — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real prompt-cache hit-rate on repeated turns with a frequently-updating sensor | SENSOR-10 | Cache-hit telemetry is provider-side; unit tests assert *placement* (below the split marker) as the proxy, not live cache behavior | Run shrok with a fast-updating sensor, observe Anthropic cache_read tokens stay high across turns where only the ambient block changed. |

*All other phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
