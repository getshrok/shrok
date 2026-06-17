# Requirements: v1.10 Ambient Context (Sensors)

**Defined:** 2026-06-17
**Core Value:** A single coherent AI identity that remembers everything, works across every channel, and delegates to agents — without ever losing the thread.

**Milestone goal:** Give the model live situational state (weather, smart-home device state, etc.) gathered by user-defined "sensor" scripts on a schedule, injected into every model turn — without busting prompt caching. Sensors are pure scripts: no LLM, no agent. Implements GitHub issue #25.

**Core semantics (apply to every SENSOR requirement):**
- **A sensor is pure code.** It emits plain body text on stdout; no model or agent is ever invoked to run it. (Contrast: a *task* is a prompt run by an agent — that already exists and is unchanged.)
- **One output file per sensor.** A sensor named `Weather` (slug `weather`) owns `{workspace}/ambient/weather.md`. The runner is the sole writer of that file.
- **Uncached injection.** The assembled `ambient/*.md` block is placed AFTER the `\n\nCurrent time:` marker that `toAnthropicSystem` (`src/llm/anthropic.ts`) splits on for `cache_control`, so frequent sensor updates never invalidate the cached system-prompt prefix.
- **No last-good, no freshness stamps.** On failure the output file is overwritten with the error (sensors are cheap and refresh often → a stale block means genuinely broken, which the error already signals).

## v1 Requirements

### Sensor Management

- [x] **SENSOR-01**: Operator can create a sensor (name + script body) in a dedicated dashboard "Sensors" section, parallel to Tasks.
- [x] **SENSOR-02**: Operator can edit an existing sensor's name and script body from the Sensors section.
- [x] **SENSOR-03**: Operator can delete a sensor from the Sensors section, removing its script and its `ambient/<slug>.md` output.
- [x] **SENSOR-04**: Operator can hand-edit a sensor's script directly on disk and the Sensors section reflects it (filesystem and dashboard are two views of the same files).

### Scheduling

- [x] **SENSOR-05**: Operator can schedule a sensor to run on a cron interval through the existing Schedules UI (a sensor schedule is `Schedule.kind:'script'`, the third kind alongside `'task'`/`'reminder'`).
- [x] **SENSOR-06**: A scheduled sensor runs directly in the scheduler tick — no queue event, no context assembly, no model invocation — bypassing the activation loop entirely.

### Runner & Output

- [x] **SENSOR-07**: On a successful run, the sensor's captured stdout, truncated to a maximum length, is written to `ambient/<slug>.md`.
- [x] **SENSOR-08**: On a failed run (throw, non-zero exit, or timeout), `ambient/<slug>.md` is overwritten with actionable error text that includes the trimmed error message.
- [x] **SENSOR-09**: A sensor runs once immediately on create/enable/save, so its first output appears without waiting for the next scheduled tick.

### Injection

- [x] **SENSOR-10**: Sensor output is injected into every model turn as a fresh scan of `ambient/*.md`, each block labeled by a filename-derived heading (`weather.md` → `## Weather`), placed in the uncached system-prompt region so updates never bust prompt caching.
- [x] **SENSOR-11**: The same ambient scan feeds both the head's own turns (assembler) and the proactive scheduler, so proactive runs see the same situational state.

### Cleanup

- [x] **SENSOR-12**: The legacy single-file `AMBIENT.md` mechanism is removed (both the assembler injection and `readAmbientContext`), eliminating its current above-the-cache-split injection bug.

## v2 Requirements (deferred)

### Sensor Enhancements

- **SENSOR-F-01**: Per-head ambient scoping (a head sees only its own sensors' output).
- **SENSOR-F-02**: Inline run-now / last-status / last-error surfaced per sensor in the dashboard beyond the basic CRUD.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-head ambient scoping | Global only this milestone — one `ambient/` folder feeds all heads. Deferred to SENSOR-F-01. |
| LLM/agent-driven gathering | That is exactly what a scheduled *task* already is; sensors are deliberately model-free. |
| Sandboxed secret model for sensor scripts | Scripts inherit the server env / workspace `.env`, same trust as task write-along scripts. |
| Last-good preservation + freshness stamps | Explicitly rejected — would force a strict parsable markdown schema; overwrite-with-error is the chosen failure model. |

## Traceability

Which phases cover which requirements. Filled during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SENSOR-01 | Phase 49 | Complete |
| SENSOR-02 | Phase 49 | Complete |
| SENSOR-03 | Phase 49 | Complete |
| SENSOR-04 | Phase 49 | Complete |
| SENSOR-05 | Phase 49 | Complete |
| SENSOR-06 | Phase 48 | Complete |
| SENSOR-07 | Phase 48 | Complete |
| SENSOR-08 | Phase 48 | Complete |
| SENSOR-09 | Phase 48 | Complete |
| SENSOR-10 | Phase 48 | Complete |
| SENSOR-11 | Phase 48 | Complete |
| SENSOR-12 | Phase 48 | Complete |
