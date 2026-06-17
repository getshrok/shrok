---
phase: 48-sensor-backend
verified: 2026-06-17T21:54:41Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Confirm CR-01 (prompt-injection via sensor stdout) is an accepted risk for Phase 48 or requires a fix before proceeding to Phase 49"
    expected: "Either (a) operator accepts the current unescaped verbatim injection as within the same trust boundary as identity/skill files (no fix), or (b) scan.ts wraps each block body in an XML fence before Phase 49 ships any user-facing sensor CRUD"
    why_human: "CR-01 is a trust-boundary design decision — whether sensor stdout is 'operator-authored data' (same class as skill files) or 'attacker-influenceable external data' (same class as sub-agent free text requiring escapeXmlBody) cannot be determined by code grep. The review raised it as Critical; the original threat model (T-48-09) accepted it as 'same trust as identity/skill files.' A human must confirm which stance governs before Phase 49 surfaces sensor creation to operators."
---

# Phase 48: Sensor Backend Verification Report

**Phase Goal:** Sensor scripts run on a `kind:'script'` schedule, their output lands in `ambient/<slug>.md`, and every model turn sees a fresh ambient scan injected into the uncached system-prompt region — with the legacy `AMBIENT.md` path deleted and its cache-busting injection bug fixed.
**Verified:** 2026-06-17T21:54:41Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | A sensor script in the workspace sensors directory referenced by a `kind:'script'` schedule row runs in the scheduler tick with NO queue event enqueued, NO activation loop activation, and NO model call — only a child process is spawned. | VERIFIED | `src/scheduler/index.ts:66-81` — `if (schedule.kind === 'script')` branch calls `sensorRunner.run(slug).catch(...)` fire-and-forget, sets `enqueued=true`, and never calls `queueStore.enqueue`. The branch is placed BEFORE the `directHandler`/enqueue `else` block. Scheduler test pinning `expect(queueStore.enqueue).not.toHaveBeenCalled()` for `kind:'script'` is present at `src/scheduler/scheduler.test.ts`. |
| 2 | After a successful sensor run, `ambient/<slug>.md` contains the script's stdout (truncated to the max-output cap); after a failed run (non-zero exit, timeout, or throw), the file is overwritten with actionable error text. | VERIFIED | `src/sensors/runner.ts:59-73` — success path: `writeFileSync(outputPath, stdout.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })`. Failure path (err truthy): `writeFileSync(outputPath, \`⚠ Sensor failed on last run: ${msg}\n\`, { mode: 0o644 })`. Both branches call `resolve()` — never rejects. `SENSOR_OUTPUT_CAP = 2_000`, `SENSOR_TIMEOUT_MS = 30_000`. All branches exercised by `src/sensors/runner.test.ts` (18 tests, 5 behavioral scenarios per SUMMARY). |
| 3 | The runner exposes a directly-callable "run this sensor now" path (backend half of run-on-save, SENSOR-09) executing a sensor immediately and writing output independent of the schedule tick. | VERIFIED | `runSensor(slug, scriptPath, ambientDir, timeoutMs?)` is exported from `src/sensors/runner.ts`. A concrete `SensorRunner` object is built in `src/index.ts:474-480` closing over the workspace path. The function is callable directly independent of the scheduler tick. Note: the Phase 48 scope is explicitly "backend half" — the create/enable UI trigger is Phase 49 (see 48-02-PLAN.md objective and 48-CONTEXT.md D-05). REQUIREMENTS.md traceability marks SENSOR-09 as Phase 48 covering the callable infrastructure. |
| 4 | Every model turn sees each `ambient/*.md` file injected as a `## <Label>` block (filename-derived heading) in the uncached region — after the `\n\nCurrent time:` cache-split marker — as a fresh filesystem scan each turn, not a cached value. | VERIFIED | Three injection sites confirmed: (1) `src/head/assembler.ts:141-145` — `scanAmbient(resolvedWorkspace)` appended after `scheduleBlock`, which itself comes after the `Current time:` line at :127. Source-order check: `Current time:` at line 127 (assembler), `scanAmbient` at line 143 — sa>ct=1. (2) `src/sub-agents/tool-surface.ts:79-84` — `scanAmbient(deps.workspacePath)` appended immediately after `Current time:` at line 77. Source-order check: ct=79, sa=82, sa>ct=1. `src/head/assembler.test.ts:465-498` pins the placement invariant: `expect(systemPrompt.indexOf('## Weather')).toBeGreaterThan(systemPrompt.indexOf('\n\nCurrent time:'))`. |
| 5 | Both the head assembler and the proactive scheduler path see the same ambient scan; no consumer still reads the old single-file `AMBIENT.md`. | VERIFIED | `readAmbientContext()` method deleted from `src/head/activation.ts`. Both proactive call sites (lines 1136-1138 reminder branch, 1213-1215 task branch) use `scanAmbient()` with the same `os.homedir()` expansion pattern. `grep -rn "AMBIENT.md" src/ --include="*.ts" | grep -v ".test."` returns zero results. `src/scheduler/prompts/tasks.md:44` updated to "from the \`ambient/\` sensor scan" — no `AMBIENT.md` reference remains in any production source. Behavioral test in `src/head/activation.test.ts:538-576` (SENSOR-11 describe block) pins mocked `scanAmbient` sentinel reaching `ambientContext` field at BOTH proactive call sites. |

**Score:** 5/5 truths verified

### Deferred Items

None — all phase 48 scope items are implemented.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/sensors/scan.ts` | `scanAmbient` + `slugToTitle` exported | VERIFIED | Exports both functions. Uses `for...of`, `blocks.join('\n\n')`, no `homedir` expansion, reads only `ambient/` subdirectory. |
| `src/sensors/runner.ts` | `runSensor`, `SENSOR_OUTPUT_CAP`, `SENSOR_TIMEOUT_MS`, `SensorRunner` exported | VERIFIED | All four exports present. Slug guard at line 52, `process.execPath` at line 61, never rejects from execFile callback (3 grep hits on "reject" are all in comments/JSDoc), write-file-atomic at line 67/69. |
| `src/sensors/scan.test.ts` | Scan unit tests | VERIFIED | Present. Tests heading derivation, sort, empty-dir, AMBIENT.md exclusion. |
| `src/sensors/runner.test.ts` | Runner unit tests | VERIFIED | Present. Tests success/cap/non-zero/timeout/dir-autocreate/slug-guard. |
| `src/db/schedules.ts` | `'task' \| 'reminder' \| 'script'` in Schedule.kind + CreateScheduleOptions.kind | VERIFIED | `grep -c "'task' \| 'reminder' \| 'script'"` returns 2. `taskName` not added to SchedulePatch (intentionally absent). |
| `src/scheduler/index.ts` | `kind:'script'` dispatch branch + optional SensorRunner injection | VERIFIED | Branch at line 66, `enqueued = true` at line 81, `sensorRunner?: SensorRunner` 5th constructor param, `private sensorRunner: SensorRunner \| undefined` (exactOptionalPropertyTypes compliance). |
| `src/head/assembler.ts` | `scanAmbient` injection after `Current time:` + `buildScheduleBlock` script filter + AMBIENT.md block deleted | VERIFIED | `import { scanAmbient } from '../sensors/scan.js'` at line 23, `scanAmbient` at line 143 (after `Current time:` at 127), `s.kind !== 'script'` filter at line 205, zero occurrences of `AMBIENT.md`. |
| `src/head/activation.ts` | `readAmbientContext()` deleted; both proactive call sites use `scanAmbient()` | VERIFIED | Zero occurrences of `readAmbientContext` or `AMBIENT.md`. `scanAmbient` at lines 1137 and 1214. |
| `src/sub-agents/tool-surface.ts` | AMBIENT.md block replaced with `scanAmbient()` after `Current time:` | VERIFIED | Zero occurrences of `AMBIENT.md`. `import { scanAmbient }` at line 17, call at line 82 (after `Current time:` at line 77). |
| `src/scheduler/prompts/tasks.md` | Stale `AMBIENT.md` doc reference scrubbed | VERIFIED | Line 44 reads "from the \`ambient/\` sensor scan". Zero occurrences of `AMBIENT.md`. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `src/sensors/runner.ts` | `write-file-atomic` | `sync as writeFileSync` import | WIRED | Line 4: `import { sync as writeFileSync } from 'write-file-atomic'`. Used at lines 67 and 69 with `mode: 0o644`. |
| `src/sensors/scan.ts` | `ambient/` directory | `fs.readdirSync` filter `.md` | WIRED | Line 28: `fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()` inside try/catch. |
| `src/scheduler/index.ts` | `src/sensors/runner.ts` | `SensorRunner` type import + constructor injection | WIRED | `import type { SensorRunner } from '../sensors/runner.js'` at line 6. `sensorRunner.run(slug)` at line 74. |
| `src/index.ts` | `src/scheduler/index.ts` | `new ScheduleEvaluatorImpl(queue, schedules, config.timezone, undefined, sensorRunner)` | WIRED | Line 481. Concrete `sensorRunner` object built at lines 474-480, calls `runSensor` from `'./sensors/runner.js'` (imported at line 75). |
| `src/head/assembler.ts` | `src/sensors/scan.ts` | `scanAmbient()` appended after `Current time:` | WIRED | Import at line 23, call at line 143. Source-order verified: `Current time:` line 127, `scanAmbient` line 143 (sa>ct=1). |
| `src/head/activation.ts` | `src/sensors/scan.ts` | `scanAmbient()` at both proactive call sites | WIRED | Import at line 31, calls at lines 1137 and 1214. Behavioral test at activation.test.ts:548-576 pins the flow. |
| `src/sub-agents/tool-surface.ts` | `src/sensors/scan.ts` | `scanAmbient()` after `Current time:` | WIRED | Import at line 17, call at line 82. Source-order verified: ct=79, sa=82 (sa>ct=1). |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `src/head/assembler.ts` | `ambientBlock` | `scanAmbient(resolvedWorkspace)` → `fs.readdirSync` + `fs.readFileSync` | Yes — reads actual files from `ambient/` directory; returns `''` when dir absent (not a stub) | FLOWING |
| `src/head/activation.ts` proactive sites | `ambientContext` | `scanAmbient(this.opts.config.workspacePath.replace(/^~/, os.homedir()))` | Yes — same live filesystem scan | FLOWING |
| `src/sub-agents/tool-surface.ts` | `ambientBlock` | `scanAmbient(deps.workspacePath)` | Yes — same live filesystem scan; `deps.workspacePath` is pre-resolved | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — no HTTP server entry points are runnable without starting the full shrok daemon. All core behaviors are covered by the vitest test suite (2091 tests passing per phase note).

### Probe Execution

No probe scripts declared in PLAN.md files or discoverable at `scripts/*/tests/probe-*.sh`. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SENSOR-06 | 48-02 | Scheduled sensor bypasses activation loop, queue, model | SATISFIED | `src/scheduler/index.ts:66-81` — `kind:'script'` branch fires runner inline, no `queueStore.enqueue`. Scheduler test pins `expect(queueStore.enqueue).not.toHaveBeenCalled()`. |
| SENSOR-07 | 48-01 | Successful run writes capped stdout to `ambient/<slug>.md` | SATISFIED | `src/sensors/runner.ts:69` — `writeFileSync(outputPath, stdout.slice(0, SENSOR_OUTPUT_CAP), ...)`. Runner tests cover success + cap scenarios. |
| SENSOR-08 | 48-01 | Failed run overwrites `ambient/<slug>.md` with error text | SATISFIED | `src/sensors/runner.ts:66-68` — `⚠ Sensor failed on last run: ${msg}\n` on err truthy (non-zero exit, timeout, throw). Runner tests cover non-zero exit, timeout scenarios. |
| SENSOR-09 | 48-01, 48-02 | Sensor runs immediately on create/enable/save (backend half) | SATISFIED (backend half) | `runSensor()` exported from `src/sensors/runner.ts`, directly callable. Concrete `SensorRunner.run()` wired in `src/index.ts:474-480`. Phase 49 delivers the UI trigger. REQUIREMENTS.md marks SENSOR-09 as Phase 48 Complete. |
| SENSOR-10 | 48-01, 48-03 | Fresh `ambient/*.md` scan injected in uncached region | SATISFIED | All three injection sites confirmed post-`Current time:`. Assembler test pins `indexOf('## Weather') > indexOf('\n\nCurrent time:')`. |
| SENSOR-11 | 48-03 | Same ambient scan feeds head assembler and proactive scheduler | SATISFIED | `scanAmbient` called at assembler, both activation proactive paths, and tool-surface. Behavioral test pins mocked sentinel at both proactive call sites. |
| SENSOR-12 | 48-03 | Legacy `AMBIENT.md` mechanism removed | SATISFIED | `grep -rn "AMBIENT.md" src/ --include="*.ts" \| grep -v ".test."` returns zero results. `readAmbientContext()` deleted. No production source names the old file. |

All 7 phase requirement IDs (SENSOR-06 through SENSOR-12) are present in PLAN frontmatter and verified against code. No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/sensors/scan.ts` (via REVIEW CR-01) | 38 | Sensor stdout injected verbatim into system prompts with no sanitization | WARNING | The review classified this Critical (CR-01). The original threat model (T-48-09) accepted it as "same trust as identity/skill files — operator-authored." These two stances conflict; a human must arbitrate before Phase 49 exposes sensor CRUD to operators. Not a code stub; actual design decision. |
| `src/sensors/runner.ts` (WR-01) | 9, 69 | `SENSOR_OUTPUT_CAP` documented as "bytes" but `String.prototype.slice` counts UTF-16 code units | WARNING | For ASCII-only sensor output (the common case) this is benign. For multibyte content the cap can be exceeded by up to ~4x. Does not block the phase goal; follow-up for Phase 49. |
| `src/sensors/runner.ts` (WR-02) | 60 | `execFile` default `maxBuffer` (1 MB) means >1 MB stdout is an error rather than a truncation | WARNING | A very chatty sensor fails instead of being capped. The success path cap (2 KB) is still applied to anything below 1 MB. Minor operational concern; does not block phase goal. |
| `src/sensors/runner.ts` (WR-03) | 63 | Full `process.env` (including API keys) passed to sensor child processes | WARNING | Least-privilege concern; sensors are operator-authored and inherit all shrok secrets. Accepted by D-11 for this milestone; follow-up for Phase 49. |

No `TBD`, `FIXME`, or `XXX` markers found in any file modified by this phase. The `placeholder` match in assembler.ts line 109 is in a comment describing `{workspacePath}` template substitution — it is not a debt marker (the behavior is fully implemented above that comment).

### Human Verification Required

#### 1. CR-01: Unescaped sensor stdout in system prompts — accept or fix?

**Test:** Read `src/sensors/scan.ts:38` and `src/sensors/runner.ts:44-74`. A sensor script fetches external data (weather API, home-status feed, etc.) and writes it to stdout. `scanAmbient` reads that stdout verbatim and concatenates it into system prompts via `## <Heading>\n<body>`. The body is not escaped.

**Expected:** Either:
- (a) This is accepted as "operator trust" — the same trust boundary as identity files and skill files, which are also injected verbatim. The operator owns the sensor scripts and the external APIs they call; a malicious API response is within the accepted threat model for this milestone. No fix needed before Phase 49.
- (b) This requires a fix before Phase 49 ships sensor CRUD — wrapping each block body in an XML fence (e.g. `<ambient-data source="${slug}">...\n</ambient-data>`) to distinguish external data from model instructions, as the review's CR-01 suggests.

**Why human:** This is a trust-boundary design decision, not a code defect. The original threat model (T-48-09 in 48-01-PLAN.md) explicitly accepted this: "Scan emits only headings + bodies, never tool-call directives." The code review classified it Critical (CR-01) arguing it is the same class as sub-agent free text (which does use `escapeXmlBody`). Both stances are coherent; the project owner must decide which governs.

### Gaps Summary

No gaps blocking the phase goal. All 5 success criteria are verifiably true in the codebase. The human verification item (CR-01) is a design decision about the trust boundary of sensor output — it does not block the Phase 48 goal but should be resolved before Phase 49 exposes sensor creation to operators.

The review's other findings (WR-01 through WR-06, IN-01 through IN-04) are informational follow-ups, none of which block the phase goal:
- WR-01 (byte vs char cap): minor documentation/precision issue for ASCII-dominant use.
- WR-02 (maxBuffer): operational; sensor output >1 MB fails rather than truncates.
- WR-03 (full env): least-privilege; accepted by D-11 for this milestone.
- WR-04 (stale ambient on sensor disable): UX correctness; Phase 49 sensor deletion should prune `ambient/<slug>.md`.
- WR-05 (bad slug swallowed): invalid schedule rows fail silently; slug validation at create-time is Phase 49's responsibility.
- WR-06 (markFired dead code): pre-existing; not introduced by Phase 48.

---

_Verified: 2026-06-17T21:54:41Z_
_Verifier: Claude (gsd-verifier)_
