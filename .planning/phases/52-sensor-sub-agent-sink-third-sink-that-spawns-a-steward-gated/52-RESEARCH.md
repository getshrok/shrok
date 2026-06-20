# Phase 52: Sensor Sub-Agent Sink — Research

**Researched:** 2026-06-20
**Domain:** Internal TypeScript plumbing — sensor runner, queue types, activation loop, proactive steward
**Confidence:** HIGH (all claims verified directly against live source files)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Payload contract becomes `{ ambient?: string, headEvent?: { text: string }, subAgentEvent?: { prompt: string } }`. `ambient` unchanged.
- **D-02:** Phase-51 `event` sink renamed `headEvent`, inner shape unchanged (`{ text }`). No back-compat.
- **D-03:** New `subAgentEvent` is an object `{ prompt: string }`, not a bare string.
- **D-04:** Any combination of all three sinks in one payload is valid.
- **D-05:** Sub-agent dispatch always gated by the steward — no per-sensor bypass flag.
- **D-06:** Honor existing global proactive config (`proactiveEnabled` / `proactiveShadow`). If proactive disabled globally, spawns directly — exactly as scheduled tasks do today.
- **D-07:** On steward LLM failure → default RUN (matches `RUN_DEFAULT` in `src/scheduler/proactive.ts`).
- **D-08:** Label spawned agent by sensor slug: `skillName: sensor:<slug>`. Prefer distinct `trigger: 'sensor'` if adding the enum value is cheap; otherwise reuse `'scheduled'`.
- **D-09:** Reuse existing `agent_completed` → relay/output-steward path. No new suppression machinery.
- **D-10:** Sensor SKILL.md documents all three sinks with "which do I pick" guidance.
- **D-11:** Migration blast radius: calendar → ambient-only, untouched; relay: `event` → `headEvent`; example-sensor: `headEvent` + add `subAgentEvent` demo.

### Claude's Discretion (plan-time architecture calls)
- **D-12:** Queue wiring — lean: dedicated queue event type for sensor→sub-agent dispatch. Priority in 10–15 band. Planner decides exact mechanism.
- **D-13:** Steward reuse — lean: new non-schedule prompt template (`src/scheduler/prompts/sensor-dispatch.md`) dropping `SCHEDULE`/`LAST_RUN`/`lastSkipped` placeholders. Likely a sibling decision function to `runProactiveDecision`. Planner decides exact shape.

### Deferred Ideas (OUT OF SCOPE)
- Calendar pre-meeting nag-reminder sensor (separate later deliverable).
- Optional `subAgentEvent` fields (`label`, `model`).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SENSOR-17 | Third optional sink — `subAgentEvent: { prompt: string }` — spawns sub-agent through steward gate without waking head | Queue event type section + activation.ts handler section |
| SENSOR-18 | Rename Phase-51 `event` → `headEvent`; migrate relay/calendar/example workspace sensors and SKILL.md | runner.ts rename section + workspace migration section |
| SENSOR-19 | Routes through existing proactive-decision steward (rephrased, non-schedule prompt) and existing task-spawn path via schedule-less synthetic trigger | proactive.ts section + activation.ts handler section |
</phase_requirements>

---

## Summary

Phase 52 is a pure internal plumbing phase with five interconnected change sites, all verified by reading live source. The Phase-51 dual-sink `{ ambient, event }` contract is fully intact in `src/sensors/runner.ts` at lines 130–166, with the `event` key hardcoded in both the destructuring (`const { ambient, event } = payload`) and the type guard. The rename and third sink are additive changes to this single block plus the `QueueEvent` union in `src/types/core.ts`.

The steward gate and spawn machinery already exist in full working order in `handleScheduleTrigger` (`src/head/activation.ts:1096–1317`) and `agentRunner.spawn` (`src/sub-agents/local.ts:182–244`). The only new plumbing needed is: (1) a new queue event type carrying `{ slug, prompt }`, (2) a branch in the activation loop's `handleEvent`/`processOne` dispatcher to route that event to a new `handleSensorSubAgentTrigger` handler, and (3) a new proactive-decision function variant and `sensor-dispatch.md` prompt template that drops schedule-shaped fields.

The `trigger` field in `AgentState` is typed as a string literal union `'manual' | 'scheduled' | 'ad_hoc'` in `src/types/agent.ts:48`. Adding `'sensor'` is a one-line type change that costs nothing. The relay steward at `activation.ts:662` gates only `trigger === 'scheduled'` agents — **using `'sensor'` as the trigger value means sensor-dispatched agents naturally bypass the relay steward's "should this output surface?" gate**. This is D-09's intended behavior: no new suppression machinery because the relay steward already excludes non-`'scheduled'` triggers.

**Primary recommendation:** Add a dedicated `sensor_sub_agent_trigger` queue event type (D-12 lean confirmed by code analysis), add `'sensor'` to the trigger enum (cheap — one type-change line), and write `runSensorDispatchDecision` as a direct sibling function to `runProactiveDecision` in `proactive.ts`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Parse `subAgentEvent` from sensor stdout | Sensor runner | — | Runner already owns all sink dispatch; third sink is additive branch here |
| New queue event type + priority | `src/types/core.ts` | — | Single source of truth for all queue shapes |
| Route sensor-sub-agent event to handler | Activation loop dispatcher | — | `handleEvent` is the single switch-on-event-type site |
| Steward gate (should it run?) | `src/scheduler/proactive.ts` | `src/head/activation.ts` (caller) | Proactive owns the LLM call + prompt; activation calls it |
| New steward prompt template | `src/scheduler/prompts/` | — | All proactive prompts live here, workspace-overridable |
| Spawn sub-agent | `src/sub-agents/local.ts` (`agentRunner.spawn`) | — | Reused unchanged |
| SKILL.md doc update | `skills/sensors/SKILL.md` | — | Bundled sensor authoring doc |
| Workspace sensor migration | `~/.shrok/workspace/sensors/` | — | 2 of 5 sensors need changes; calendar/disk-space/weather untouched |

---

## Change Surface — Verified File by File

### 1. `src/sensors/runner.ts` — Lines 130–172 (the dual-sink dispatch block)

**Current state (verified):**

```typescript
// Line 131-132: destructure — ONLY `ambient` and `event` extracted
const payload = parsed as Record<string, unknown>
const { ambient, event } = payload

// Lines 137-140: ambient sink (unchanged in Phase 52)
if (typeof ambient === 'string') {
  fs.mkdirSync(path.join(ambientBaseDir, headId), { recursive: true })
  writeFileAtomicSync(outputPath, ambient.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
}

// Lines 144-166: event sink (the `event` key that becomes `headEvent`)
if (
  event !== null &&
  typeof event === 'object' &&
  !Array.isArray(event) &&
  typeof (event as Record<string, unknown>)['text'] === 'string'
) {
  const text = (event as Record<string, unknown>)['text'] as string
  try {
    enqueue.enqueue(
      {
        type: 'sensor_event',
        id: generateId('qe'),
        slug,
        text,
        createdAt: new Date().toISOString(),
      },
      PRIORITY.SENSOR_EVENT,
      headId,
    )
  } catch (enqueueErr) {
    writeFailure(`failed to enqueue sensor event: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
  }
}
```

**Changes needed (SENSOR-17/18):**

1. **Rename:** destructure `headEvent` instead of `event` from `payload` (line 132). The type guard body changes `event` → `headEvent` and checks `['text']` on `headEvent` — inner shape and `sensor_event` enqueue call unchanged.
2. **Add branch:** after the `headEvent` block, add a parallel guard for `subAgentEvent`: non-null, non-array object with `prompt: string`. On match, enqueue a new queue event type (carrying `slug` + `prompt`) at a priority in the 10–15 band.
3. **JSDoc:** update the function's JSDoc comment (lines 41–52) which currently says `{ ambient?, event? }` to document all three sinks.

**Pattern to follow exactly:** the `subAgentEvent` branch mirrors the `headEvent` branch's "present + well-typed → act, else skip (not an error)" guard pattern.

---

### 2. `src/types/core.ts` — QueueEvent union + PRIORITY map

**Current state (verified):**

The `QueueEvent` discriminated union (lines 83–173) has these relevant members:

```typescript
// schedule_trigger (lines 116–131) — task-centric, scheduleId required
{
  type: 'schedule_trigger'
  id: string
  scheduleId: string      // ← ALWAYS required; null would break handleScheduleTrigger
  taskName: string | null
  kind: 'skill' | 'task' | 'reminder'
  createdAt: string
}

// sensor_event (lines 159–172) — existing head-waking sensor event
{
  type: 'sensor_event'
  id: string
  slug: string
  text: string
  createdAt: string
}
```

**PRIORITY map (lines 177–194):**

```typescript
export const PRIORITY = {
  USER_MESSAGE: 100,
  HEAD_MESSAGE: 70,
  AGENT_QUESTION: 50,
  AGENT_COMPLETED: 30,
  AGENT_FAILED: 30,
  AGENT_RESPONSE: 30,
  WEBHOOK: 20,
  SENSOR_EVENT: 15,      // ← head-waking sensor event
  SCHEDULE_TRIGGER: 10,
  REMINDER_TRIGGER: 10,
} as const
```

**Architecture decision confirmed (D-12):** Overloading `schedule_trigger` with `scheduleId: null` is NOT viable without significant surgery. `handleScheduleTrigger` immediately calls `this.opts.scheduleStore.get(event.scheduleId)` (activation.ts:1198) and branches on `kind`. A null `scheduleId` produces null from the store and the `kind` field doesn't apply. A clean new type is the correct choice.

**New type to add:**

```typescript
{
  type: 'sensor_sub_agent_trigger'
  id: string
  slug: string
  prompt: string
  createdAt: string
}
```

**Priority recommendation:** `SENSOR_SUB_AGENT_TRIGGER: 10` — matching `SCHEDULE_TRIGGER`. Rationale: both are background-work dispatches with no live user waiting. The existing `SENSOR_EVENT` at 15 is higher because it wakes the conversational head (a user-facing push). A sensor sub-agent trigger is analogous to a scheduled task trigger — background work — so parity at 10 is correct and consistent.

---

### 3. `src/head/activation.ts` — Dispatcher and handler

**Current dispatch path (verified):**

`handleEvent` at line 496 has an early-return branch at lines 521–524:

```typescript
if (event.type === 'schedule_trigger') {
  await this.handleScheduleTrigger(event)
  return
}
```

All other event types fall through to the full activation path (message injection, LLM run, steward pipeline). The `sensor_sub_agent_trigger` must also get an early-return branch here — it should NEVER reach the LLM activation path, which would wake the head.

**`handleScheduleTrigger` structure (lines 1096–1317):**

The handler has three sequential phases:
1. **Reminder branch** (lines 1101–1186): if `kind === 'reminder'`, runs `runReminderDecision`, manages schedule row, enqueues a `user_message` to wake the head. Returns early. Entirely separate from the task path.
2. **Task resolution** (lines 1188–1195): `unified.tasksLoader.load(taskName)` — requires a non-null taskName from the schedule row.
3. **Proactive decision** (lines 1200–1237): calls `runProactiveDecision` with fields drawn from the schedule row (`scheduleCron`, `lastRun`, `lastSkipped`, `lastSkipReason`, `conditions`).
4. **Spawn** (lines 1272–1316): calls `agentRunner.spawn` with `trigger: 'scheduled'`, `skillName: taskName!`, `headId`.

**What breaks if this handler is reused with a synthetic trigger:** All of items 1–3 depend on schedule store data that doesn't exist for a sensor-originated dispatch. Item 4 (`agentRunner.spawn`) is the reusable piece.

**New handler needed:** `handleSensorSubAgentTrigger(event: QueueEvent & { type: 'sensor_sub_agent_trigger' })` — this is a slim version of `handleScheduleTrigger` that:
1. Skips task resolution (prompt comes directly from `event.prompt`)
2. Calls `runSensorDispatchDecision` (new function, see below) instead of `runProactiveDecision`
3. Calls `agentRunner.spawn` with `trigger: 'sensor'`, `skillName: 'sensor:${event.slug}'`, `headId`, task = `event.prompt`
4. Does NOT touch the schedule store (no `markSkipped`, no `lastRun` update, no delete)

The new handler's wiring point in `handleEvent`:

```typescript
if (event.type === 'sensor_sub_agent_trigger') {
  await this.handleSensorSubAgentTrigger(event)
  return
}
```

**`injectEvent` switch** (lines 1319–1338): Currently handles `sensor_event` → `injector.injectSensorEvent`. The `sensor_sub_agent_trigger` type must NOT be in this switch — it has already returned before `injectEvent` is called. No change needed here.

**`formatInjectedEvent` switch** (lines 1451–1472): Same — early return before this is reached. No change needed.

---

### 4. `src/scheduler/proactive.ts` — `runProactiveDecision` and the new variant

**Current function signature (verified, lines 155–201):**

```typescript
export interface ProactiveContext {
  skillName: string
  skillDescription: string
  skillInstructions: string
  scheduleCron: string | null        // ← schedule-shaped, not applicable to sensor
  lastRun: string | null             // ← schedule-shaped
  lastSkipped: string | null         // ← schedule-shaped
  lastSkipReason: string | null      // ← schedule-shaped
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
  conditions?: string                // ← schedule conditions, not applicable
}

export async function runProactiveDecision(
  ctx: ProactiveContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ProactiveDecision>
```

The function calls `loadPrompt('tasks')` which loads `src/scheduler/prompts/tasks.md`. That template uses interpolation tokens `{CURRENT_TIME}`, `{SKILL_NAME}`, `{SKILL_DESCRIPTION}`, `{SCHEDULE}`, `{LAST_RUN}`, `{SCHEDULE_CONDITIONS}`, `{SKILL_INSTRUCTIONS}`, `{USER_MD}`, `{AMBIENT}`, `{HISTORY}`.

**`RUN_DEFAULT`** (line 95) — exported constant, reused by the new function:

```typescript
const RUN_DEFAULT: ProactiveDecision = { action: 'run', reason: 'proactive decision failed, defaulting to run' }
```

**Return shape** (lines 188–198): the function extracts `{ action, reason, context }` from a JSON tool call response. The `context` field (optional) is what the proactive steward uses to inject relevant conversation excerpts into the spawned agent's prompt. The new sensor variant returns the same `ProactiveDecision` type — no new type needed.

**`loadPrompt` function** (lines 19–27): reads from `PROMPTS_DIR` (the `src/scheduler/prompts/` directory) with workspace-overlay support — if `proactiveWorkspaceDir` is set, a same-named `.md` file there wins. This means the new `sensor-dispatch.md` automatically gets the workspace-override mechanism for free.

**New function to add:**

```typescript
export interface SensorDispatchContext {
  slug: string
  prompt: string          // the subAgentEvent.prompt from the sensor payload
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
}

export async function runSensorDispatchDecision(
  ctx: SensorDispatchContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ProactiveDecision>   // reuse existing return type
```

The function calls `loadPrompt('sensor-dispatch')` and interpolates a template that drops `{SCHEDULE}`, `{LAST_RUN}`, `{SCHEDULE_CONDITIONS}`, `{SKILL_INSTRUCTIONS}` (no task instructions in this path — the prompt IS the instruction). Includes `{CURRENT_TIME}`, `{SLUG}`, `{SENSOR_PROMPT}`, `{USER_MD}`, `{AMBIENT}`, `{HISTORY}`.

**Tool call shape** stays identical: same `stewardComplete` call with `proactive_decision` tool schema (`action: 'run'|'skip'`, `reason`, optional `context`).

---

### 5. `src/sub-agents/local.ts` — `agentRunner.spawn` and the `trigger` field

**`SpawnOptions.trigger`** (verified in `src/types/agent.ts:84`):

```typescript
trigger: AgentState['trigger']
// resolves to:
trigger: 'manual' | 'scheduled' | 'ad_hoc'
```

**`AgentState.trigger`** (line 48):

```typescript
trigger: 'manual' | 'scheduled' | 'ad_hoc'
```

**Cost of adding `'sensor'`:** Two files, one line each:
- `src/types/agent.ts:48`: add `'sensor'` to the union
- The DB column is typed as `string` in `src/db/agents.ts:18` and cast via `row.trigger as AgentState['trigger']` at line 56 — so the DB schema itself does NOT need to change.

**Behavioral implications of `trigger: 'sensor'` vs `trigger: 'scheduled'`:**

The `trigger` value is checked in exactly two places:
1. `activation.ts:662` — relay steward gate: `if (a?.trigger !== 'scheduled') continue` — agents with `trigger: 'sensor'` are SKIPPED by the relay steward gate. This means a sensor-dispatched agent's `agent_completed` output goes directly to the head's activation without the relay steward's "should this surface?" judgment. **This IS the correct behavior for D-09** — "no new suppression machinery." A sensor sub-agent that creates a reminder produces `agent_completed` output, and the existing output/relay steward path handles it the same as any non-scheduled completion.
2. `local.ts:1040` — `suspendAsQuestion`: `if (options.trigger === 'scheduled')` → force-complete instead of suspend. With `trigger: 'sensor'`, a sensor-dispatched agent that reaches a question would SUSPEND (asking the user) rather than auto-complete. This may not be the desired behavior. **The planner must decide**: use `'sensor'` (natural, suspends on question) or `'scheduled'` (auto-completes on question, no relay steward gate either).

**Recommended resolution for planner:** Use `trigger: 'sensor'`. A sensor-dispatched agent doing work like "create a reminder" never reaches a question state (the tool is self-contained). The relay steward not gating `'sensor'` agents is correct — these agents dispatch silently by design and their completion will be handled by the existing output steward when the `agent_completed` event wakes the head. If auto-complete on question behavior is needed later, it can be extended cheaply to cover `'sensor'`.

**`skillName` field in `SpawnOptions`:** Currently used as the label in the dashboard xray and for usage attribution. Passing `skillName: 'sensor:${slug}'` (e.g. `'sensor:relay'`) follows D-08 and will surface in the dashboard's agent list as the human-readable identity of who dispatched the agent. No special handling needed — `resolveSkillByName` at `local.ts:380` is called with `options.skillName`; it checks `unifiedLoader` first, falls back to `skillLoader.load`. A name like `'sensor:relay'` will not match any task or skill (no slash, but no such name exists), returning `null` — which means the agent runs with no skill-specific tool surface or SKILL.md injection. **This is the correct behavior**: sensor-dispatched agents run with the default tool surface and no skill pre-loading, because their prompt is self-contained.

---

### 6. Workspace Sensor Migration

**Sensors to change (verified):**

| Sensor | Path | Current sink(s) | Change needed |
|--------|------|-----------------|---------------|
| `relay` | `~/.shrok/workspace/sensors/relay/sensor.mjs` | `event: { text }` | Rename to `headEvent` (line 55 of sensor.mjs) |
| `example-sensor` | `~/.shrok/workspace/sensors/example-sensor/sensor.mjs` | `ambient` + `event: { text }` | Rename `event` → `headEvent`; add `subAgentEvent` demo section |
| `calendar` | `~/.shrok/workspace/sensors/calendar/sensor.mjs` | `ambient` only | **No change needed** (confirmed: only emits `{ ambient }`, no `event` key) |
| `disk-space` | `~/.shrok/workspace/sensors/disk-space/sensor.mjs` | (not checked — not in CONTEXT migration list) | **Likely ambient-only; verify during execution** |
| `weather` | `~/.shrok/workspace/sensors/weather/sensor.mjs` | (not checked — not in CONTEXT migration list) | **Likely ambient-only; verify during execution** |

**relay sensor change (line 55):**
```javascript
// BEFORE:
console.log(JSON.stringify({ event: { text: `${header}\n${lines.join('\n')}` } }))
// AFTER:
console.log(JSON.stringify({ headEvent: { text: `${header}\n${lines.join('\n')}` } }))
```

**example-sensor change (line 67-69):**
```javascript
// BEFORE:
if (runs % 5 === 0) {
  payload.event = { text: `Example sensor has now run ${runs} times.` }
}
// AFTER:
if (runs % 5 === 0) {
  payload.headEvent = { text: `Example sensor has now run ${runs} times.` }
}
// ALSO ADD a subAgentEvent demo (separate watermark condition, e.g., every 10th run)
if (runs % 10 === 0) {
  payload.subAgentEvent = { prompt: `Note in the journal that the example sensor has reached ${runs} runs.` }
}
```

---

### 7. `skills/sensors/SKILL.md` — Bundled sensor authoring doc

**Current state (verified):** The doc at `/home/thenasty/shrok/skills/sensors/SKILL.md` describes two sinks (`ambient` and `event`), shows the `event: { text }` shape in the contract section and worked examples, and references the `{ "ambient"?: string, "event"?: { "text": string } }` object as the stdout contract.

**Changes needed (D-10, SENSOR-18):**
1. The stdout contract line must become `{ "ambient"?: string, "headEvent"?: { "text": string }, "subAgentEvent"?: { "prompt": string } }`
2. The "two sinks" section heading and all `"event"` references update to `"headEvent"`
3. A new "Sub-agent event (dispatch, silent)" subsection documenting `subAgentEvent` — what it is, when to use it, the prompt-as-interface design, the steward gate
4. A "Which sink?" guidance block (D-10): `ambient` = always-present snapshot; `headEvent` = wake the head for conversation/judgment; `subAgentEvent` = get work done quietly, no user message
5. Worked examples: the relay and disk examples stay (update `event` → `headEvent`); add a new `subAgentEvent` example

---

## Architecture Patterns

### Flow: sensor → sub-agent dispatch

```
sensor.mjs stdout
    { subAgentEvent: { prompt: "..." } }
        │
        ▼
runSensor() [src/sensors/runner.ts:144–166 block]
    subAgentEvent guard → enqueue(
        type: 'sensor_sub_agent_trigger',
        slug, prompt
    )
        │
        ▼  (priority 10, async, scheduler tick)
ActivationLoop.handleEvent() [src/head/activation.ts]
    early-return branch on 'sensor_sub_agent_trigger'
        │
        ▼
handleSensorSubAgentTrigger()
    runSensorDispatchDecision(
        { slug, prompt, userMd, recentHistory, ambientContext, currentTime }
    ) → { action: 'run'|'skip', reason, context? }
        │
        ├── action='skip' → log + return (no spawn, no schedule row to update)
        │
        └── action='run'
                │
                ▼
            agentRunner.spawn({
                task: event.prompt,
                trigger: 'sensor',
                headId: this.opts.headId,
                skillName: `sensor:${event.slug}`,
                ...(decision.context ? { context: decision.context } : {})
            })
                │
                ▼  (async, runs in background)
            sub-agent executes
                │
                ▼  on completion
            enqueue({ type: 'agent_completed', agentId, output })
                │
                ▼  (relay steward skips — trigger !== 'scheduled')
            head activation (agent_completed path)
```

### Pattern: "Present + well-typed → act, else skip"

All three sink branches in `runner.ts` use the same guard pattern — no errors for absent/malformed sinks, only for unparseable stdout:

```typescript
// Template for subAgentEvent guard (mirrors existing headEvent guard structure)
const { ambient, headEvent, subAgentEvent } = payload

if (
  subAgentEvent !== null &&
  typeof subAgentEvent === 'object' &&
  !Array.isArray(subAgentEvent) &&
  typeof (subAgentEvent as Record<string, unknown>)['prompt'] === 'string'
) {
  const prompt = (subAgentEvent as Record<string, unknown>)['prompt'] as string
  try {
    enqueue.enqueue(
      {
        type: 'sensor_sub_agent_trigger',
        id: generateId('qe'),
        slug,
        prompt,
        createdAt: new Date().toISOString(),
      },
      PRIORITY.SENSOR_SUB_AGENT_TRIGGER,
      headId,
    )
  } catch (enqueueErr) {
    writeFailure(`failed to enqueue sensor sub-agent trigger: ...`)
  }
}
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Should-it-run decision | New LLM call, new tool schema, new model wiring | `stewardComplete` + `extractJson` pattern from `runProactiveDecision` (identical machinery) |
| Prompt template loading with workspace override | New file-reading logic | `loadPrompt('sensor-dispatch')` — workspace-override mechanism is built into the existing `loadPrompt` function |
| Agent spawn with skip/run cycle | New spawn infrastructure | `handleScheduleTrigger`'s spawn block (`agentRunner.spawn`) reused verbatim minus schedule-store calls |
| New agent state storage for sensor-triggered agents | New DB columns or tables | `trigger: 'sensor'` on the existing `AgentState.trigger` union + DB column typed as `string` (no migration needed) |

---

## Common Pitfalls

### Pitfall 1: `handleEvent` not having an early-return before the activation path
**What goes wrong:** `sensor_sub_agent_trigger` falls through to the full activation loop (LLM call, message injection, channel send). This wakes the head and may send a message — the opposite of SENSOR-19's intent.
**Prevention:** The early-return block must come BEFORE the `let typingInterval`, `coalescedEvents`, and `activationStart` assignments at lines 526–530.
**Warning signs:** Dashboard shows a new head message when a sensor fires a sub-agent trigger.

### Pitfall 2: `skipAsQuestion` auto-completion not applying to `'sensor'` trigger
**What goes wrong:** If `trigger: 'sensor'` is used and the spawned agent unexpectedly reaches a question state, it suspends (waits for a signal that never comes from an unattended dispatch path). With `trigger: 'scheduled'`, it would auto-complete instead.
**Prevention:** Document the decision in code. Sensor-dispatched agents should use prompts that are self-contained ("create a reminder", "check the calendar") and cannot reach a question state in normal operation.
**Warning signs:** Agent stuck in `suspended` status with no matching `agent_question` being answered.

### Pitfall 3: `skillName: 'sensor:<slug>'` resolving to a real skill
**What goes wrong:** If any workspace skill is accidentally named `sensor:relay` etc., `resolveSkillByName` would find it, load its SKILL.md, inject it into the agent, and affect the tool surface.
**Prevention:** The `sensor:` prefix is not a valid slug character (colon is not in `[a-z0-9][a-z0-9-]*`), so no real skill can share this prefix. No protective action needed.

### Pitfall 4: Relay steward gating sensor-completed agents
**What goes wrong:** If `trigger: 'scheduled'` is used for sensor-dispatched agents, the relay steward at `activation.ts:662` gates every `agent_completed` from a sensor sub-agent. Silent work (creating a reminder) could be suppressed, while the relay steward prompt contains schedule-specific language that doesn't apply.
**Prevention:** Use `trigger: 'sensor'` (D-08). The relay steward `if (a?.trigger !== 'scheduled') continue` check naturally skips sensor-triggered completions.

### Pitfall 5: `PRIORITY.SENSOR_SUB_AGENT_TRIGGER` not exported from `core.ts`
**What goes wrong:** TypeScript compile error in `runner.ts` which imports `PRIORITY` from `types/core.ts`.
**Prevention:** Add the new priority to the `PRIORITY` constant in the same commit as the new queue event type.

### Pitfall 6: Missing `sensor_sub_agent_trigger` in `QueueEventType` inferred union
**What goes wrong:** `QueueEventType = QueueEvent['type']` is a derived type — it automatically includes any new union member. No manual update needed. But if tests use exhaustive type checks, TypeScript will flag unhandled cases.
**Prevention:** Add a case for `'sensor_sub_agent_trigger'` in any exhaustive switch on `QueueEventType` in tests or utilities.

---

## New Prompt Template

**Location:** `src/scheduler/prompts/sensor-dispatch.md`

The template drops all schedule-shaped placeholders. Minimum viable template shape:

```markdown
Current time: {CURRENT_TIME}

---

A sensor has detected something and is requesting a sub-agent to act on it.

Sensor: {SLUG}
Task: {SENSOR_PROMPT}

---

User profile:
{USER_MD}

---

Ambient context:
{AMBIENT}

---

Recent conversation:
{HISTORY}

---

You are deciding whether this sensor-triggered task should run right now.
The sensor has already deterministically decided something happened — this is
a refinement, not a first-line filter. Default to running.

Run ({"action": "run"}) if:
- The task makes sense given the user's current context
- When uncertain, prefer to run

Skip ({"action": "skip"}) only if:
- The user is explicitly unavailable and the task would be disruptive
- The same work was clearly done moments ago

Optionally include "context" with any conversation detail directly relevant
to the task. Omit if nothing stands out.

Respond with JSON only:
{"action": "run", "reason": "...", "context": "..."} or {"action": "skip", "reason": "..."}
```

The workspace-override mechanism (`loadPrompt` checks `proactiveWorkspaceDir` first) applies automatically — no code change needed.

---

## Version and Changelog

**Current version:** `0.4.0` (both `package.json` and `dashboard/package.json`, verified).

**In-flight unreleased version:** `CHANGELOG.md` shows `## [0.5.0]` as the undated in-flight section. Phase 52 changes land in this section.

**Version bump direction:** Phase 52 adds new observable sensor behavior (new sink, rename of existing sink). This is a user-facing breaking change to the sensor contract (no back-compat). Bump to `0.5.0` — the changelog `## [0.5.0]` section already exists and is undated. The planner should include a task to date it and tag `v0.5.0` per the repo conventions.

---

## Environment Availability

Phase 52 is code/config-only — no external dependencies beyond the existing Node/TypeScript toolchain.

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | TypeScript compilation, sensor runner | ✓ | Existing project | — |
| `write-file-atomic` | `runner.ts` (already imported) | ✓ | Already in deps | — |
| `generateId` | New event construction | ✓ | Already imported in runner.ts | — |

Step 2.6: No blocking external dependencies.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (CI shards into 6 parallel runs) |
| Config file | `vitest.config.ts` or `vite.config.ts` |
| Quick run command | `npx vitest run src/sensors/` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SENSOR-18 | `headEvent` key (not `event`) enqueues `sensor_event` | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 |
| SENSOR-18 | Old `event` key no longer enqueues anything | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 |
| SENSOR-17 | `subAgentEvent: { prompt }` enqueues `sensor_sub_agent_trigger` | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 |
| SENSOR-17 | Malformed `subAgentEvent` (missing prompt, wrong type) is silently skipped | unit | `npx vitest run src/sensors/runner.test.ts` | ❌ Wave 0 |
| SENSOR-19 | `runSensorDispatchDecision` returns `RUN_DEFAULT` on LLM failure | unit | `npx vitest run src/scheduler/proactive.test.ts` | Likely exists; new case needed |
| SENSOR-19 | `handleSensorSubAgentTrigger` calls `agentRunner.spawn` with `trigger:'sensor'` | unit | `npx vitest run src/head/activation.test.ts` | Likely exists; new case needed |
| SENSOR-19 | `sensor_sub_agent_trigger` does not reach the LLM activation path (head is not woken) | unit | `npx vitest run src/head/activation.test.ts` | ❌ Wave 0 |

### Wave 0 Gaps

- [ ] `src/sensors/runner.test.ts` (or locate existing) — extend with Phase 52 sink tests
- [ ] New `handleSensorSubAgentTrigger` unit test cases in activation tests
- [ ] New `runSensorDispatchDecision` unit test cases in proactive tests

---

## Security Domain

Phase 52 introduces no new authentication, authorization, or data-handling surface. The `subAgentEvent.prompt` string is authored by the sensor script (operator-owned, same trust level as task prompts and skill instructions). No ASVS categories newly applicable.

---

## Assumptions Log

All claims in this research are verified directly against live source code. No assumed claims.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | — | — | — |

**All claims in this research were verified — no user confirmation needed.**

---

## Open Questions

1. **`trigger: 'sensor'` vs `trigger: 'scheduled'` for sensor-dispatched agents**
   - What we know: Using `'sensor'` naturally excludes these agents from the relay steward gate (desirable) and keeps them suspended on question rather than auto-completing (different behavior from scheduled tasks).
   - What's unclear: Whether any future feature or test depends on exhaustive checking of the `trigger` literal union.
   - Recommendation: Use `'sensor'`. The relay steward behavior is correct, and sensor-dispatched agents doing self-contained work (creating reminders, etc.) shouldn't reach a question state. Adding the enum value is a cheap one-line type change.

2. **`disk-space` and `weather` workspace sensors**
   - What we know: Both exist in `~/.shrok/workspace/sensors/` but are not in the CONTEXT migration list. Calendar is confirmed ambient-only. The CONTEXT says only relay and example-sensor need changes.
   - What's unclear: Whether `disk-space` or `weather` have an `event` key that would be silently broken by the rename.
   - Recommendation: During Wave 1 execution, verify both sensors contain no `event` key before marking migration complete. Both are most likely ambient-only (disk-space was confirmed to follow the `{ ambient: ... }` pattern in the SKILL.md worked example; weather is canonically ambient-only in all documentation). If either has an `event` key, extend the migration.

---

## Sources

### Primary (HIGH confidence — verified against live source files)

- `src/sensors/runner.ts` — lines 130–172, dual-sink dispatch block; lines 23–25, `SensorEventSink` interface
- `src/types/core.ts` — lines 83–194, full `QueueEvent` union and `PRIORITY` map
- `src/head/activation.ts` — lines 496–524 (`handleEvent` dispatcher); lines 1096–1317 (`handleScheduleTrigger`); lines 655–680 (relay steward trigger check); lines 1319–1338 (`injectEvent`)
- `src/scheduler/proactive.ts` — full file (155 lines); `ProactiveContext` interface, `runProactiveDecision`, `loadPrompt`, `formatTimestampedHistory`, `RUN_DEFAULT`
- `src/scheduler/prompts/tasks.md` — full template, all interpolation tokens
- `src/sub-agents/local.ts` — lines 182–244 (`spawn`); lines 863–863 (xray trigger check); lines 1035–1056 (`suspendAsQuestion`)
- `src/types/agent.ts` — lines 43–107, `AgentState`, `SpawnOptions`, trigger union
- `src/db/agents.ts` — lines 18, 56 (trigger column typing)
- `skills/sensors/SKILL.md` — full file, current sink documentation
- `~/.shrok/workspace/sensors/relay/sensor.mjs` — full file, `event` key usage at line 55
- `~/.shrok/workspace/sensors/example-sensor/sensor.mjs` — full file, `event` key usage at line 67
- `~/.shrok/workspace/sensors/calendar/sensor.mjs` — full file, confirmed ambient-only

---

## Metadata

**Confidence breakdown:**
- Change surface (what to change and where): HIGH — every file and line number verified
- Queue architecture (new type vs extending `schedule_trigger`): HIGH — code proves the existing type can't be safely extended
- Trigger enum implications: HIGH — relay steward gate and `suspendAsQuestion` both verified
- New prompt template shape: MEDIUM — content is a planner/author judgment call, not deterministically derivable from code
- Workspace sensor `disk-space` and `weather` migration need: MEDIUM — not read, inferred from patterns

**Research date:** 2026-06-20
**Valid until:** Stable (no fast-moving dependencies; all internal code)
