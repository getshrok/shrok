# Phase 51: Sensor Dual-Sink Rework - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Source:** Live design discussion (discuss-phase skipped — decisions settled in conversation, transcribed here verbatim)

<domain>
## Phase Boundary

Phases 48–49 shipped the `sensor` primitive as a **single passive sink**: a scheduled script prints body text to stdout, the runner writes it to a global `ambient/<slug>.md`, and that file is injected into *every* head's prompt — deliberately bypassing the activation loop (SENSOR-06). Phase 51 reworks the primitive so a single scheduled run produces **one structured JSON payload** that can route to **either or both of two head-scoped sinks**:

1. **Pull / passive (ambient):** a per-head ambient block written to `ambient/<headId>/<slug>.md`, injected only into the owning head's turns.
2. **Push / active (event):** a brand-new `sensor_event` enqueued into the priority queue that flows through the activation loop and *causes the bound head to take a turn*.

The sensor stays a pure, model-free script. The name stays `sensor` — this is wiring the existing scheduled-observation producer into the existing push path **in addition to** the pull path, not a new primitive.

In scope (SENSOR-13, 14, 15, 16):
- Replace the stdout-is-body contract with a **mandatory structured JSON payload** `{ ambient?, event? }`; malformed/unparseable stdout = a sensor error routed through the existing failure path.
- **Per-head ambient**: file layout moves from flat `ambient/<slug>.md` to `ambient/<headId>/<slug>.md`; all three ambient read sites scan only the current head's directory.
- A new **`sensor_event` queue event type** + priority slot + activation-loop/context-assembler handling so the event wakes the bound head, framed honestly as a sensor observation.
- **Mandatory head targeting** via the schedule's existing `headId` (the event fires to it; the ambient file lands under it).
- Rewrite of `skills/sensors/SKILL.md` to the new contract (JSON schema, two sinks, self-watermarking, target/head, examples).
- Whatever minimal dashboard reflection is needed so the Sensors/ambient surface is coherent with per-head output (do not expand scope into SENSOR-F-02).

Out of scope:
- **No runner-level dedup / cooldown / edge-detection** machinery (explicit non-goal — scripts self-watermark like the email-check pattern).
- **SENSOR-F-02** (inline run-now / last-status / last-error surfaced per sensor beyond basic CRUD) — still deferred.
- No back-compat shim for the Phase-48 stdout-is-body format or the flat `ambient/<slug>.md` layout (sensors shipped hours earlier; no external users).
</domain>

<decisions>
## Implementation Decisions

### Payload contract
- **D-01** (SENSOR-13): A sensor script's stdout MUST be **exactly one JSON object**. Shape: `{ "ambient"?: string, "event"?: { ... } }`. Both fields optional. **Neither present = a valid quiet/no-op tick** (the runner does nothing for that sink — see D-04 on whether ambient is cleared). The runner parses stdout as JSON; **any parse failure or non-object/non-conforming shape is a sensor ERROR**, routed through the existing SENSOR-08 failure path (failure marker written to the sensor's head-scoped ambient file). This **replaces** SENSOR-07's "stdout is plain body text" — there is no plain-text fallback.
- **D-02** (SENSOR-13): The exact event sub-schema (`event: { text: string, ... }`) is to be finalized in research/planning, but at minimum carries the **observation text** the head will see. Keep it minimal: the head is the one that decides whether/how to surface it. Do NOT add a per-event head field (targeting is schedule-level — D-07).

### Ambient sink — now per-head
- **D-03** (SENSOR-14): The `ambient` field overwrites the sensor's ambient file at the **head-scoped path `ambient/<headId>/<slug>.md`** (was flat `ambient/<slug>.md`). Per-head subdirectories prevent slug collisions and flat-dir sprawl across heads. The runner remains the sole writer of that file. Use `write-file-atomic`.
- **D-04** (SENSOR-14): All **three** ambient read sites (research-confirmed in Phase 48 — D-08 there) must scan **only the current head's directory** `ambient/<headId>/*.md`, never the whole tree: (1) head assembler (`src/head/assembler.ts`); (2) proactive scheduler (`src/head/activation.ts` `readAmbientContext()` → `src/scheduler/proactive.ts`); (3) sub-agent system prompts (`src/sub-agents/tool-surface.ts`). A sub-agent uses **its spawning head's** directory. The shared ambient-scan function gains a `headId` parameter; each call site passes the head it is assembling for. Heading-from-filename + uncached-region placement (Phase 48 D-06/D-07) are unchanged.
- **D-05** (SENSOR-14): Decide during planning whether a run that omits `ambient` **clears/removes** the existing `ambient/<headId>/<slug>.md` or **leaves it stale**. Recommended default: **leave it** (a quiet tick means "nothing new to say", not "forget what I last reported") — but confirm; this is the one ambient-lifecycle subtlety.

### Event sink — new queue type into the activation loop
- **D-06** (SENSOR-15): Add a **new priority-queue event type `sensor_event`** (alongside `user_message`/`agent_question`/`schedule_trigger`/`reminder_trigger`/`webhook`). The `event` field of a sensor payload enqueues one. It flows through the **existing** ActivationLoop → ContextAssembler → head turn — i.e. it **enters** the activation loop that the ambient path (SENSOR-06) still bypasses. This is the deliberate, scoped extension of SENSOR-06. The head's context must frame it honestly as a sensor observation ("a sensor (`<slug>`) reported: …") that the head decides whether to act on or surface to the user — consistent with shrok's delegation posture.
- **D-07** (SENSOR-16): The **target head is mandatory** and is the sensor schedule's existing `headId` (a `kind:'script'` schedule already carries it — same model as scheduling a task). The `sensor_event` is enqueued **for that headId**; the ambient file (D-03) lands under that headId. No per-event head field; one sensor → one head.
- **D-08** (SENSOR-15): Choose the `sensor_event` **priority** during planning and justify it. Candidates: near `webhook` (20) or `schedule_trigger`/`reminder_trigger` (10). A sensor observation is closer in spirit to a webhook/reminder push than to a user message — lean toward the 10–20 band, below `user_message` (100). Document the choice.

### Cross-cutting
- **D-09**: **Self-watermarking, no systemic dedup.** The runner adds NO dedupeKey/cooldown/edge-detection. A sensor that should fire an event only on a *transition* manages its own state (e.g. a `state.json`/timestamp inside its sensor dir), exactly like the email-check skill decides what counts as "new". This keeps the runner dumb and stateless about semantics. SKILL.md must teach this pattern explicitly with an example.
- **D-10**: **No back-compat.** Delete the stdout-is-body handling and the flat `ambient/<slug>.md` layout outright. Any existing sensor scripts/output created during 48–49 testing are migrated or discarded — do not build a compatibility path. (Confirm whether any real sensors exist in the live workspace; if so, note the one-time migration in the plan.)
- **D-11**: Covered by **vitest**: payload parse (valid both-fields / ambient-only / event-only / empty no-op / malformed→error); per-head ambient write path + per-head scan isolation (head A never sees head B's `ambient/`); `sensor_event` enqueue with the schedule's headId + that it flows through the activation loop to a head turn (contrast SENSOR-06's no-enqueue ambient path, which stays true for ambient-only payloads); failure marker lands at the head-scoped path. `npx tsc --noEmit` clean. Solo trunk-based on `main`; CI is the sole writer of `dashboard/dist/`.

### Claude's Discretion
- Exact `event` sub-schema fields beyond `text` (D-02) — keep minimal; finalize in research/planning.
- The `sensor_event` priority value (D-08) — pick and justify.
- Ambient-on-quiet-tick lifecycle (D-05) — recommended "leave stale"; confirm.
- Exact framing string for the event in the head's context (D-06) — match existing schedule_trigger/reminder_trigger framing conventions in the context assembler.
- Whether per-head ambient needs a one-time on-disk migration of any existing flat `ambient/*.md` (D-10).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** Phase 48's `48-CONTEXT.md` and `48-RESEARCH.md` are the authoritative map of the current sensor implementation — read them first. Verify exact paths/line numbers against the live tree (the codebase may have shifted since Phase 48; e.g. scheduler dispatch may live in `src/scheduler/index.ts` or `src/scheduler/scheduler.ts` — confirm).

### Runner & payload
- `src/sensors/runner.ts` — `runSensor()` spawns the `sensor.mjs` child process (30s timeout, output cap), currently writes truncated stdout → `ambient/<slug>.md` or a failure marker. Rework: parse stdout as JSON, route `ambient`→head-scoped file, `event`→enqueue; needs `headId` threaded in. It is the sole writer of the ambient file and must never throw out of the scheduler tick.
- `src/sensors/scan.ts` — `scanAmbient()` reads `ambient/*.md` flat. Rework: take `headId`, read `ambient/<headId>/*.md` only.

### Ambient injection (three read sites — all must become head-scoped, D-04)
- `src/head/assembler.ts` — calls `scanAmbient` and appends to the system prompt in the **uncached** region (after the `Current time:` marker). Pass the head being assembled for.
- `src/head/activation.ts` — `readAmbientContext()` and its proactive call sites.
- `src/scheduler/proactive.ts` — proactive scheduler ambient consumer.
- `src/sub-agents/tool-surface.ts` — sub-agent system-prompt ambient read; uses the spawning head's dir.

### Scheduler dispatch & wiring
- `src/scheduler/` (the tick/evaluator — `index.ts`/`scheduler.ts`, verify) — the `kind:'script'` branch that fire-and-forget calls the sensor runner. Must pass `schedule.headId` through to the runner.
- `src/index.ts` — wires the `sensorRunner` closure (builds scriptPath/ambientDir). Thread `headId`/the ambient base dir.
- `src/db/schedules.ts` — `Schedule.kind`/`headId`/`taskName`; confirm `kind:'script'` schedules already carry a usable `headId` and that the create path requires it for sensors.

### Queue / activation loop / event framing (the new push path)
- The priority **QueueStore** + `QueueEvent` type union + priority mapping (per AGENTS.md: `user_message`=100, `agent_question`=50, `agent_completed/failed/response`=30, `webhook`=20, `schedule_trigger/reminder_trigger`=10) — add `sensor_event` + its priority (D-08). **Locate the exact file** (research).
- The **ActivationLoop** + **ContextAssembler** — how `schedule_trigger`/`reminder_trigger` events are turned into a head turn and framed in context; mirror that for `sensor_event` (D-06).
- `src/markers.ts` — XML-style system-content builders, for framing the injected event block if needed.

### Tools & docs
- `src/sub-agents/registry.ts` — `create_schedule` tool, `kind:'script'` branch (~lines 799–911 per Phase 48). Update description for the new payload contract / mandatory head target.
- `skills/sensors/SKILL.md` — full rewrite to the new contract: JSON payload schema, the two sinks, self-watermarking guidance + example, mandatory target head, worked examples (e.g. weather: ambient current conditions + event on a storm warning).
- `src/dashboard/routes/sensors.ts` + the dashboard Sensors view — reflect per-head ambient output and the new contract (minimal; no SENSOR-F-02 scope creep).

### Conventions
- `AGENTS.md` (repo root) — `write-file-atomic` for workspace writes; model-facing time invariant; trunk-based on `main` (NO branches/PRs); `node:sqlite` for DB, JSON file-store for schedules/reminders; CI is sole writer of `dashboard/dist/` (do NOT commit dist locally); `npx tsc --noEmit`; tests sharded in CI.
</canonical_refs>

<specifics>
## Specific Ideas

- Canonical worked example — a "Weather" sensor (slug `weather`) bound to head `default`:
  - Payload: `{ "ambient": "72°F, clear, wind 5mph", "event": { "text": "Storm warning issued for your area through 9pm." } }`
  - Ambient sink → overwrite `ambient/default/weather.md` with body `72°F, clear, wind 5mph`; the assembler renders `## Weather\n72°F, clear, wind 5mph` only into head `default`'s uncached prompt region.
  - Event sink → enqueue a `sensor_event` for head `default`; the activation loop wakes `default` with framing like "Sensor `weather` reported: Storm warning issued for your area through 9pm." and the head decides whether to notify the user.
  - A later quiet tick: `{ "ambient": "68°F, light rain" }` → only the ambient file updates; no event. The script self-watermarks the last storm-alert id so it doesn't re-fire the event every 5 minutes.
- Malformed example: a script that prints `Weather: 72F` (not JSON) → sensor error → `ambient/default/weather.md` overwritten with `⚠ Sensor failed on last run: stdout was not valid JSON …`.
</specifics>

<deferred>
## Deferred Ideas

- **SENSOR-F-02**: inline run-now / last-status / last-error surfaced per sensor in the dashboard beyond basic CRUD.
- Runner-level dedup/cooldown/edge-detection — explicitly rejected this phase (scripts self-watermark, D-09).
- Multi-head fan-out of a single sensor (one sensor targeting several heads) — out of scope; one sensor → one head (D-07). Revisit only if a real need appears.
- Per-event severity/priority overrides on the payload — keep the event minimal (D-02); revisit if needed.
</deferred>

---

*Phase: 51-sensor-dual-sink*
*Context gathered: 2026-06-18 via live design discussion (discuss-phase skipped)*
