---
phase: 51-sensor-dual-sink
verified: 2026-06-18T18:31:00Z
status: passed
score: 12/12 must-haves verified (all code-verifiable truths pass; live-state item confirmed after daemon restart)
overrides_applied: 0
human_verification_resolved:
  - test: "After `systemctl --user restart shrok`, confirm the stale flat ambient/weather.md is gone and no longer regenerated"
    expected: "`ls ~/.shrok/workspace/ambient/weather.md` reports No such file or directory. The new daemon writes only to `ambient/ashley/weather.md`."
    result: "RESOLVED 2026-06-18T18:30:30Z — daemon restarted with new code (v0.2.0, clean startup, scheduler running). Stale flat file removed. The next scheduled run (cron */30, fired 18:30:25Z) refreshed ambient/ashley/weather.md (78F, partly cloudy, 0 failure markers) and did NOT recreate the flat file. Live migration confirmed end-to-end."
---

# Phase 51: Sensor Dual-Sink Rework Verification Report

**Phase Goal:** Rework the `sensor` primitive so each scheduled run emits exactly one structured JSON payload `{ ambient?, event? }` that routes to either/both of two head-scoped sinks: (1) a passive per-head ambient block written to `ambient/<headId>/<slug>.md` injected only into that head's turns (pull), and (2) an active `sensor_event` enqueued into the priority queue that wakes the bound head through the activation loop (push). The target head is mandatory and taken from the sensor's schedule `headId`. Malformed stdout is a sensor error. Scripts self-watermark; the runner adds no dedup/cooldown. No back-compat with the Phase-48 stdout-is-body contract.

**Verified:** 2026-06-18T18:12:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A `sensor_event` is a valid QueueEvent type the compiler knows about | VERIFIED | `src/types/core.ts` lines 158–172: `sensor_event` discriminated union member with `{type,id,slug,text,createdAt}`; `QueueEventType` derives automatically. `npx tsc --noEmit` clean. |
| 2 | `sensor_event` has priority 15 (between WEBHOOK=20 and SCHEDULE_TRIGGER=10) | VERIFIED | `src/types/core.ts` line 191: `SENSOR_EVENT: 15` placed between `WEBHOOK: 20` and `SCHEDULE_TRIGGER: 10` with documented justification. |
| 3 | A sensor's stdout MUST be exactly one JSON object; malformed/non-object stdout writes a failure marker | VERIFIED | `src/sensors/runner.ts`: `JSON.parse(stdout.trim())` in try/catch → `writeFailure('stdout was not valid JSON')` on parse error; type-guard rejects null/array/non-object → `writeFailure('stdout was not a JSON object')`. 24 runner tests green including malformed and non-object matrix cases. |
| 4 | The `ambient` field is head-scoped: written to `ambient/<headId>/<slug>.md`, NOT the flat `ambient/<slug>.md` | VERIFIED | `src/sensors/runner.ts` line 90: `const outputPath = path.join(ambientBaseDir, headId, `${slug}.md`)`. `mkdir` also uses the per-head path (line 138). Old flat `ambientDir` variable entirely absent from new runner. |
| 5 | An `event` field enqueues a `sensor_event` for the schedule's headId at PRIORITY.SENSOR_EVENT | VERIFIED | `src/sensors/runner.ts` lines 144–165: type-guard `event.text` as string → `enqueue.enqueue({type:'sensor_event', id, slug, text, createdAt}, PRIORITY.SENSOR_EVENT, headId)`. Enqueue errors caught and written as failure markers (never rejects). |
| 6 | An ambient-only payload does NOT enqueue (SENSOR-06 pull path) | VERIFIED | Dual-sink dispatch: ambient and event branches are independent `if` blocks; omitting `event` key skips the enqueue branch entirely. runner.test.ts has a discrete ambient-only test asserting enqueue spy call count === 0. |
| 7 | A quiet tick (neither field) does nothing on either sink | VERIFIED | Empty `{}` object: neither `typeof ambient === 'string'` nor event-text type-guard fires → no write, no enqueue. runner.test.ts has a discrete empty-no-op test. |
| 8 | A claimed `sensor_event` injects a `<system-event type="sensor">` + respond trigger that wakes the head (not a black hole) | VERIFIED | `src/head/activation.ts` line 1335: `case 'sensor_event': this.opts.injector.injectSensorEvent(event); break`. `injectSensorEvent` on `InjectorImpl` (lines 320–341): appends assistant `systemEvent('sensor', {slug}, text)` + user `systemTrigger('respond')`, both `injected:true`. injector.test.ts has discrete test asserting two messages with correct content. |
| 9 | All four scanAmbient call sites pass the head being assembled for | VERIFIED | `activation.ts` lines 1140, 1217: `scanAmbient(..., this.opts.headId)`. `assembler.ts` line 149: `scanAmbient(resolvedWorkspace, this.headId)`. `tool-surface.ts` line 82: `scanAmbient(deps.workspacePath, deps.headId)`. `grep -rn "scanAmbient(" src/ | grep -v ","` returns zero call-expression lines. |
| 10 | The scheduler passes `schedule.headId` to the runner | VERIFIED | `src/scheduler/index.ts` line 74: `this.sensorRunner.run(slug, schedule.headId)`. scheduler.test.ts passes (33/33). |
| 11 | The dashboard DELETE removes `ambient/<head>/<slug>.md` across all head dirs (not the flat path) | VERIFIED | `src/dashboard/routes/sensors.ts`: `fs.readdirSync(ambientDir, {withFileTypes:true})` → `for...of` + `fs.rmSync(path.join(ambientDir, entry.name, slug+'.md'), {force:true})`. Old `path.join(ambientDir, slug+'.md')` call count = 0. sensors.test.ts (15 tests green) includes multi-head delete test asserting unrelated file survives. |
| 12 | SKILL.md teaches the JSON-object stdout contract, two head-scoped sinks, mandatory head, and self-watermarking | VERIFIED | `grep -c "stdout is the output" skills/sensors/SKILL.md` = 0. `grep -ci "watermark\|state.json"` = 8. `grep -c "ambient/<headId>/<slug>.md"` = 3. JSON mentioned ≥11 times. `create_schedule` description in `registry.ts` includes `{ambient?, event?}` payload language and "mandatory target head" framing. |

**Code-verifiable score:** 12/12 truths verified

### Live Migration Status (Needs Human Verification)

**Truth:** The stale flat `ambient/weather.md` is removed and `ambient/ashley/weather.md` holds real conditions without a failure marker.

**Current live-state situation (confirmed by inspection):**

- `~/.shrok/workspace/ambient/ashley/weather.md` EXISTS and holds real conditions (no failure marker, real temperature/conditions). VERIFIED at code level.
- `~/.shrok/workspace/ambient/weather.md` EXISTS (141 bytes, modified 14:00:31) and contains raw JSON payload from the new sensor script.

**Root cause:** The live `shrok.service` daemon was NOT restarted after Phase 51 landed (confirmed by deployment context note). The daemon runs pre-Phase-51 runner code in memory. The old in-memory runner runs the new `sensor.mjs` (which now emits JSON) and writes its stdout verbatim to the old flat path `ambient/weather.md` — producing the JSON payload as raw file content (a corrupted ambient block from the old contract's perspective). The migration task correctly removed this file; the daemon regenerated it.

**Code is correct:** The new runner source code (`src/sensors/runner.ts`) writes exclusively to `ambient/<headId>/<slug>.md` and has no reference to the old flat path. After `systemctl --user restart shrok` the new in-memory runner will take effect and will not touch the flat file.

**The flat file currently causes no active harm** to the new code path: the new scanner reads `ambient/<headId>/*.md` (head-scoped), never the flat `ambient/*.md`, so the JSON-payload content in `ambient/weather.md` is never injected into any model turn.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/core.ts` | `sensor_event` union member + `PRIORITY.SENSOR_EVENT: 15` | VERIFIED | Lines 158–172 + line 191. All fields: `type`, `id`, `slug`, `text`, `createdAt`. No extra fields. |
| `src/sensors/scan.ts` | `scanAmbient(workspaceDir, headId)` head-scoped scanner | VERIFIED | Signature at line 25. Path: `path.join(workspaceDir, 'ambient', headId)`. `for...of` preserved. |
| `src/sensors/scan.test.ts` | Head A/B isolation + absent-dir tests | VERIFIED | 12 tests. Isolation test at line 81 asserts A sees A's content and NOT B's. Absent-dir test at line 102 asserts `''` is returned. |
| `src/sensors/runner.ts` | JSON parse + dual-sink route + headId guard + never-reject contract | VERIFIED | Slug guard, headId charset guard, `JSON.parse`, dual-sink dispatch, `writeFailure` helper, always-resolve promise. |
| `src/sensors/runner.test.ts` | Full parse-matrix test suite | VERIFIED | 24 tests green. Covers: both-fields, ambient-only, event-only, empty no-op, malformed JSON, non-object JSON, event-without-text ignored, invalid-headId throw, failure marker at head-scoped path, enqueue spy call count/priority/headId. |
| `src/scheduler/index.ts` | `kind:'script'` dispatch passes `schedule.headId` | VERIFIED | Line 74: `this.sensorRunner.run(slug, schedule.headId)`. `enqueued = true` Pitfall-1 line preserved. |
| `src/index.ts` | sensorRunner closure threads `headId` + `queue` to `runSensor` | VERIFIED | Lines 514–520: `run(slug, headId)` closure, `runSensor(slug, headId, scriptPath, ambientBaseDir, queue)`. |
| `src/head/injector.ts` | `injectSensorEvent` on Injector interface + InjectorImpl | VERIFIED | Interface line 140, impl lines 320–341. Appends assistant `systemEvent('sensor',{slug},text)` + user `systemTrigger('respond')`, both `injected:true`. |
| `src/head/activation.ts` | `case 'sensor_event'` in injectEvent + formatInjectedEvent; 2 head-scoped scanAmbient calls | VERIFIED | Lines 1335 (injectEvent), 1467 (formatInjectedEvent). scanAmbient at lines 1140, 1217 with `this.opts.headId`. |
| `src/head/assembler.ts` | head-scoped scanAmbient call + `sensor_event` in deriveQueryText | VERIFIED | Line 149: `scanAmbient(resolvedWorkspace, this.headId)`. Line 81–82: `case 'sensor_event': return trigger.text`. |
| `src/sub-agents/tool-surface.ts` | head-scoped scanAmbient call | VERIFIED | Line 82: `scanAmbient(deps.workspacePath, deps.headId)`. |
| `src/dashboard/routes/sensors.ts` | per-head ambient DELETE sweep | VERIFIED | `readdirSync(ambientDir)` sweep; old flat `path.join(ambientDir, slug+'.md')` removed. |
| `skills/sensors/SKILL.md` | Dual-sink JSON contract + self-watermarking | VERIFIED | Old "stdout is the output" phrase gone. Watermark/state.json referenced 8 times. Per-head path referenced 3 times. |
| `~/.shrok/workspace/sensors/weather/sensor.mjs` | Emits one JSON object `{ambient:...}` | VERIFIED | `grep -c "JSON.stringify" sensor.mjs` = 1. `node sensor.mjs | JSON.parse` exits 0. No `event` field. |
| `~/.shrok/workspace/ambient/ashley/weather.md` | Real conditions, no failure marker | VERIFIED | `grep -c "Sensor failed" ambient/ashley/weather.md` = 0. File holds "79°F, Overcast…" content. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/scheduler/index.ts` | `sensorRunner.run` | `this.sensorRunner.run(slug, schedule.headId)` | WIRED | Line 74: exact pattern matched |
| `src/sensors/runner.ts` | `QueueStore.enqueue` | `enqueue.enqueue(…, PRIORITY.SENSOR_EVENT, headId)` | WIRED | Lines 152–162: `PRIORITY.SENSOR_EVENT` at line 160 |
| `src/index.ts` | `runSensor` | `runSensor(slug, headId, scriptPath, ambientBaseDir, queue)` | WIRED | Line 518: exact pattern matched |
| `src/head/activation.ts injectEvent` | `injector.injectSensorEvent` | `case 'sensor_event':` | WIRED | Lines 1335–1337 |
| `src/head/injector.ts injectSensorEvent` | systemEvent + systemTrigger | `systemEvent('sensor', {slug}, text)` | WIRED | Lines 326, 335 |
| `src/head/assembler.ts` | `scanAmbient` | `scanAmbient(resolvedWorkspace, this.headId)` | WIRED | Line 149 |
| `src/dashboard/routes/sensors.ts DELETE` | `ambient/*/<slug>.md` | `readdirSync(ambientDir)` + per-entry rmSync | WIRED | Line 98 |
| `src/sensors/scan.ts` | `ambient/<headId>/*.md` | `path.join(workspaceDir, 'ambient', headId)` | WIRED | Line 26 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `src/sensors/runner.ts` | `stdout` from child process | `execFile(process.execPath, [scriptPath], ...)` | Yes — live script execution | FLOWING |
| `src/head/activation.ts injectEvent` | `event` (sensor_event) | `QueueStore` via activation loop claim | Yes — runtime enqueued event | FLOWING |
| `src/head/assembler.ts` | `ambientBlock` | `scanAmbient(resolvedWorkspace, this.headId)` reads `ambient/<headId>/*.md` | Yes — per-head filesystem scan | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| weather sensor emits valid JSON | `node ~/.shrok/workspace/sensors/weather/sensor.mjs \| node -e 'JSON.parse(…)'` | "stdout is valid JSON" | PASS |
| `tsc --noEmit` clean | `npx tsc --noEmit` | No output (exit 0) | PASS |
| Full test suite | `npx vitest run` | 2175 passed, 1 skipped (2176 total) | PASS |
| `sensor_event` type exists with priority 15 | `grep -c "SENSOR_EVENT: 15"` | 1 | PASS |
| No single-arg `scanAmbient` call sites remain | `grep -rn "scanAmbient(" src/ \| grep -v ","` | 0 call-expression lines | PASS |
| Old flat DELETE code gone | `grep -c 'path.join(ambientDir, \`${slug}.md\`)' sensors.ts` | 0 | PASS |

---

### Probe Execution

Step 7c: SKIPPED — no conventional probe scripts in `scripts/*/tests/probe-*.sh`. No probes declared in plan files.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SENSOR-13 | Plans 02, 04 | stdout is exactly one JSON object; malformed → error | SATISFIED | `JSON.parse` + type guard in runner.ts; 24 runner tests; SKILL.md documents contract |
| SENSOR-14 | Plans 01, 02, 03 | `ambient` field head-scoped to `ambient/<headId>/<slug>.md`; all read sites scoped | SATISFIED | Per-head write path in runner.ts; all 4 scanAmbient call sites pass headId; isolation tests green |
| SENSOR-15 | Plans 01, 02, 03 | `event` field enqueues `sensor_event` that wakes bound head | SATISFIED | `sensor_event` type + PRIORITY.SENSOR_EVENT; enqueue in runner.ts; `case 'sensor_event'` in injectEvent; injectSensorEvent on InjectorImpl |
| SENSOR-16 | Plans 02, 04 | Target head mandatory, taken from schedule's headId; no per-event head field | SATISFIED | `schedule.headId` threaded from scheduler → runner → enqueue; no `headId` field on `sensor_event` type; SKILL.md and create_schedule description document the mandatory-head contract |

All four phase requirement IDs (SENSOR-13, SENSOR-14, SENSOR-15, SENSOR-16) from REQUIREMENTS.md are SATISFIED.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `~/.shrok/workspace/ambient/weather.md` | — | Stale flat file regenerated by pre-Phase-51 daemon in memory | Warning | File contains raw JSON as body text (not injected by new scanner, not a code defect) — disappears automatically on daemon restart. Deployment artifact, not a code gap. |

No TBD, FIXME, or XXX markers found in phase-modified files.

---

### Human Verification Required

#### 1. Daemon Restart — Flat Ambient File Elimination

**Test:** Run `systemctl --user restart shrok`, wait ~6 minutes for the next weather sensor tick, then check:
```bash
ls ~/.shrok/workspace/ambient/weather.md    # should: No such file or directory
cat ~/.shrok/workspace/ambient/ashley/weather.md   # should: real conditions, no failure marker
grep -c "Sensor failed" ~/.shrok/workspace/ambient/ashley/weather.md  # should: 0
```

**Expected:** The flat `ambient/weather.md` is absent (new runner never writes it). `ambient/ashley/weather.md` holds real weather conditions (no failure marker), confirming the new runner successfully JSON-parsed the sensor output and extracted the `ambient` field.

**Why human:** The live daemon is currently running pre-Phase-51 code in memory and regenerates the flat file every ~5 minutes via the old runner. A daemon restart is required to load the new runner into memory. The code on disk is correct and verified; this is purely a deployment step, not a code gap. Cannot verify programmatically without restarting the daemon (which would require side effects in the live system).

---

### Gaps Summary

No gaps. All must-haves are verified at the code level. The single human verification item (daemon restart to purge the flat file) is a deployment step explicitly acknowledged in the phase's deployment context — the code is correct and the flat file poses no functional harm (the new scanner never reads it).

---

_Verified: 2026-06-18T18:12:00Z_
_Verifier: Claude (gsd-verifier)_
