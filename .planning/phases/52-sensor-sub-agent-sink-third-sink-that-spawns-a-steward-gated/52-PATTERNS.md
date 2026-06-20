# Phase 52: Sensor Sub-Agent Sink — Pattern Map

**Mapped:** 2026-06-20
**Files analyzed:** 9 new/modified files + 2 new test case groups + 1 new prompt template
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/types/core.ts` | model/type | event-driven | `sensor_event` + `schedule_trigger` union members + `PRIORITY` map | exact |
| `src/sensors/runner.ts` | utility | event-driven | existing `headEvent` guard block (lines 144–166, currently named `event`) | exact |
| `src/head/activation.ts` (dispatcher) | controller | request-response | `if (event.type === 'schedule_trigger')` early-return (lines 521–524) | exact |
| `src/head/activation.ts` (new handler) | controller | request-response | `handleScheduleTrigger` (lines 1096–1317) — slimmed, no schedule row | role-match |
| `src/scheduler/proactive.ts` | service | request-response | `runProactiveDecision` + `ProactiveContext` (lines 155–202) | exact |
| `src/scheduler/prompts/sensor-dispatch.md` | config/template | — | `src/scheduler/prompts/tasks.md` with schedule tokens dropped | role-match |
| `src/types/agent.ts` | model/type | — | `AgentState.trigger` union (line 48) | exact |
| `skills/sensors/SKILL.md` | config/doc | — | existing two-sink section in that same file | exact |
| `src/sensors/runner.test.ts` (new cases) | test | — | existing dual-sink test cases (lines 23–160) | exact |
| `src/scheduler/proactive.test.ts` (new cases) | test | — | existing `runProactiveDecision` test structure (lines 1–90) | exact |
| `src/head/activation.test.ts` (new cases) | test | — | existing `handleScheduleTrigger` test structure (lines 256–314) | exact |

---

## Pattern Assignments

### `src/types/core.ts` — new `sensor_sub_agent_trigger` union member + `PRIORITY` entry

**Analog:** the existing `sensor_event` union member (lines 158–172) and `PRIORITY` map (lines 177–194)

**Existing `sensor_event` shape to mirror** (lines 158–172):
```typescript
| {
    /**
     * Push sink for a sensor's JSON payload (`{ ambient?, event? }`).
     * Enqueued for the sensor schedule's headId by the sensor runner (Plan 02)
     * and injected into the model turn by the context injector (Plan 03).
     * See SENSOR-15/16. Fields are minimal per D-02 (no severity/title/priority/headId).
     */
    type: 'sensor_event'
    id: string
    /** Which sensor reported — the schedule's taskName/slug. */
    slug: string
    /** The observation text (body of the sensor's JSON payload). */
    text: string
    createdAt: string
  }
```

**Existing `schedule_trigger` shape** (lines 122–130) — shows what NOT to replicate (has `scheduleId`/`taskName`/`kind` which are inapplicable):
```typescript
| {
    type: 'schedule_trigger'
    id: string
    scheduleId: string      // ← requires a real schedule row; cannot be null without surgery
    taskName: string | null
    kind: 'skill' | 'task' | 'reminder'
    createdAt: string
  }
```

**Existing `PRIORITY` map** (lines 177–194) — add `SENSOR_SUB_AGENT_TRIGGER: 10` immediately after `SENSOR_EVENT: 15`:
```typescript
export const PRIORITY = {
  USER_MESSAGE: 100,
  HEAD_MESSAGE: 70,
  AGENT_QUESTION: 50,
  AGENT_COMPLETED: 30,
  AGENT_FAILED: 30,
  AGENT_RESPONSE: 30,
  WEBHOOK: 20,
  // A sensor observation is an environmental push (like a webhook) but operator-cadenced
  // and is the active sibling of the passive ambient sink.  It ranks below a genuine
  // third-party `webhook` (20) yet above scheduler-internal `schedule_trigger`/
  // `reminder_trigger` (10), which themselves spawn/re-enqueue work.
  SENSOR_EVENT: 15,
  SCHEDULE_TRIGGER: 10,
  REMINDER_TRIGGER: 10,
} as const
```

**New type to add** (mirror `sensor_event`, swap `text` → `prompt`):
```typescript
| {
    /**
     * Silent sub-agent dispatch sink (`subAgentEvent: { prompt }` in sensor payload).
     * Enqueued by the sensor runner; handled by handleSensorSubAgentTrigger which
     * gates via the proactive steward then spawns a background agent.
     * Never reaches the head activation path. See SENSOR-17/19.
     */
    type: 'sensor_sub_agent_trigger'
    id: string
    /** Which sensor dispatched — used for skillName labeling (D-08). */
    slug: string
    /** The instruction for the spawned sub-agent (the subAgentEvent.prompt value). */
    prompt: string
    createdAt: string
  }
```

**New PRIORITY entry** — matches `SCHEDULE_TRIGGER` at 10 (background work, no live user waiting):
```typescript
SENSOR_SUB_AGENT_TRIGGER: 10,
```

---

### `src/sensors/runner.ts` — rename `event` → `headEvent` + add `subAgentEvent` branch

**Analog:** the existing event sink block (lines 130–166) — the third sink is an additive parallel branch.

**Existing dual-sink dispatch block** (lines 130–166) — the entire block to rename and extend:
```typescript
// ── Dual-sink dispatch ────────────────────────────────────────────────────
const payload = parsed as Record<string, unknown>
const { ambient, event } = payload            // ← rename `event` to `headEvent`

// Ambient sink: write only when the key is present AND a string.
// Empty string = retraction (writes empty file).
// Omitted key = leave stale (D-05).
if (typeof ambient === 'string') {
  fs.mkdirSync(path.join(ambientBaseDir, headId), { recursive: true })
  writeFileAtomicSync(outputPath, ambient.slice(0, SENSOR_OUTPUT_CAP), { mode: 0o644 })
}

// Event sink: enqueue only when event is a non-null object with a string text.
// Absent, non-object, or missing-text event → skip (not an error).
if (
  event !== null &&                           // ← rename all `event` → `headEvent`
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

**After rename, add the third sink immediately after the `headEvent` block** — copy the guard structure exactly:
```typescript
// Sub-agent event sink: enqueue only when subAgentEvent is a non-null object with a string prompt.
// Absent, non-object, or missing-prompt subAgentEvent → skip (not an error).
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
    writeFailure(`failed to enqueue sensor sub-agent trigger: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
  }
}
```

**Updated destructure line** (replaces line 132):
```typescript
const { ambient, headEvent, subAgentEvent } = payload
```

**JSDoc update** (lines 41–52) — the existing JSDoc says `{ ambient?, event? }`; update to:
```
 * The script MUST write exactly one JSON object
 * `{ ambient?, headEvent?, subAgentEvent? }` to stdout.
 *
 * - `ambient` (string): ...
 * - `headEvent` (object with `text: string`): enqueues a `sensor_event` ...
 * - `subAgentEvent` (object with `prompt: string`): enqueues a
 *   `sensor_sub_agent_trigger`, gated by the proactive steward, spawns a
 *   background sub-agent. Never wakes the head. (SENSOR-17/19)
```

---

### `src/head/activation.ts` — early-return dispatcher branch

**Analog:** the existing `schedule_trigger` early-return (lines 521–524):
```typescript
if (event.type === 'schedule_trigger') {
  await this.handleScheduleTrigger(event)
  return
}
```

**New branch to add immediately after** (before `let typingInterval` at line 526):
```typescript
if (event.type === 'sensor_sub_agent_trigger') {
  await this.handleSensorSubAgentTrigger(event)
  return
}
```

**Why the return must come before line 526:** `let typingInterval`, `coalescedEvents`, and `activationStart` assignments at lines 526–532 begin the head activation path. Falling through would wake the head — the opposite of SENSOR-19.

---

### `src/head/activation.ts` — `handleSensorSubAgentTrigger` new method

**Analog:** `handleScheduleTrigger` (lines 1096–1317) — take the spawn block (lines 1270–1316), strip the schedule-store lifecycle, replace task resolution with `event.prompt`, and replace `runProactiveDecision` with `runSensorDispatchDecision`.

**Proactive gate block to reuse from `handleScheduleTrigger`** (lines 1200–1238):
```typescript
// Proactive decision: run an LLM steward to decide whether this schedule should fire
if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
  const recentMsgs = this.opts.messages.getRecentTextByTokens(this.opts.headId, this.opts.config.stewardContextTokenBudget, estimateTokens).reverse()
  const { identityLoader } = this.opts.toolExecutorOpts

  const decision = await runProactiveDecision({   // ← swap to runSensorDispatchDecision
    skillName: taskName!,
    ...
  }, this.opts.llmRouter, this.opts.config.stewardModel,
     this.opts.usageStore, event.id)

  if (this.opts.config.proactiveShadow) {
    log.info(`[proactive:shadow] ${kind}:${taskName}: ${decision.action} — ${decision.reason}`)
  }

  if (this.opts.config.proactiveEnabled && decision.action === 'skip') {
    this.opts.scheduleStore.markSkipped(...)  // ← OMIT: no schedule row exists
    log.info(`[proactive] Skipped ${kind}:${taskName}: ${decision.reason}`)
    return
  }

  proactiveContext = decision.context
}
```

**Spawn block to reuse from `handleScheduleTrigger`** (lines 1307–1316):
```typescript
await this.opts.toolExecutorOpts.agentRunner.spawn({
  agentId,
  task: prompt,
  trigger: 'scheduled',    // ← change to 'sensor'
  headId: this.opts.headId,
  skillName: taskName!,    // ← change to `sensor:${event.slug}`
  ...(scheduledModel ? { model: scheduledModel } : {}),          // ← omit (no task meta)
  ...(schedule?.deliverToHeadIds?.length ? { ... } : {}),        // ← omit (no schedule row)
  ...(schedule?.relayGuidance ? { ... } : {}),                   // ← omit (no schedule row)
})
```

**New slim handler shape** (the entire new method, derived from stripping `handleScheduleTrigger`):
```typescript
private async handleSensorSubAgentTrigger(event: QueueEvent & { type: 'sensor_sub_agent_trigger' }): Promise<void> {
  let proactiveContext: string | undefined

  // Steward gate: same proactive config flags as task path (D-06)
  if (this.opts.config.proactiveShadow || this.opts.config.proactiveEnabled) {
    const recentMsgs = this.opts.messages.getRecentTextByTokens(
      this.opts.headId, this.opts.config.stewardContextTokenBudget, estimateTokens,
    ).reverse()
    const { identityLoader } = this.opts.toolExecutorOpts

    const decision = await runSensorDispatchDecision({
      slug: event.slug,
      prompt: event.prompt,
      userMd: identityLoader.readFile('USER.md') ?? '',
      recentHistory: recentMsgs
        .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt })),
      ambientContext: this.opts.config.workspacePath
        ? scanAmbient(this.opts.config.workspacePath.replace(/^~/, os.homedir()), this.opts.headId)
        : '',
      currentTime: formatIanaTimeLine(new Date(), this.opts.config.timezone),
    }, this.opts.llmRouter, this.opts.config.stewardModel, this.opts.usageStore, event.id)

    if (this.opts.config.proactiveShadow) {
      log.info(`[proactive:sensor:shadow] sensor:${event.slug}: ${decision.action} — ${decision.reason}`)
    }

    if (this.opts.config.proactiveEnabled && decision.action === 'skip') {
      // No schedule row to markSkipped — just log and return (D-19: no dedup/cooldown)
      log.info(`[proactive:sensor] Skipped sensor:${event.slug}: ${decision.reason}`)
      return
    }

    proactiveContext = decision.context
  }

  const agentId = generateAgentId(`sensor:${event.slug}`)
  const parts = [event.prompt]
  if (proactiveContext) parts.push(`Context from recent conversation: ${proactiveContext}`)
  const prompt = parts.join('\n\n')

  log.info(`[scheduler] sensor sub-agent dispatched for sensor:${event.slug}`)
  await this.opts.toolExecutorOpts.agentRunner.spawn({
    agentId,
    task: prompt,
    trigger: 'sensor',
    headId: this.opts.headId,
    skillName: `sensor:${event.slug}`,   // D-08: dashboard xray label
  })
}
```

---

### `src/scheduler/proactive.ts` — `runSensorDispatchDecision` + `SensorDispatchContext`

**Analog:** `runProactiveDecision` + `ProactiveContext` (lines 73–202) — copy the structure, drop schedule-shaped fields, swap `loadPrompt('tasks')` → `loadPrompt('sensor-dispatch')`, swap interpolation tokens.

**`ProactiveContext` interface** (lines 73–86) — existing schedule-shaped fields to DROP (`scheduleCron`, `lastRun`, `lastSkipped`, `lastSkipReason`, `conditions`, `skillInstructions`, `skillDescription`):
```typescript
export interface ProactiveContext {
  skillName: string
  skillDescription: string
  skillInstructions: string
  scheduleCron: string | null        // ← drop (no schedule)
  lastRun: string | null             // ← drop (no schedule)
  lastSkipped: string | null         // ← drop (no schedule)
  lastSkipReason: string | null      // ← drop (no schedule)
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
  conditions?: string                // ← drop (no schedule)
}
```

**`ProactiveDecision` return type** (lines 88–93) — reused unchanged:
```typescript
export interface ProactiveDecision {
  action: 'run' | 'skip'
  reason: string
  /** Optional context from conversation to pass to the skill agent when running. */
  context?: string
}
```

**`RUN_DEFAULT` constant** (line 95) — reused (exported, same fail-open behavior per D-07):
```typescript
const RUN_DEFAULT: ProactiveDecision = { action: 'run', reason: 'proactive decision failed, defaulting to run' }
```

**`runProactiveDecision` body** (lines 155–202) — the core LLM call pattern to mirror exactly:
```typescript
export async function runProactiveDecision(
  ctx: ProactiveContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ProactiveDecision> {
  ...
  const prompt = interpolate(loadPrompt('tasks'), {   // ← swap to 'sensor-dispatch'
    CURRENT_TIME: ctx.currentTime,
    SKILL_NAME: ctx.skillName,
    ...
  })

  try {
    const response = await stewardComplete(
      'steward-proactive', router, model, prompt, 256,
      usageStore, eventId, undefined,
      { name: 'proactive_decision', schema: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'skip'] }, reason: { type: 'string' }, context: { type: 'string' } }, required: ['action', 'reason'], additionalProperties: false } },
    )
    const parsed = extractJson(response.content) as { action?: string; reason?: string; context?: string }
    if (parsed.action === 'skip' && parsed.reason) {
      return { action: 'skip', reason: parsed.reason }
    }
    return {
      action: 'run',
      reason: parsed.reason ?? 'no reason to skip',
      ...(parsed.context ? { context: parsed.context } : {}),
    }
  } catch (err) {
    log.warn('[proactive] decision failed, defaulting to run:', (err as Error).message)
    return RUN_DEFAULT
  }
}
```

**New `SensorDispatchContext` interface** — drop all schedule-shaped fields, add `slug` + `prompt`:
```typescript
export interface SensorDispatchContext {
  /** Sensor slug — used for logging and context in the steward prompt. */
  slug: string
  /** The subAgentEvent.prompt from the sensor payload — the instruction to execute. */
  prompt: string
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
}
```

**New `runSensorDispatchDecision` function signature** (mirrors `runProactiveDecision` exactly):
```typescript
export async function runSensorDispatchDecision(
  ctx: SensorDispatchContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ProactiveDecision> {
  const prompt = interpolate(loadPrompt('sensor-dispatch'), {
    CURRENT_TIME: ctx.currentTime,
    SLUG: ctx.slug,
    SENSOR_PROMPT: ctx.prompt,
    USER_MD: ctx.userMd || '(empty)',
    AMBIENT: ctx.ambientContext || '(none)',
    HISTORY: formatTimestampedHistory(ctx.recentHistory),
  })

  try {
    const response = await stewardComplete(
      'steward-sensor-dispatch', router, model, prompt, 256,
      usageStore, eventId, undefined,
      { name: 'proactive_decision', schema: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'skip'] }, reason: { type: 'string' }, context: { type: 'string' } }, required: ['action', 'reason'], additionalProperties: false } },
    )
    const parsed = extractJson(response.content) as { action?: string; reason?: string; context?: string }
    if (parsed.action === 'skip' && parsed.reason) {
      return { action: 'skip', reason: parsed.reason }
    }
    return {
      action: 'run',
      reason: parsed.reason ?? 'no reason to skip',
      ...(parsed.context ? { context: parsed.context } : {}),
    }
  } catch (err) {
    log.warn('[proactive:sensor] decision failed, defaulting to run:', (err as Error).message)
    return RUN_DEFAULT
  }
}
```

---

### `src/scheduler/prompts/sensor-dispatch.md` — new steward prompt template

**Analog:** `src/scheduler/prompts/tasks.md` (full file) — drop `{SCHEDULE}`, `{LAST_RUN}`, `{SCHEDULE_CONDITIONS}`, `{SKILL_NAME}`, `{SKILL_DESCRIPTION}`, `{SKILL_INSTRUCTIONS}`; add `{SLUG}`, `{SENSOR_PROMPT}`.

**`tasks.md` structure to follow** (the full file):
```markdown
Current time: {CURRENT_TIME}

---

Scheduled task "{SKILL_NAME}" is due to run.
Description: {SKILL_DESCRIPTION}
Frequency: {SCHEDULE}
Last ran: {LAST_RUN}{SCHEDULE_CONDITIONS}

---

Task instructions:
{SKILL_INSTRUCTIONS}

---

User profile:
{USER_MD}

---

Ambient context (cached snapshot of user's current situation):
{AMBIENT}

---

Recent conversation:
{HISTORY}

---

You are deciding whether this scheduled task should run right now...
Run ({"action": "run"}) if: ...
Skip ({"action": "skip"}) only if: ...
Respond with JSON only: ...
```

**New `sensor-dispatch.md`** — keep the section structure, swap the header block:
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

Ambient context (cached snapshot of user's current situation):
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

---

### `src/types/agent.ts` — `AgentState.trigger` union + `SpawnOptions.trigger`

**Analog:** existing `trigger` union (line 48):
```typescript
trigger: 'manual' | 'scheduled' | 'ad_hoc'
```

**Change (one line):**
```typescript
trigger: 'manual' | 'scheduled' | 'ad_hoc' | 'sensor'
```

`SpawnOptions.trigger` (line 84) is `AgentState['trigger']` — automatically picks up the new value. DB column is `string` cast at `src/db/agents.ts:56` — no migration needed.

**Relay steward gate at `activation.ts:662` to be aware of:**
```typescript
if (a?.trigger !== 'scheduled') continue
```
This naturally excludes `'sensor'`-triggered agents from the relay steward gate — correct per D-09 (no new suppression machinery needed).

**`suspendAsQuestion` at `local.ts:1040` to be aware of:**
```typescript
if (options.trigger === 'scheduled') {
  this.completeAgent(agentId, question, options, history)
  return 'completed'
}
```
Using `'sensor'` means sensor-dispatched agents that reach a question state SUSPEND rather than auto-complete. Sensor prompts (create_reminder, etc.) should be self-contained — document this in code comments.

---

### `skills/sensors/SKILL.md` — three-sink contract update

**Analog:** the file's own existing two-sink section (lines 27–60) — update in place.

**Current contract line** (line 28) to replace:
```
  `{ "ambient"?: string, "event"?: { "text": string } }`
```

**Updated contract line:**
```
  `{ "ambient"?: string, "headEvent"?: { "text": string }, "subAgentEvent"?: { "prompt": string } }`
```

**Current "two sinks" section headings + body** (lines 41–end) — rename `### Event` to `### Head event (push, active)` and update all `"event"` references to `"headEvent"`. Add a new section after:

```markdown
### Sub-agent event (dispatch, silent)

A well-formed `"subAgentEvent": { "prompt": "..." }` entry dispatches a sub-agent
silently — without waking the head or sending any user-facing message. The prompt is
the task instruction for the spawned agent. The dispatch is gated by the proactive
steward ("should it run right now?") which defaults to running (the sensor has already
decided something happened). On steward skip, nothing runs.

**Which sink to use?**

| Goal | Sink |
|------|------|
| Always-present snapshot — "what's the current state" | `ambient` |
| Wake the head to talk to the user or make a judgment call | `headEvent` |
| Get quiet work done without a message (create reminder, log something) | `subAgentEvent` |
```

---

## Shared Patterns

### Guard pattern: "present + well-typed → act, else skip (not an error)"

**Source:** `src/sensors/runner.ts` lines 144–166 (existing `event` guard)
**Apply to:** the new `headEvent` and `subAgentEvent` guards in `runner.ts`

```typescript
// Template — works for any sink; swap field name and inner key:
if (
  SINK_VAR !== null &&
  typeof SINK_VAR === 'object' &&
  !Array.isArray(SINK_VAR) &&
  typeof (SINK_VAR as Record<string, unknown>)['INNER_KEY'] === 'string'
) {
  const value = (SINK_VAR as Record<string, unknown>)['INNER_KEY'] as string
  try {
    enqueue.enqueue({ type: '...', ... }, PRIORITY.X, headId)
  } catch (enqueueErr) {
    writeFailure(`failed to enqueue ...: ${(enqueueErr as Error).message ?? String(enqueueErr)}`)
  }
}
```

### Early-return dispatcher pattern

**Source:** `src/head/activation.ts` lines 521–524
**Apply to:** `sensor_sub_agent_trigger` branch in `handleEvent`

```typescript
if (event.type === 'schedule_trigger') {
  await this.handleScheduleTrigger(event)
  return
}
// New branch follows immediately:
if (event.type === 'sensor_sub_agent_trigger') {
  await this.handleSensorSubAgentTrigger(event)
  return
}
// Both must come BEFORE line 526 (let typingInterval = ...)
```

### Proactive steward fail-open pattern

**Source:** `src/scheduler/proactive.ts` lines 95, 198–201
**Apply to:** `runSensorDispatchDecision`'s catch block

```typescript
const RUN_DEFAULT: ProactiveDecision = { action: 'run', reason: 'proactive decision failed, defaulting to run' }

// In catch block:
} catch (err) {
  log.warn('[proactive:sensor] decision failed, defaulting to run:', (err as Error).message)
  return RUN_DEFAULT
}
```

### `proactiveContext` optional spread into prompt

**Source:** `src/head/activation.ts` lines 1277–1279
**Apply to:** `handleSensorSubAgentTrigger` prompt assembly

```typescript
const parts = [event.prompt]
if (proactiveContext) parts.push(`Context from recent conversation: ${proactiveContext}`)
const prompt = parts.join('\n\n')
```

### `stewardComplete` tool call shape (identical for `runSensorDispatchDecision`)

**Source:** `src/scheduler/proactive.ts` lines 184–188
**Apply to:** `runSensorDispatchDecision`'s LLM call — use the SAME tool schema

```typescript
const response = await stewardComplete(
  'steward-sensor-dispatch', router, model, prompt, 256,
  usageStore, eventId, undefined,
  { name: 'proactive_decision', schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'skip'] },
        reason: { type: 'string' },
        context: { type: 'string' }
      },
      required: ['action', 'reason'],
      additionalProperties: false
  } },
)
```

---

## Test Patterns

### `src/sensors/runner.test.ts` — new cases to add

**Analog:** existing test structure (lines 1–160). The file already has `describe('runSensor — dual-sink, head-scoped', ...)`.

**Test factory pattern** (lines 12–21):
```typescript
function makeSink(): SensorEventSink & { enqueue: ReturnType<typeof vi.fn> } {
  return { enqueue: vi.fn() }
}

function writeScript(dir: string, name: string, content: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}
```

**Existing both-fields test** (lines 45–68) — template for new `subAgentEvent` enqueue test:
```typescript
it('both-fields: writes ambient file AND enqueues sensor_event', async () => {
  const script = writeScript(tmpDir, 'both.mjs',
    `process.stdout.write(JSON.stringify({ ambient: "72F sunny", event: { text: "storm approaching" } }))`)
  const sink = makeSink()
  await runSensor(slug, headId, script, ambientBaseDir, sink)
  expect(sink.enqueue).toHaveBeenCalledOnce()
  const [event, priority, enqueuedHeadId] = sink.enqueue.mock.calls[0] as [QueueEvent, number, string]
  expect(event.type).toBe('sensor_event')
  expect(priority).toBe(PRIORITY.SENSOR_EVENT)
  expect(enqueuedHeadId).toBe(headId)
})
```

**New tests to add** (mirror the existing patterns):
- `headEvent` key (not `event`) enqueues `sensor_event` — mirror the both-fields test
- Old `event` key no longer enqueues anything — a script emitting `{ event: { text: "x" } }` must call `sink.enqueue` 0 times
- `subAgentEvent: { prompt }` enqueues `sensor_sub_agent_trigger` at `PRIORITY.SENSOR_SUB_AGENT_TRIGGER`
- Malformed `subAgentEvent` (missing `prompt`, wrong type, null) → `sink.enqueue` not called (silent skip)
- All three sinks active simultaneously: `sink.enqueue` called twice (headEvent + subAgentEvent)

### `src/scheduler/proactive.test.ts` — new cases for `runSensorDispatchDecision`

**Analog:** existing `runProactiveDecision` test structure (lines 1–90).

**Context factory pattern** (lines 6–24):
```typescript
function makeContext(overrides: Partial<ProactiveContext> = {}): ProactiveContext {
  return {
    skillName: 'email-triage',
    skillDescription: 'Triage unread emails',
    ...overrides,
  }
}
```

**Router mock pattern** (lines 26–36):
```typescript
function makeRouter(content: string): LLMRouter {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      inputTokens: 100, outputTokens: 20,
      model: 'claude-haiku-4-5-20251001',
      stopReason: 'end_turn',
    }),
  } as unknown as LLMRouter
}
```

**Error/default pattern** (lines 57–64):
```typescript
it('defaults to run on LLM error', async () => {
  const router = {
    complete: vi.fn().mockRejectedValue(new Error('API timeout')),
  } as unknown as LLMRouter
  const decision = await runProactiveDecision(makeContext(), router, 'dumb', makeUsageStore())
  expect(decision.action).toBe('run')
  expect(decision.reason).toContain('defaulting to run')
})
```

**New tests to add for `runSensorDispatchDecision`**:
- Returns `run` when LLM says `run`
- Returns `skip` when LLM says `skip`
- Defaults to `run` on LLM error (`expect(decision.reason).toContain('defaulting to run')`)
- Defaults to `run` on malformed JSON
- Threads `context` field through when LLM returns it

### `src/head/activation.test.ts` — new cases for `handleSensorSubAgentTrigger`

**Analog:** existing `handleScheduleTrigger` test structure (lines 248–314).

**Private method invocation pattern** (lines 256–261) — access `handleSensorSubAgentTrigger` the same way:
```typescript
async function fire(loop: ActivationLoop, event: QueueEvent & { type: 'schedule_trigger' }): Promise<void> {
  await (loop as unknown as { handleScheduleTrigger: (e: typeof event) => Promise<void> })
    .handleScheduleTrigger(event)
}
```

**Event factory pattern** (lines 248–254):
```typescript
function jobEvent(taskName: string | null, kind: 'task' | 'reminder' = 'task'): QueueEvent & { type: 'schedule_trigger' } {
  return { type: 'schedule_trigger', id: 'qe_1', scheduleId: 's1', taskName, kind, createdAt: new Date().toISOString() }
}
```

**Spawn assertion pattern** (lines 271–284):
```typescript
it('task: spawns with body-as-prompt and skillName=<task name> ...', async () => {
  fix = makeFixture()
  await fire(fix.loop, jobEvent('bar', 'task'))
  expect(fix.agentRunner.spawn).toHaveBeenCalledOnce()
  const args = vi.mocked(fix.agentRunner.spawn).mock.calls[0]![0] as any
  expect(args.task).toBe('Vacuum the database now.')
  expect(args.skillName).toBe('bar')
  expect(args.trigger).toBe('scheduled')
})
```

**Proactive mock in fixture** (lines 26–33 and 172–173):
```typescript
vi.mock('../scheduler/proactive.js', async () => {
  const actual = await vi.importActual<typeof import('../scheduler/proactive.js')>('../scheduler/proactive.js')
  return {
    ...actual,
    runProactiveDecision: vi.fn(),
    runReminderDecision: vi.fn(),
    // add: runSensorDispatchDecision: vi.fn(),
  }
})
// In makeFixture:
vi.mocked(proactive.runProactiveDecision).mockResolvedValue(decision as any)
// add:
vi.mocked(proactive.runSensorDispatchDecision).mockResolvedValue(decision as any)
```

**New tests to add**:
- `sensor_sub_agent_trigger` dispatches `agentRunner.spawn` with `trigger:'sensor'` and `skillName:'sensor:<slug>'`
- `sensor_sub_agent_trigger` with `proactiveEnabled: true` and skip decision: `agentRunner.spawn` NOT called
- `sensor_sub_agent_trigger` does NOT reach the head activation path (head LLM never called — verify `assembler.assemble` not called)
- `sensor_sub_agent_trigger` with `proactiveEnabled: false`: spawns directly (no `runSensorDispatchDecision` call)

---

## No Analog Found

All files have analogs. No gaps.

---

## Workspace Sensor Migration (read-only reference — no pattern extraction needed)

Verified change locations from RESEARCH.md:

| File | Change | Line |
|------|--------|------|
| `~/.shrok/workspace/sensors/relay/sensor.mjs` | `event:` → `headEvent:` | line 55 |
| `~/.shrok/workspace/sensors/example-sensor/sensor.mjs` | `event:` → `headEvent:` + add `subAgentEvent` demo | lines 67–69 |
| `~/.shrok/workspace/sensors/calendar/sensor.mjs` | No change (ambient-only confirmed) | — |
| `~/.shrok/workspace/sensors/disk-space/sensor.mjs` | Verify no `event` key before marking done | — |
| `~/.shrok/workspace/sensors/weather/sensor.mjs` | Verify no `event` key before marking done | — |

---

## Metadata

**Analog search scope:** `src/sensors/`, `src/types/`, `src/head/`, `src/scheduler/`, `src/sub-agents/`, `skills/sensors/`
**Files read:** `src/types/core.ts`, `src/sensors/runner.ts`, `src/scheduler/proactive.ts`, `src/head/activation.ts` (4 targeted ranges), `src/types/agent.ts`, `src/sub-agents/local.ts` (2 targeted ranges), `src/scheduler/prompts/tasks.md`, `skills/sensors/SKILL.md`, `src/sensors/runner.test.ts`, `src/scheduler/proactive.test.ts`, `src/head/activation.test.ts`
**Pattern extraction date:** 2026-06-20
