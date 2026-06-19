# Phase 51: Sensor Dual-Sink Rework - Research

**Researched:** 2026-06-18
**Domain:** TypeScript/Node 22 — priority-queue event extension + child-process JSON contract + per-head ambient injection
**Confidence:** HIGH — every claim is from direct inspection of the live tree (the Phase 48/49 sensor code is already merged and read line-by-line). No external sources needed.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01** (SENSOR-13): stdout MUST be exactly one JSON object `{ "ambient"?: string, "event"?: { ... } }`. Both optional. Neither present = valid quiet/no-op tick. Any parse failure / non-object / non-conforming shape is a **sensor ERROR**, routed through the existing SENSOR-08 failure path (failure marker → head-scoped ambient file). Replaces SENSOR-07's plain-text body; **no plain-text fallback**.
- **D-02** (SENSOR-13): The `event` sub-schema is finalized in research/planning; at minimum it carries the **observation text** the head sees. Keep minimal — the head decides whether/how to surface. **Do NOT add a per-event head field** (targeting is schedule-level, D-07).
- **D-03** (SENSOR-14): `ambient` overwrites the head-scoped file `ambient/<headId>/<slug>.md` (was flat `ambient/<slug>.md`). Runner is sole writer. Use `write-file-atomic`.
- **D-04** (SENSOR-14): All **three** ambient read sites scan **only the current head's dir** `ambient/<headId>/*.md`: (1) head assembler; (2) proactive/activation; (3) sub-agent tool-surface (uses its spawning head's dir). The shared scan fn gains a `headId` param; each call site passes the head it assembles for. Heading-from-filename + uncached-region placement unchanged.
- **D-05** (SENSOR-14): Decide whether a run omitting `ambient` **clears** or **leaves stale** `ambient/<headId>/<slug>.md`. Recommended: **leave stale**; confirm.
- **D-06** (SENSOR-15): Add a new `sensor_event` queue type. Its `event` field enqueues one. Flows through the **existing** ActivationLoop → ContextAssembler → head turn — it *enters* the loop the ambient path bypasses. Context frames it honestly as a sensor observation ("a sensor (`<slug>`) reported: …") the head decides whether to act on / surface.
- **D-07** (SENSOR-16): Target head is **mandatory** = the schedule's existing `headId` (`kind:'script'` already carries it). Event enqueued for that headId; ambient lands under that headId. No per-event head field; one sensor → one head.
- **D-08** (SENSOR-15): Choose the `sensor_event` priority + justify. Lean 10–20 band, below `user_message` (100). Document the choice.
- **D-09**: Self-watermarking, no systemic dedup. Runner adds NO dedupeKey/cooldown/edge-detection. Transition-only events are the script's responsibility (own `state.json`/timestamp). SKILL.md must teach this with an example.
- **D-10**: No back-compat. Delete the stdout-is-body handling + the flat `ambient/<slug>.md` layout outright. Migrate or discard any existing sensors. Confirm whether real sensors exist.
- **D-11**: Vitest covers payload parse (both / ambient-only / event-only / empty no-op / malformed→error); per-head write + per-head scan isolation (head A never sees head B's ambient); `sensor_event` enqueue with the schedule's headId + flow through the activation loop to a head turn (contrast ambient-only = no enqueue); failure marker at the head-scoped path. `npx tsc --noEmit` clean. Solo trunk on `main`; CI sole writer of `dashboard/dist/`.

### Claude's Discretion
- Exact `event` sub-schema fields beyond `text` (D-02) — keep minimal.
- The `sensor_event` priority value (D-08) — pick + justify.
- Ambient-on-quiet-tick lifecycle (D-05) — recommended "leave stale".
- Exact framing string for the event (D-06) — match existing schedule/reminder framing.
- Whether per-head ambient needs a one-time on-disk migration of existing flat `ambient/*.md` (D-10).

### Deferred Ideas (OUT OF SCOPE)
- **SENSOR-F-02**: inline run-now / last-status / last-error per sensor in dashboard beyond basic CRUD.
- Runner-level dedup/cooldown/edge-detection (D-09 rejects).
- Multi-head fan-out of one sensor (one sensor → one head, D-07).
- Per-event severity/priority overrides (keep event minimal, D-02).
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SENSOR-13 | stdout = one JSON object `{ambient?, event?}`; malformed → sensor error via SENSOR-08 path | §Runner Rework; the `runSensor` JSON-parse + route-or-error design below |
| SENSOR-14 | `ambient` head-scoped to `ambient/<headId>/<slug>.md`; all 3 read sites scan only current head's dir | §Per-Head Ambient; all 4 `scanAmbient` call sites + runner write path located |
| SENSOR-15 | New `sensor_event` queue type flows through the activation loop → head turn | §The Push Path; exact type-union + dispatch + injector + framing seams located |
| SENSOR-16 | Target head mandatory = schedule's `headId` (already carried) | §Head Targeting; `headId` confirmed set at create + available at scheduler tick |
</phase_requirements>

---

## Summary

Phase 51 is pure TypeScript codebase surgery — no new packages, no external APIs. The Phase 48/49 sensor primitive is already merged and reads cleanly; this phase reshapes it along three axes:

1. **Contract** — the runner stops writing raw stdout to the ambient file. It now parses stdout as one JSON object and routes `ambient`→a head-scoped file and `event`→a new queue enqueue. Malformed stdout reuses the existing failure-marker path.
2. **Per-head ambient** — the flat `ambient/<slug>.md` layout becomes `ambient/<headId>/<slug>.md`. The shared `scanAmbient()` already feeds all reads from one function; it gains a `headId` parameter and every one of its **four** call sites already has a head in scope.
3. **The push path** — a brand-new `sensor_event` queue type. The QueueStore is type-agnostic (it serializes the whole event as JSON), so the new type touches only four places in code: the `QueueEvent` union + `PRIORITY` map (`src/types/core.ts`), the `injectEvent` dispatch switch + `formatInjectedEvent` debug formatter (`src/head/activation.ts`), and a new injector method (`src/head/injector.ts`). The `webhook`/`head_message` injector pattern (`systemEvent` + a `systemTrigger('respond')` pair) is the exact template to copy.

**Primary recommendation:** Mirror the `webhook` event for the push path (new `QueueEvent` member + `PRIORITY.SENSOR_EVENT` + `injectSensorEvent` modeled on `injectWebhookEvent`). Change the `SensorRunner.run` signature to `run(slug, headId)`, inject the `QueueStore` into the `sensorRunner` closure in `src/index.ts`, and have the runner JSON-parse stdout, write `ambient/<headId>/<slug>.md`, and enqueue a `sensor_event` for `headId`. Thread `headId` through `scanAmbient` at all four call sites. **One live sensor (`weather`, head `ashley`) needs a one-time migration.**

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Sensor script execution + JSON parse | Runner (server process) | — | Stays inline in the scheduler tick; never touches the model tier |
| Ambient sink (per-head file write) | Runner | — | Runner is sole writer of `ambient/<headId>/<slug>.md` (D-03) |
| Event sink (enqueue) | Runner → QueueStore | ActivationLoop (consumes) | Runner produces the `sensor_event`; the head's activation loop wakes and runs the turn |
| Event framing into model context | Injector (`src/head/injector.ts`) | ContextAssembler (`deriveQueryText`) | Same tier that frames `webhook`/`head_message` |
| Per-head ambient injection (head) | Head assembler | — | `this.headId` is in scope; uncached region after `Current time:` |
| Per-head ambient injection (proactive) | Activation loop proactive branch | — | `this.opts.headId` in scope |
| Per-head ambient injection (sub-agent) | Sub-agent tool-surface | — | `deps.headId` (spawning head) in scope |
| Head targeting (which head a sensor binds to) | Schedule row `headId` | create_schedule tool / dashboard route | Already set from the per-head tool-registry closure / validated req body |

---

## Standard Stack

No new npm packages. Every API needed is already imported in the touched files:

| Module | Already Used In | Purpose in Phase 51 |
|--------|-----------------|---------------------|
| `node:child_process` `execFile` | `src/sensors/runner.ts` | Unchanged — still spawns the sensor |
| `JSON.parse` (stdlib) | everywhere | Parse stdout to the payload object |
| `write-file-atomic` (sync) | `src/db/file-store.ts`, `src/sensors/runner.ts` | Write head-scoped ambient file |
| `node:fs` / `node:path` | throughout | `mkdirSync(ambient/<headId>)`, `readdirSync` |
| `QueueStore.enqueue` | `src/db/queue.ts` | Enqueue the new `sensor_event` |
| `systemEvent` / `systemTrigger` (`src/markers.ts`) | `src/head/injector.ts` | Frame the event for the model |
| `vitest` | throughout | Tests |

**Installation:** none needed.

**Version verification:** N/A — no packages added. `package.json` is unchanged by this phase.

## Package Legitimacy Audit

> No external packages are installed in this phase. Section not applicable. (slopcheck / registry verification not run — nothing to verify.)

---

## Architecture Patterns

### System Architecture Diagram

```
SCHEDULER TICK (src/scheduler/index.ts tick())
  getDue() → [kind:'script' schedule {headId, taskName=slug}]
    └─ sensorRunner.run(slug, schedule.headId)        ← NEW 2nd arg (headId)
         │  (fire-and-forget; .catch logs; never throws out of tick)
         ▼
RUNNER (src/sensors/runner.ts runSensor(slug, headId, scriptPath, ambientBaseDir, queue, ...))
  execFile(node, [scriptPath], {timeout:30s})
    ├─ err (non-zero / throw / timeout)
    │    └─ writeFileAtomic(ambient/<headId>/<slug>.md, "⚠ Sensor failed on last run: …")   ← SENSOR-08 reused
    └─ success → stdout
         ├─ JSON.parse(stdout)
         │    ├─ parse fails / not a plain object → SAME failure-marker path (D-01)
         │    └─ ok → { ambient?, event? }
         │         ├─ ambient (string)  → writeFileAtomic(ambient/<headId>/<slug>.md, body)   ← PULL sink
         │         │   (omitted → leave stale per D-05 recommendation)
         │         └─ event ({text,...}) → queue.enqueue({type:'sensor_event', slug, text,...},
         │                                                PRIORITY.SENSOR_EVENT, headId)        ← PUSH sink
         │                                  (omitted → no enqueue; SENSOR-06 still holds for ambient-only)

ACTIVATION LOOP (src/head/activation.ts — the bound head's loop)
  claimNext(headId) → sensor_event
    └─ event.type !== 'user_message' branch:
         injectEvent(event) → injector.injectSensorEvent(event)         ← NEW dispatch case + method
              ├─ append assistant msg: systemEvent('sensor', {slug}, text)
              └─ append user msg: systemTrigger('respond')              ← wakes the head to take a turn
    └─ assembler.assemble(event) → head turn (model decides to surface / act / ignore)

PER-HEAD AMBIENT (PULL — unchanged loop path, now head-scoped)
  scanAmbient(workspaceDir, headId) → reads ambient/<headId>/*.md only
    ├─ assembler.ts (this.headId)            → uncached region after "Current time:"
    ├─ activation.ts proactive (this.opts.headId)  → reminder + task proactive decisions
    └─ tool-surface.ts (deps.headId)         → sub-agent system prompt
```

### Recommended Project Structure

```
src/types/core.ts          # +EDIT: QueueEvent union += sensor_event; PRIORITY += SENSOR_EVENT
src/sensors/
├── runner.ts              # +EDIT: JSON parse + dual-sink route; signature gains headId + queue handle
├── runner.test.ts         # +EDIT: parse matrix, dual-sink, head-scoped path, failure marker
├── scan.ts                # +EDIT: scanAmbient(workspaceDir, headId) → reads ambient/<headId>/*.md
└── scan.test.ts           # +EDIT: per-head dir; isolation head A vs head B
src/scheduler/index.ts     # +EDIT: pass schedule.headId to sensorRunner.run(slug, headId)
src/index.ts               # +EDIT: sensorRunner closure gains headId param + closes over `queue`
src/head/
├── injector.ts            # +EDIT: new injectSensorEvent() (mirror injectWebhookEvent)
├── activation.ts          # +EDIT: injectEvent switch += sensor_event; formatInjectedEvent += case;
│                          #         4 scanAmbient calls gain headId (2 here)
├── assembler.ts           # +EDIT: scanAmbient(resolvedWorkspace, this.headId); deriveQueryText case
└── injector.test.ts       # +EDIT: sensor_event injection shape
src/sub-agents/tool-surface.ts  # +EDIT: scanAmbient(deps.workspacePath, deps.headId)
src/dashboard/routes/sensors.ts # +EDIT: DELETE must clear ambient/<headId>/<slug>.md (see Pitfall 5)
dashboard/src/pages/SensorsPage.tsx # +EDIT (minimal): reflect per-head, do NOT add SENSOR-F-02
skills/sensors/SKILL.md    # full rewrite to JSON contract + 2 sinks + self-watermark + head target
```

### Pattern 1: Adding a new QueueEvent type (the push path template)

**What:** The QueueStore (`src/db/queue.ts`) is fully type-agnostic — `enqueue` does `payload: JSON.stringify(event)` and `claimNext` does `JSON.parse(row.payload)`. **No QueueStore, SQL, or migration change is needed for a new event type.** The type is registered purely in TypeScript-land + the dispatch sites.

**The four code touch-points for a new type** (verified against `webhook`/`head_message`):
```typescript
// 1. src/types/core.ts — add to the QueueEvent discriminated union
| {
    type: 'sensor_event'
    id: string
    slug: string          // which sensor reported (the schedule's taskName/slug)
    text: string          // the observation text (D-02 minimum)
    createdAt: string
  }
// 2. src/types/core.ts — add to PRIORITY (D-08, see recommendation below)
SENSOR_EVENT: 15,         // between WEBHOOK(20) and SCHEDULE_TRIGGER(10)
// 3. src/head/activation.ts injectEvent() switch — dispatch to the new injector method
case 'sensor_event':
  this.opts.injector.injectSensorEvent(event)
  break
// 4. src/head/activation.ts formatInjectedEvent() — debug-log formatter case
case 'sensor_event':
  return systemEvent('sensor', { slug: event.slug }, event.text.slice(0, 300))
```
Plus a new injector method (Pattern 2) and a `deriveQueryText` case in the assembler (memory-retrieval query text):
```typescript
// src/head/assembler.ts deriveQueryText() switch
case 'sensor_event':
  return trigger.text
```

**When to use:** This is the canonical shrok way to introduce an event that wakes a head. `sensor_event` is closest in spirit to `webhook` (an external observation pushed in) — copy that, not `schedule_trigger` (which is a scheduler-internal dispatch handled by a separate early-return `handleScheduleTrigger`, NOT through `injectEvent`).

### Pattern 2: The injector method (frame the event into model context)

**What:** `injectWebhookEvent` and `injectHeadMessage` (`src/head/injector.ts:265-315`) are the exact template. They append **two** messages: an assistant-role `systemEvent(...)` carrying the observation, then a user-role `systemTrigger('respond')` that prompts the head to take a turn.

**Example (source: `src/head/injector.ts` injectWebhookEvent, adapted):**
```typescript
// src/head/injector.ts — new method on InjectorImpl + Injector interface
injectSensorEvent(event: QueueEvent & { type: 'sensor_event' }): void {
  const eventMsg: TextMessage = {
    kind: 'text', id: generateId('msg'), createdAt: now(),
    role: 'assistant',
    content: systemEvent('sensor', { slug: event.slug }, event.text),
    injected: true,
  }
  const triggerMsg: TextMessage = {
    kind: 'text', id: generateId('msg'), createdAt: now(),
    role: 'user',
    content: systemTrigger('respond'),
    injected: true,
  }
  this.messages.append(eventMsg, this.headId)
  this.messages.append(triggerMsg, this.headId)
}
```
The `Injector` interface (`src/head/injector.ts:136-140`) must add `injectSensorEvent(event: ...): void`.

**Framing string (D-06 discretion):** `systemEvent('sensor', { slug }, text)` renders as
`<system-event type="sensor" slug="weather" user-visible="false">Storm warning issued…</system-event>`.
This matches the honest-observation framing the CONTEXT wants. The SOUL/SYSTEM identity already teaches the head to treat `<system-event>` as a structural delimiter and decide whether to surface — no extra body instruction needed (the `webhook` path carries none).

### Pattern 3: Runner JSON parse + dual-sink route

**What:** Replace the `else` (success) branch of `runSensor`'s `execFile` callback. The error branch (failure marker) is reused verbatim for both process failure AND malformed-JSON (D-01).

**Example (source: current `src/sensors/runner.ts`, reworked):**
```typescript
// success branch — was: writeFileSync(outputPath, stdout.slice(0, CAP))
let payload: unknown
try {
  payload = JSON.parse(stdout.trim())
} catch {
  writeFailure(outputPath, 'stdout was not valid JSON')   // D-01 → SENSOR-08 path
  return resolve()
}
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
  writeFailure(outputPath, 'stdout was not a JSON object')
  return resolve()
}
const { ambient, event } = payload as { ambient?: unknown; event?: unknown }
// (validate shapes: ambient must be string|undefined; event must be {text:string}|undefined)
if (typeof ambient === 'string') {
  writeFileSync(outputPath, ambient.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
}
// ambient omitted → leave the file as-is (D-05 recommendation: leave stale)
if (event && typeof event === 'object' && typeof (event as any).text === 'string') {
  queue.enqueue(
    { type: 'sensor_event', id: generateId('qe'), slug, text: (event as any).text, createdAt: new Date().toISOString() },
    PRIORITY.SENSOR_EVENT, headId,
  )
}
resolve()
```
**Note:** `outputPath` becomes `path.join(ambientBaseDir, headId, `${slug}.md`)` and `mkdirSync(path.join(ambientBaseDir, headId), {recursive:true})` runs first.

### Anti-Patterns to Avoid
- **Do NOT enqueue a `user_message` to wake the head** (the way `handleScheduleTrigger`'s reminder branch re-enqueues a `user_message` with `systemTrigger('reminder', …)`). The CONTEXT explicitly wants a distinct `sensor_event` type so it gets its own priority slot and honest framing. The reminder pattern is a legacy convenience, not the model to copy here.
- **Do NOT route the event through `handleScheduleTrigger`.** That function is the scheduler-internal dispatch for `schedule_trigger` (tasks + reminders) and returns early in the activation loop (`activation.ts:521`). `sensor_event` is a first-class event that flows through the normal `event.type !== 'user_message'` injection path.
- **Do NOT let the runner throw out of the scheduler tick.** The runner is fire-and-forget with a `.catch` in `tick()` (`scheduler/index.ts:74`). Keep `runSensor`'s promise always-resolving (its current contract). Wrap the enqueue in try/catch so a queue error writes a failure marker instead of rejecting.
- **Do NOT add the `event` text to the ambient file or vice-versa.** Two independent sinks; either, both, or neither.

---

## The Push Path — Detailed Seam Map (least-charted, highest value)

### Queue type union + priority — `src/types/core.ts` [VERIFIED: direct read]

The `QueueEvent` discriminated union is at **lines 83-157**; `QueueEventType = QueueEvent['type']` at 159; the `PRIORITY` const at **162-174**:
```typescript
export const PRIORITY = {
  USER_MESSAGE: 100,
  HEAD_MESSAGE: 70,
  AGENT_QUESTION: 50,
  AGENT_COMPLETED: 30, AGENT_FAILED: 30, AGENT_RESPONSE: 30,
  WEBHOOK: 20,
  SCHEDULE_TRIGGER: 10, REMINDER_TRIGGER: 10,
} as const
```
(AGENTS.md's documented list is accurate; `head_message`=70 was added since and is also present.)

### Priority recommendation (D-08): **`SENSOR_EVENT: 15`**

**Justification:** A sensor observation is an external/environmental push, exactly like a `webhook` (20) — but a sensor fires on a cadence the operator chose and is explicitly the *passive-observation* sibling of the ambient sink, so it should not outrank a genuine inbound `webhook` from a third-party system. It should rank **above** `schedule_trigger`/`reminder_trigger` (10) because those are scheduler-internal dispatches that themselves spawn work or re-enqueue, whereas a `sensor_event` is already a fully-formed observation ready to wake the head. **15 sits cleanly between WEBHOOK(20) and SCHEDULE_TRIGGER(10)** with no collisions, keeping it firmly in the 10–20 band the CONTEXT specified and well below `user_message`(100) and `head_message`(70). (Alternative: reuse 10 alongside the triggers — acceptable, but 15 makes ordering deterministic vs. the trigger events and documents intent.)

### QueueStore — `src/db/queue.ts` [VERIFIED: direct read]

**No change required.** `enqueue(event, priority, headId)` (line 115) serializes the whole event with `JSON.stringify` into the `payload` column; `claimNext` (130) and the coalescing claims `JSON.parse` it back. The schema (`queue_events` table: `id,type,payload,priority,status,created_at,processed_at,head_id`) stores `type` as an opaque string and never switches on it. A new `QueueEvent` member is transparently persisted and round-tripped.

### How an event becomes a head turn + coalescing — `src/head/activation.ts` [VERIFIED: direct read]

The activation loop claims an event via `claimNext(headId)`, then:
- `schedule_trigger` is special-cased early (`activation.ts:521` → `handleScheduleTrigger`, returns). **`sensor_event` does NOT go here.**
- For all other non-`user_message` events: the loop coalesces sibling background events via `claimAllPendingBackground(headId)` (`activation.ts:641`), which claims **all pending non-`user_message` rows for the head** (`queue.ts:88-95`). A burst of `sensor_event`s for one head will coalesce into one activation — desirable (one head turn sees multiple sensor observations rather than N turns).
- Then `injectEvent(ev)` is called for each coalesced + the primary (`activation.ts:728-736`), inside a transaction with the queue `ack`.
- Then `assembler.assemble(event)` builds context and the model runs.

**The `injectEvent` switch (`activation.ts:1319-1336`) silently no-ops for unhandled types** — so a `sensor_event` that is NOT added to the switch would be claimed, acked, and produce NO injected message (a silent black hole). **Adding the `case 'sensor_event'` is mandatory**, not optional.

**`formatInjectedEvent` (`activation.ts:1448-1467`)** is a debug-log helper with a `default: JSON.stringify(event).slice(0,150)` fallback — adding a case is nice-to-have for clean logs, low-risk if omitted.

### Reminder vs schedule_trigger framing (the templates the CONTEXT pointed at)

- A **reminder** is a `schedule_trigger` with `kind:'reminder'`; `handleScheduleTrigger` (`activation.ts:1101-1186`) re-enqueues a **`user_message`** carrying `systemTrigger('reminder', …, message)` text. This is the "wake via user_message" legacy pattern — **do not copy for sensors** (see Anti-Patterns).
- A **webhook** is the clean template: `injectWebhookEvent` (`injector.ts:265-289`) appends `systemEvent('webhook', …)` + `systemTrigger('respond')`. **Copy this.**

---

## Head Targeting (SENSOR-16) [VERIFIED: direct read]

- `Schedule.headId: string` is **required** (`src/db/schedules.ts:5`); `kind: 'task' | 'reminder' | 'script'` (line 7) — the `'script'` value is already present (Phase 48). `CreateScheduleOptions.headId` is also required (line 38).
- **`headId` is already stamped on every `kind:'script'` schedule at create time** from the per-head tool-registry closure: `createOpts = { id, headId, taskName, kind }` (`src/sub-agents/registry.ts:903`), and from the validated request body in the dashboard route (`src/dashboard/routes/schedules.ts:193`, with head-existence validation at lines 31-39). So head targeting works end-to-end today with no schema change.
- At the scheduler tick, `schedule.headId` is in scope at the `kind:'script'` branch (`scheduler/index.ts:66-77`) — it is what must be passed to `sensorRunner.run(slug, headId)`.
- The runner then enqueues `sensor_event` for that exact `headId`, and writes ambient under that `headId` — single source of truth, no per-event head field (D-07 honored).

**End-to-end headId flow:** create_schedule/dashboard (closure/req.body) → `Schedule.headId` → scheduler tick (`schedule.headId`) → `sensorRunner.run(slug, headId)` → runner enqueues `sensor_event` w/ `headId` + writes `ambient/<headId>/<slug>.md` → `claimNext(headId)` in that head's loop.

---

## Per-Head Ambient (SENSOR-14) [VERIFIED: direct read]

### The shared scan — `src/sensors/scan.ts`
Current signature: `scanAmbient(workspaceDir: string): string` reads `{workspaceDir}/ambient/*.md`. **Rework:** `scanAmbient(workspaceDir: string, headId: string): string` reads `{workspaceDir}/ambient/{headId}/*.md`. The `slugToTitle` helper and heading derivation are unchanged. The empty-dir-returns-`''` behavior is unchanged (an absent `ambient/<headId>/` dir is not an error).

### The runner write path — `src/sensors/runner.ts`
Output path moves from `path.join(ambientDir, `${slug}.md`)` to `path.join(ambientBaseDir, headId, `${slug}.md`)`, with `mkdirSync(path.join(ambientBaseDir, headId), {recursive:true})`. The failure-marker write moves to the same head-scoped path (D-11: "failure marker lands at the head-scoped path").

### The four `scanAmbient` call sites — all have a head in scope [VERIFIED]

| Call site | File:line | Head available as | Notes |
|-----------|-----------|-------------------|-------|
| Head assembler | `src/head/assembler.ts:146` | `this.headId` (ctor arg, default `'default'`) | Uncached region, after `Current time:` line 130. Unchanged placement. |
| Proactive — reminder | `src/head/activation.ts:1140` | `this.opts.headId` | Inside `runReminderDecision` ctx |
| Proactive — task | `src/head/activation.ts:1217` | `this.opts.headId` | Inside `runProactiveDecision` ctx |
| Sub-agent tool-surface | `src/sub-agents/tool-surface.ts:82` | `deps.headId` (required field, line 33) | Uses the **spawning head's** dir per D-04 |

> CONTEXT.md D-04 lists "three" read sites; there are in fact **four `scanAmbient` calls** (the proactive consumer is split across two call sites — reminder + task — both in `activation.ts`). All four thread `headId` trivially. (Phase 48 already replaced the legacy `AMBIENT.md` reads with `scanAmbient`, so there are no `AMBIENT.md` reads left to delete.)

### Uncached-region constraint (unchanged)
`toAnthropicSystem` (`src/llm/anthropic.ts`) splits the system prompt on `\n\nCurrent time:` — everything before is `cache_control: ephemeral`, everything after is uncached. The assembler already appends the ambient block AFTER the `Current time:` line (`assembler.ts:144-148`); tool-surface does the same after its own time line (`tool-surface.ts:77-83`). Per-head scoping does not change placement — only the directory read.

---

## Runner + Scheduler Wiring (the new QueueStore dependency)

### Current signatures [VERIFIED: direct read]
- `runSensor(slug, scriptPath, ambientDir, timeoutMs=SENSOR_TIMEOUT_MS): Promise<void>` (`runner.ts:44`).
- `SensorRunner` interface: `{ run(slug: string): Promise<void> }` (`runner.ts:20-22`).
- The closure in `src/index.ts:514-520` binds `scriptPath = workspacePath/sensors/<slug>/sensor.mjs` and `ambientDir = workspacePath/ambient`, then calls `runSensor(slug, scriptPath, ambientDir)`.
- The scheduler calls `this.sensorRunner.run(slug)` at `scheduler/index.ts:74` (slug from `schedule.taskName`).

### What must change
1. **`SensorRunner.run` signature → `run(slug: string, headId: string): Promise<void>`.** The scheduler passes `schedule.headId` (in scope at `scheduler/index.ts:66-77`).
2. **The runner needs a QueueStore handle (NEW dependency — it has none today).** Cleanest injection: pass `queue` into the `sensorRunner` closure in `src/index.ts`, where `queue` (the `QueueStore`) is already in scope at line 521 (it is the first arg to `new ScheduleEvaluatorImpl(queue, …)`). The closure becomes:
   ```typescript
   const sensorRunner = {
     run(slug: string, headId: string): Promise<void> {
       const scriptPath = path.join(workspacePath, 'sensors', slug, 'sensor.mjs')
       const ambientBaseDir = path.join(workspacePath, 'ambient')
       return runSensor(slug, headId, scriptPath, ambientBaseDir, queue)
     },
   }
   ```
   `runSensor`'s signature gains `headId` and `queue: QueueStore` (or a narrower `{ enqueue: ... }` interface for testability — recommend a minimal interface to keep `runner.test.ts` from needing a real DB). This keeps the runner pure-ish: it imports `PRIORITY` from `types/core.js` and `generateId` from `llm/util.js` (both already used across the codebase).
3. **No scheduler-store or schema change.** `schedule.headId` is already populated.

### Why inject the QueueStore vs. a callback
A narrow `interface SensorEventSink { enqueue(event, priority, headId): void }` (structurally satisfied by `QueueStore`) injected into `runSensor` keeps unit tests trivial (pass a `vi.fn()` spy) and avoids a hard `runner.ts → db/queue.ts` import cycle concern. Either works; the narrow-interface approach is the more testable.

---

## Tool + Skill + Dashboard Surface

### `create_schedule` tool — `src/sub-agents/registry.ts:798-911` [VERIFIED]
The `kind:'script'` branch already exists (slug validation, cadence requirement, immediate-first-run). **Description update only** (D-02/D-07 contract): the tool description (lines 801-803, 807-808) should explain that a sensor now emits a JSON payload `{ambient?, event?}`, that the event fires to the schedule's head, and that the ambient lands under that head. No logic change — `headId` is already threaded.

### `skills/sensors/SKILL.md` — full rewrite [VERIFIED: read]
Current SKILL.md (114 lines) teaches the OLD contract: "stdout is the output … written verbatim to `ambient/<slug>.md` … injected into **every** head." Rewrite scope:
- New contract: stdout = one JSON object `{ ambient?: string, event?: { text: string } }`; both optional; neither = quiet tick; malformed → failure marker.
- Two sinks: **ambient** (passive, head-scoped `ambient/<headId>/<slug>.md`, injected only into the owning head) and **event** (active, wakes the bound head via the activation loop).
- Mandatory target head = the schedule's `headId`.
- **Self-watermarking pattern (D-09)** with a worked example: a sensor that should fire an event only on a *transition* keeps its own `state.json`/timestamp in its sensor dir and compares before emitting `event`. Mirror the email-check pattern.
- Worked example: the **weather** sensor — `{ "ambient": "72°F, clear", "event": { "text": "Storm warning issued through 9pm." } }`; quiet tick `{ "ambient": "68°F, light rain" }`; self-watermark the last storm-alert id so the event doesn't re-fire every tick.
- Update the on-disk example (the `disk` sensor `console.log(...)`) to `console.log(JSON.stringify({ ambient: ... }))`.

### Dashboard — `src/dashboard/routes/sensors.ts` + `dashboard/src/pages/SensorsPage.tsx` (minimal)
- **DELETE route (`sensors.ts:80-94`)** currently `fs.rmSync(path.join(ambientDir, `${slug}.md`))` — a flat-layout assumption. With per-head ambient the file is at `ambient/<headId>/<slug>.md`, but the route has no headId in scope. **Planning decision (Pitfall 5):** either (a) glob-remove `ambient/*/<slug>.md` across all head dirs, or (b) look up the sensor's schedule(s) to find the head(s) and remove those. Recommend (a) — simplest, and a sensor slug is globally unique on disk (one `sensors/<slug>/` dir).
- **SensorsPage.tsx** — minimal reflection only: the page lists sensor slugs from `sensors/` (filesystem) and edits scripts. It does not currently show ambient output. Per-head ambient is mostly invisible to this CRUD page; the minimal change is ensuring nothing in the view assumes a flat `ambient/<slug>.md` (it doesn't — it reads `sensors/<slug>/sensor.mjs`). **Flag scope:** do NOT add run-now/last-status/per-head ambient browsing — that is SENSOR-F-02 (deferred).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| New queue persistence for `sensor_event` | A new table / column / serializer | Nothing — `QueueStore.enqueue/claimNext` are type-agnostic (JSON payload) | Adding a `QueueEvent` member is the entire persistence story |
| Framing the event into model context | A bespoke string template | `systemEvent(...)` + `systemTrigger('respond')` via a new `injectSensorEvent` mirroring `injectWebhookEvent` | Single source of truth for marker XML + escaping (`src/markers.ts`); the head already parses `<system-event>` |
| Atomic ambient write | tmp+rename | `write-file-atomic` sync (already imported in runner) | Project convention; prevents partial reads |
| Per-head ambient scan | New folder-walk | `scanAmbient(dir, headId)` — one function, four callers | Already the shared path; just add the dir segment |
| Dedup / cooldown / edge-detection | Runner-level dedupeKey/cooldown machinery | Nothing — scripts self-watermark (D-09) | Explicit non-goal; keeps the runner stateless about semantics |

**Key insight:** The push path is small *because* the queue is type-agnostic and the injector/marker layer is already factored. The work is registration + one injector method + threading `headId`, not new infrastructure.

---

## Runtime State Inventory

> This phase is a contract + layout rework with a real on-disk migration (D-10).

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **Live sensor `weather`** in `~/.shrok/workspace/sensors/weather/sensor.mjs` (emits plain body text via `console.log`); flat ambient file `~/.shrok/workspace/ambient/weather.md` (130 bytes, old body-text contract); its `kind:'script'` schedule `sched_1781788477329_vlr4cax.json` with `headId: "ashley"`, `taskName: "weather"`. | **One-time migration:** (1) move `ambient/weather.md` → `ambient/ashley/weather.md` (or just delete it — the next sensor run regenerates it under the new path); (2) rewrite `sensors/weather/sensor.mjs` to emit `console.log(JSON.stringify({ ambient: "<one-line snapshot>" }))` instead of plain text. Without (2), the first post-deploy run prints non-JSON → a failure marker at `ambient/ashley/weather.md` (loud, self-healing once the script is updated). Document this in the plan as an explicit migration task. |
| Live service config | None — no external service holds sensor state | — |
| OS-registered state | None | — |
| Secrets/env vars | None — sensors inherit `process.env`; no key names change | — |
| Build artifacts | `dashboard/dist/` is CI-owned; do NOT commit locally. No other artifacts. | — |

**Heads on this box:** `config.json` has a `heads` array; the live sensor binds to head `ashley`. Other heads have no sensors. After migration, `ambient/ashley/weather.md` is the only head-scoped ambient file; the flat `ambient/weather.md` must be removed (else stale + orphaned, never scanned under the new per-head layout but cluttering the dir).

---

## Common Pitfalls

### Pitfall 1: `injectEvent` silently no-ops unknown types → black-hole event
**What goes wrong:** If `sensor_event` is added to the `QueueEvent` union + enqueued but NOT added to the `injectEvent` switch (`activation.ts:1319`), the loop claims the row, acks it, and produces no message — the head never wakes, no error.
**How to avoid:** Add `case 'sensor_event': this.opts.injector.injectSensorEvent(event); break`. A test asserting an injected `<system-event type="sensor">` message appears after a `sensor_event` is claimed catches this.
**Warning sign:** Event acked (`status='done'`) but head history has no new message.

### Pitfall 2: Copying the reminder "wake via user_message" pattern instead of webhook
**What goes wrong:** Re-enqueuing a `user_message` with sensor text (the reminder pattern) gives the event `PRIORITY.USER_MESSAGE`(100) and frames it as a user turn — violating D-06/D-08 and the honest-observation framing.
**How to avoid:** Use a distinct `sensor_event` type + `PRIORITY.SENSOR_EVENT`(15) + `systemEvent('sensor', …)`. Mirror `injectWebhookEvent`, not `handleScheduleTrigger`'s reminder branch.

### Pitfall 3: Runner throws out of the scheduler tick
**What goes wrong:** A QueueStore enqueue error (or a synchronous slug guard) rejecting the runner promise would propagate to the `.catch` in `tick()` — logged, but the event is lost and the ambient file may be half-written.
**How to avoid:** Keep `runSensor`'s always-resolve contract. Wrap the enqueue in try/catch that writes a failure marker (or logs) instead of rejecting. The existing slug guard throwing synchronously is fine (it runs before any I/O), but the closure already validates the slug via `create_schedule`/dashboard.

### Pitfall 4: `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
**What goes wrong:** Constructing the `sensor_event` with an explicitly-`undefined` optional field is a type error; indexing `payload['event']` returns `unknown` and `(event as any).text` without a guard is unsafe under strict mode.
**How to avoid:** Build the event object with only present keys (omit, don't set `undefined`). Validate `payload` shape with explicit `typeof` checks before reading `.text`. Use `for...of` not index access in any scan loop (the existing `scan.ts` already does).

### Pitfall 5: Dashboard DELETE assumes flat `ambient/<slug>.md`
**What goes wrong:** `sensors.ts:91` removes `ambient/<slug>.md` (flat). Post-rework the file is `ambient/<headId>/<slug>.md`, so the DELETE leaves an orphaned per-head ambient file.
**How to avoid:** Glob-remove `ambient/*/<slug>.md` across head dirs in the DELETE route (recommended — slug is globally unique), or resolve the head from the sensor's schedule(s). Add a test.

### Pitfall 6: Ambient-only payload must NOT enqueue (SENSOR-06 still holds for the pull path)
**What goes wrong:** Enqueuing a `sensor_event` on every tick (even ambient-only) would wake the head constantly — defeating the passive-ambient design and burning model turns.
**How to avoid:** Enqueue **only** when `event` is present and well-formed. D-11 explicitly tests "ambient-only payload = no enqueue." A quiet tick (neither field) does nothing on either sink.

### Pitfall 7: `claimAllPendingBackground` coalesces sensor_events
**What goes wrong (actually a feature):** A burst of `sensor_event`s for one head coalesces into a single activation (`claimAllPendingBackground` claims all non-`user_message` rows). This is desirable — but the injector is called once per coalesced event, so N sensor observations produce N injected `<system-event>` messages before one head turn. Verify the framing reads cleanly with multiple stacked sensor events (it does — each is a self-contained system-event).
**How to avoid:** No action needed; just be aware in tests that multiple pending sensor_events for one head resolve in one turn.

---

## Code Examples

### The injector method to add (source: `src/head/injector.ts` injectWebhookEvent, lines 265-289)
```typescript
// [VERIFIED template] — add to InjectorImpl; declare in the Injector interface
injectSensorEvent(event: QueueEvent & { type: 'sensor_event' }): void {
  const eventMsg: TextMessage = {
    kind: 'text', id: generateId('msg'), createdAt: now(),
    role: 'assistant',
    content: systemEvent('sensor', { slug: event.slug }, event.text),
    injected: true,
  }
  const triggerMsg: TextMessage = {
    kind: 'text', id: generateId('msg'), createdAt: now(),
    role: 'user',
    content: systemTrigger('respond'),
    injected: true,
  }
  this.messages.append(eventMsg, this.headId)
  this.messages.append(triggerMsg, this.headId)
}
```

### The scheduler call-site change (source: `src/scheduler/index.ts:73-77`)
```typescript
// [VERIFIED] — current: this.sensorRunner.run(slug)
} else if (this.sensorRunner) {
  this.sensorRunner.run(slug, schedule.headId).catch(err =>   // ← + schedule.headId
    log.error(`[scheduler] sensor:${slug} runner error:`, (err as Error).message)
  )
}
```

### Per-head scan signature (source: `src/sensors/scan.ts:24`)
```typescript
// [VERIFIED] — current: scanAmbient(workspaceDir: string)
export function scanAmbient(workspaceDir: string, headId: string): string {
  const dir = path.join(workspaceDir, 'ambient', headId)   // ← + headId segment
  // ...rest unchanged
}
```

---

## State of the Art

| Old Approach (Phase 48/49) | New Approach (Phase 51) | Impact |
|--------------|------------------|--------|
| stdout = plain body text | stdout = one JSON object `{ambient?, event?}` | Runner parses; malformed → failure marker |
| Flat global `ambient/<slug>.md`, injected into every head | Per-head `ambient/<headId>/<slug>.md`, injected only into owning head | `scanAmbient` gains `headId`; 4 call sites |
| Single passive sink (ambient only); SENSOR-06 bypasses the loop | Dual sink: ambient (still bypasses) + `sensor_event` (enters the loop) | New queue type + injector method |
| No head targeting needed (global) | Mandatory head = schedule `headId` (already carried) | No schema change |

**Deprecated/removed:** the plain-text-stdout contract and the flat ambient layout (deleted, no shim — D-10).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `SENSOR_EVENT: 15` is the right priority | Push Path / D-08 | Low — it's a single constant; planner may pick 10. Justification documented. |
| A2 | Coalescing multiple `sensor_event`s into one head turn is desirable | Pitfall 7 | Low — it is the existing background-event behavior; matches "head decides" posture. |
| A3 | The minimal `event` sub-schema is `{ text: string }` | D-02 | Low — CONTEXT says keep minimal; planner may add optional fields, but `text` is the floor. |
| A4 | Dashboard DELETE should glob-remove `ambient/*/<slug>.md` | Pitfall 5 | Medium — alternative is resolving head from schedule; both correct, glob is simpler. Planner decides. |
| A5 | "Leave stale" on a quiet (no-`ambient`) tick is the right D-05 default | D-05 | Low — CONTEXT recommends it; a quiet tick means "nothing new," not "forget." Planner confirms. |
| A6 | The live `weather` sensor (head `ashley`) is the only on-disk migration | Runtime State Inventory | Low — verified by `ls ~/.shrok/workspace/sensors/` (only `weather`) + the one `kind:'script'` schedule. |

---

## Open Questions (RESOLVED)

All three are locked by the plans — none is left open for execution.

1. **D-05 — clear vs. leave stale on a no-`ambient` tick.** → **RESOLVED (Plan 02 Task 1).** Omitting `ambient` LEAVES the file stale (D-05); emitting `{ "ambient": "" }` (empty string) WRITES an empty file, which the scan skips → effectively retracts the block. The two behaviors are deterministic (empty-string clears, omitted leaves stale) and each has a discrete test. The empty-string-retraction sub-question is thereby pinned, not incidental.

2. **Dashboard per-head DELETE (Pitfall 5).** → **RESOLVED (Plan 04 Task 2).** The route glob-removes `ambient/*/<slug>.md` across all head dirs; the flat-path removal is dropped; per-head delete is tested.

3. **`event` sub-schema beyond `text` (D-02).** → **RESOLVED (Plans 01/02).** Ship `{ text: string }` only this phase; severity/title/etc. deferred per CONTEXT Deferred Ideas.

---

## Environment Availability

> SKIPPED — no external dependencies. All modules (`node:child_process`, `write-file-atomic`, `vitest`) are already installed and in use. The live `weather` sensor calls Open-Meteo (no API key) but that is sensor-script-internal, not a phase dependency.

---

## Validation Architecture

> `workflow.nyquist_validation` is absent in `.planning/config.json` → treated as ENABLED.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.x (`vitest.config.ts`, `pool: 'forks'`) |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts src/head/injector.test.ts src/head/assembler.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SENSOR-13 | JSON parse matrix: both-fields / ambient-only / event-only / empty no-op / malformed→failure-marker | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend `src/sensors/runner.test.ts` |
| SENSOR-13 | malformed/non-object stdout → `⚠ Sensor failed on last run:` at head-scoped path | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend |
| SENSOR-14 | runner writes `ambient/<headId>/<slug>.md` (not flat) | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend |
| SENSOR-14 | `scanAmbient(dir, headId)` reads only that head's dir; head A never sees head B | unit | `npx vitest run src/sensors/scan.test.ts` | ✅ extend `src/sensors/scan.test.ts` |
| SENSOR-14 | assembler / tool-surface inject only the assembling head's ambient | unit | `npx vitest run src/head/assembler.test.ts src/sub-agents/tool-surface.test.ts` | ✅ extend |
| SENSOR-15 | `event` payload enqueues a `sensor_event` with the schedule's headId | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend (spy on injected sink) |
| SENSOR-15 | ambient-only payload does NOT enqueue (SENSOR-06 holds for pull) | unit | `npx vitest run src/sensors/runner.test.ts` | ✅ extend |
| SENSOR-15 | a `sensor_event` flows through the activation loop → injected `<system-event type="sensor">` + respond trigger → head turn | unit | `npx vitest run src/head/injector.test.ts` (+ activation test) | ⚠️ Wave 0: add `injectSensorEvent` test in `src/head/injector.test.ts`; optional activation-loop integration test |
| SENSOR-16 | head targeting: scheduler passes `schedule.headId` to runner; event + ambient land under it | unit | `npx vitest run src/scheduler/scheduler.test.ts` | ✅ extend (assert runner spy called with `(slug, headId)`) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/sensors/ src/scheduler/scheduler.test.ts src/head/injector.test.ts`
- **Per wave merge:** `npx vitest run && npx tsc --noEmit`
- **Phase gate:** full suite green + `npx tsc --noEmit` clean before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] Extend `src/sensors/runner.test.ts` — JSON parse matrix, dual-sink (mock enqueue sink), head-scoped path, failure marker at head path.
- [ ] Extend `src/sensors/scan.test.ts` — per-head dir read + head A/B isolation.
- [ ] Add `injectSensorEvent` test to `src/head/injector.test.ts` (or create if asserting the new method).
- [ ] Extend `src/scheduler/scheduler.test.ts` — `run(slug, headId)` assertion for `kind:'script'`.
- [ ] Extend `src/head/assembler.test.ts` + `src/sub-agents/tool-surface.test.ts` — per-head ambient scoping (these already test ambient placement; add the headId dimension).
- *(No framework install needed — vitest is configured.)*

---

## Security Domain

> `security_enforcement` not set in config → treated as ENABLED.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | (a) Sensor **slug** already validated `^[a-z0-9][a-z0-9-]*$` before any `path.join` (runner + dashboard + create_schedule). (b) **headId** is now part of a filesystem path (`ambient/<headId>/`) — it comes from validated heads (dashboard checks head existence; tool closure uses a fixed per-head id), but the new path-join should validate headId shape too (no `/`, `..`, `.`) as defense-in-depth. (c) **stdout JSON** — parse defensively; never `eval`; type-guard `ambient`/`event.text` as strings before use. |
| V6 Cryptography | no | — |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via headId in `ambient/<headId>/` | Tampering | Validate headId against a safe charset before `path.join`; heads are operator-defined, but harden the new path segment (it was previously a fixed string). |
| Path traversal via slug | Tampering | Already mitigated — `^[a-z0-9][a-z0-9-]*$` guard runs before any path use (runner `runner.ts:52`, dashboard `SLUG_RE`). |
| Malicious/huge stdout (memory DoS) | DoS | Node `execFile` default `maxBuffer` (1 MB) caps stdout; `SENSOR_OUTPUT_CAP` (2000) truncates the ambient body; JSON.parse on >1 MB is bounded by maxBuffer. |
| Event-text injection into model context | Tampering/Info | `systemEvent` escapes the body via `escapeXmlBody`; the head treats `<system-event>` as a structural delimiter, not user instruction — same trust model as `webhook`. |
| Sensor self-watermark file tampering | — | Out of scope — the script owns its `state.json` (D-09); same trust as any task write-along script (sensors inherit server env, no sandbox by design). |

---

## Sources

### Primary (HIGH confidence — all direct codebase inspection, 2026-06-18)
- `src/types/core.ts` — `QueueEvent` union (83-157), `QueueEventType` (159), `PRIORITY` (162-174)
- `src/db/queue.ts` — type-agnostic `enqueue`/`claimNext`/`claimAllPendingBackground` (full read)
- `src/head/activation.ts` — `injectEvent` switch (1319-1336), `formatInjectedEvent` (1448-1467), `handleScheduleTrigger` reminder branch (1096-1186), coalescing (637-736), `schedule_trigger` early-return (521-524), `scanAmbient` proactive calls (1140, 1217)
- `src/head/injector.ts` — `Injector` interface (136-140), `injectWebhookEvent` (265-289), `injectHeadMessage` (294-315)
- `src/head/assembler.ts` — event-framing `deriveQueryText` switch (42-82), ambient scan call (144-148), `Current time:` marker (130), `headId` ctor arg (101)
- `src/markers.ts` — `systemEvent`/`systemTrigger`/`escapeXmlBody` (full read)
- `src/sensors/runner.ts` — `runSensor` current signature + flat write (full read)
- `src/sensors/scan.ts` — `scanAmbient` current flat read (full read)
- `src/scheduler/index.ts` — `kind:'script'` tick branch + `sensorRunner.run(slug)` (full read)
- `src/index.ts` — `sensorRunner` closure (514-521), `queue` in scope
- `src/db/schedules.ts` — `Schedule.headId`/`kind:'script'`/`CreateScheduleOptions` (full read)
- `src/sub-agents/registry.ts` — `create_schedule` `kind:'script'` branch (798-911), `headId` from closure (903)
- `src/sub-agents/tool-surface.ts` — `deps.headId` (33), `scanAmbient` call (82)
- `src/dashboard/routes/sensors.ts` — DELETE flat-ambient removal (91)
- `src/dashboard/routes/schedules.ts` — `kind:'script'` create + headId validation (82-207)
- `skills/sensors/SKILL.md` — current old-contract skill (full read)
- `~/.shrok/workspace/` — live state: `sensors/weather/`, `ambient/weather.md`, schedule `sched_1781788477329` (headId `ashley`)
- `.planning/config.json` — no `nyquist_validation`/`security_enforcement` keys (both default-enabled)
- `.planning/phases/48-sensor-backend/48-RESEARCH.md` — Phase 48 map (cross-referenced; paths re-verified against live tree)

### Tertiary (LOW confidence)
None — all claims verified from the codebase.

---

## Metadata

**Confidence breakdown:**
- Push path (queue type, priority, dispatch, framing): HIGH — every seam read directly; QueueStore confirmed type-agnostic.
- Head targeting: HIGH — `headId` confirmed set at create and available at the tick.
- Per-head ambient: HIGH — all four `scanAmbient` call sites located, each has a head in scope.
- Runner/scheduler wiring: HIGH — closure + signatures read; QueueStore injection path confirmed (`queue` in scope at `index.ts`).
- Migration: HIGH — live `weather` sensor + its `ashley` schedule inspected on disk.

**Research date:** 2026-06-18
**Valid until:** 30 days (stable TypeScript codebase; trunk moves fast — re-verify line numbers if planning is delayed).
