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

## v1.10.1 Requirements — Sensor Dual-Sink Rework (Phase 51)

**Context:** Phases 48–49 shipped sensors as a single passive sink (stdout body → global `ambient/<slug>.md` → every head's prompt, bypassing the activation loop). Phase 51 reworks the primitive so one scheduled run can route its observation to **two head-scoped sinks**: a passive per-head ambient block (pull) and/or an active event that wakes the bound head (push). No back-compat is preserved — sensors shipped hours earlier and have no external users. These requirements **redefine** the contract of SENSOR-06/07/08/10/11 (see Traceability notes) and **implement** the previously-deferred SENSOR-F-01.

- [ ] **SENSOR-13**: A sensor script's stdout is exactly **one structured JSON object** `{ ambient?: string, event?: {...} }`. Both fields are optional — emitting neither is a valid quiet/no-op tick. Non-conforming or unparseable stdout is a **sensor error** (fail loud), handled by the SENSOR-08 failure path (error marker written to the sensor's ambient file). This **supersedes** SENSOR-07's "stdout is plain body text".
- [x] **SENSOR-14**: The `ambient` field is **head-scoped**: written to `ambient/<headId>/<slug>.md` and injected **only into the owning head's** turns. All three ambient read sites (head assembler, proactive/activation scheduler, sub-agent tool-surface) scan only the current head's directory. This **implements SENSOR-F-01** and **supersedes** the global flat `ambient/<slug>.md` of SENSOR-10/11.
- [x] **SENSOR-15**: The `event` field enqueues a **new `sensor_event` priority-queue type** that flows through the existing activation loop and **causes the bound head to take a turn**, framed honestly as a sensor observation the head decides whether to act on / surface. This **extends** SENSOR-06 — the event path now *enters* the activation loop the ambient path still bypasses.
- [ ] **SENSOR-16**: A sensor's **target head is mandatory**, taken from its schedule's existing `headId` field (same model as scheduling a task). The event fires to that head; the ambient file lands under that head's directory. No per-event head field — one sensor is bound to exactly one head.

**Non-goals (Phase 51):** No runner-level dedup/cooldown/edge-detection machinery — sensor scripts self-watermark (own `state.json`/timestamp in the sensor dir), exactly like the email-check pattern. The runner stays stateless about what counts as "new".

## v2 Requirements (deferred)

### Sensor Enhancements

- **SENSOR-F-01**: Per-head ambient scoping (a head sees only its own sensors' output). → **Promoted to Phase 51 as SENSOR-14.**
- **SENSOR-F-02**: Inline run-now / last-status / last-error surfaced per sensor in the dashboard beyond the basic CRUD.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-head ambient scoping | ~~Global only this milestone — one `ambient/` folder feeds all heads. Deferred to SENSOR-F-01.~~ **Now in scope — Phase 51 (SENSOR-14).** |
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
| SENSOR-06 | Phase 48 | Complete (event path extended by Phase 51 / SENSOR-15) |
| SENSOR-07 | Phase 48 | Complete (superseded by Phase 51 / SENSOR-13) |
| SENSOR-08 | Phase 48 | Complete (failure path reused by Phase 51 / SENSOR-13) |
| SENSOR-09 | Phase 48 | Complete |
| SENSOR-10 | Phase 48 | Complete (head-scoped by Phase 51 / SENSOR-14) |
| SENSOR-11 | Phase 48 | Complete (head-scoped by Phase 51 / SENSOR-14) |
| SENSOR-12 | Phase 48 | Complete |
| SENSOR-13 | Phase 51 | Pending |
| SENSOR-14 | Phase 51 | Complete |
| SENSOR-15 | Phase 51 | Complete |
| SENSOR-16 | Phase 51 | Pending |
