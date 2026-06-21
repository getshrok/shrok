---
phase: quick-260621-dom
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/sensors/runner.ts
  - src/index.ts
  - src/scheduler/index.ts
  - src/types/core.ts
  - src/head/activation.ts
  - src/dashboard/routes/schedules.ts
  - src/db/schedules.ts
  - dashboard/src/pages/SchedulesPage.tsx
  - src/sensors/runner.test.ts
  - src/dashboard/routes/schedules.test.ts
autonomous: true
requirements: [SENSOR-MULTIHEAD]
must_haves:
  truths:
    - "A kind:'script' sensor schedule with deliverToHeadIds runs its script ONCE and delivers identical output to every target head"
    - "The dashboard create/edit forms expose the 'Also deliver to' head-picker for sensor (script) schedules"
    - "The schedules POST/PATCH routes accept deliverToHeadIds for kind:'script' and still reject it for kind:'reminder'"
  artifacts:
    - path: "src/sensors/runner.ts"
      provides: "runSensor fans the three sinks out to a delivery set after a single script execution"
    - path: "src/head/activation.ts"
      provides: "handleSensorSubAgentTrigger threads event.deliverToHeadIds into the single spawn"
  key_links:
    - from: "src/scheduler/index.ts"
      to: "src/sensors/runner.ts"
      via: "sensorRunner.run(slug, ownerHeadId, deliverToHeadIds)"
      pattern: "sensorRunner\\.run"
    - from: "src/sensors/runner.ts"
      to: "queue enqueue"
      via: "sensor_event per head + sensor_sub_agent_trigger with deliverToHeadIds"
      pattern: "sensor_sub_agent_trigger"
---

<objective>
Give sensor schedules (`kind:'script'`) multi-head delivery, matching how task schedules already do it via the Phase 44 `deliverToHeadIds` fan-out.

A sensor schedule fires → its script runs ONCE → each of its three sinks (ambient file, head event, sub-agent dispatch) fans out to the delivery set `dedupe([schedule.headId, ...schedule.deliverToHeadIds])`. The sub-agent path reuses the EXISTING Phase 44 task-completion fan-out (`src/sub-agents/local.ts completeAgent`) — a single sub-agent is spawned with `deliverToHeadIds` set.

Purpose: sensor observations (weather, host health, calendar) can now reach multiple heads from one run — no duplicate API calls, no inconsistent observations.
Output: backend runner fan-out, queue-event type field, activation threading, route validation, dashboard head-picker, and mirrored tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@AGENTS.md

<!-- LOCKED design lives in the planning task description; this plan implements it exactly. -->

<interfaces>
<!-- Verified line numbers and contracts the executor needs — no codebase exploration required. -->

Current `runSensor` signature (src/sensors/runner.ts ~line 74):
```typescript
export async function runSensor(
  slug: string,
  headId: string,
  scriptPath: string,
  ambientBaseDir: string,
  enqueue: SensorEventSink,
  timeoutMs = SENSOR_TIMEOUT_MS,
): Promise<void>
```
The `SensorRunner` interface (~line 33) is `run(slug: string, headId: string): Promise<void>`.

Current per-sink behavior inside runSensor:
- ambient (~line 143): writes `ambientBaseDir/<headId>/<slug>.md`.
- headEvent (~line 158): `enqueue.enqueue({ type:'sensor_event', id, slug, text, createdAt }, PRIORITY.SENSOR_EVENT, headId)`.
- subAgentEvent (~line 188): `enqueue.enqueue({ type:'sensor_sub_agent_trigger', id, slug, prompt, ...(relayGuidance?{relayGuidance}:{}), createdAt }, PRIORITY.SENSOR_SUB_AGENT_TRIGGER, headId)`.

Concrete wrapper (src/index.ts ~line 519):
```typescript
const sensorRunner = {
  run(slug: string, headId: string): Promise<void> {
    const scriptPath = path.join(workspacePath, 'sensors', slug, 'sensor.mjs')
    const ambientBaseDir = path.join(workspacePath, 'ambient')
    return runSensor(slug, headId, scriptPath, ambientBaseDir, queue)
  },
}
```

Scheduler call site (src/scheduler/index.ts ~line 74):
```typescript
this.sensorRunner.run(slug, schedule.headId).catch(...)
```

`sensor_sub_agent_trigger` QueueEvent type (src/types/core.ts ~line 180) currently has: `type, id, slug, prompt, relayGuidance?, createdAt`.

handleSensorSubAgentTrigger spawn (src/head/activation.ts ~line 1158):
```typescript
await this.opts.toolExecutorOpts.agentRunner.spawn({
  agentId,
  task: prompt,
  trigger: 'sensor',
  headId: this.opts.headId,
  ...(event.relayGuidance ? { relayGuidance: event.relayGuidance } : {}),
})
```
The scheduled-TASK spawn (~line 1378) already threads delivery via: `...(schedule?.deliverToHeadIds?.length ? { deliverToHeadIds: schedule.deliverToHeadIds } : {})`. The spawn() option `deliverToHeadIds` is already plumbed end-to-end (consumed by `src/sub-agents/local.ts completeAgent` which fans completion to `[...new Set([this.headId, ...(options.deliverToHeadIds ?? [])])]`). NO new spawn/completion plumbing is needed — just pass the field.

schedules route POST (src/dashboard/routes/schedules.ts ~line 87): `deliverToHeadIds` validated/deduped/known-head-checked only when `kind === 'task'`; an `else if` (~line 111) returns 400 "deliverToHeadIds is only valid for task schedules" for non-task kinds.
schedules route PATCH (~line 364): guards `existing.kind !== 'task'` → 400.

db schedule doc comment (src/db/schedules.ts ~line 24): "Only meaningful for kind:'task'."

Dashboard sensor schedule forms (dashboard/src/pages/SchedulesPage.tsx):
- `SensorScheduleRow` edit modal (~line 1111) — currently NO head-picker; updateMutation only sends `{ cron?, runAt?, conditions? }`.
- `AddSensorScheduleForm` (~line 1277) — currently NO head-picker; createMutation sends `{ headId, taskName, kind:'script', cron|runAt, conditions?, startAt? }`.
- The TASK forms' head-picker pattern to mirror: create form ~line 432, edit modal ~line 277 (a `<select multiple>` over `headsQuery.data.heads` filtered to exclude the owner head, "Also deliver to" label, "Hold Ctrl/Cmd... Owner head always included." hint).
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Backend run-once fan-out (runner + scheduler + index + types + activation + route + doc)</name>
  <files>src/sensors/runner.ts, src/index.ts, src/scheduler/index.ts, src/types/core.ts, src/head/activation.ts, src/dashboard/routes/schedules.ts, src/db/schedules.ts</files>
  <behavior>
    - runSensor runs the script ONCE regardless of head count (single execFile).
    - ambient sink: the IDENTICAL computed body is written to `ambient/<headId>/<slug>.md` for EVERY head in the delivery set.
    - headEvent sink: the same `sensor_event` payload (same slug/text shape) is enqueued once per head in the delivery set, each with that head's id as the enqueue headId.
    - subAgentEvent sink: enqueues exactly ONE `sensor_sub_agent_trigger` to the OWNER head with `deliverToHeadIds` carrying the extra heads; the field is omitted when there are no extra heads.
    - Delivery set is `dedupe([ownerHeadId, ...extraHeadIds])` — owner first, no duplicates; a head listed in both appears once.
    - Per-head headId charset guard still applies to every target head (reject empty/invalid before any path I/O), preserving the existing path-traversal mitigation.
    - schedules POST/PATCH accept deliverToHeadIds for kind:'script' (same validation/dedupe/known-head checks as task) and STILL reject it for kind:'reminder'.
  </behavior>
  <action>
Implement the run-once fan-out across the backend. LOCKED design — implement exactly; do not loop `sensorRunner.run()` per head.

1. **src/sensors/runner.ts** — extend `runSensor` to fan out internally after the single script execution:
   - Add a trailing optional param `deliverToHeadIds: string[] = []` AFTER `enqueue` and BEFORE `timeoutMs` is awkward (would reorder a defaulted param). Instead add it as the LAST param after `timeoutMs`: `runSensor(slug, headId, scriptPath, ambientBaseDir, enqueue, timeoutMs = SENSOR_TIMEOUT_MS, deliverToHeadIds: string[] = [])`. Keep the existing `headId` as the OWNER/primary head so all current call sites and the entire existing test suite keep compiling unchanged.
   - Compute `const deliverySet = [...new Set([headId, ...deliverToHeadIds])]` near the top, AFTER the slug guard and AFTER validating EACH member of the delivery set with the existing `/^[a-z0-9][a-z0-9-]*$/` headId charset guard (loop the set; throw on the first invalid/empty member, same error message shape as today). The single execFile call is unchanged.
   - ambient sink: keep computing the body once (`ambient.slice(0, SENSOR_OUTPUT_CAP)`), then write it to `path.join(ambientBaseDir, hid, slug + '.md')` for each `hid` of `deliverySet` (mkdir per head). The `writeFailure` helper currently closes over the single `headId`/`outputPath` — keep failure markers going to the OWNER head only (do not fan out failure markers; the locked design fans out the three SUCCESS sinks).
   - headEvent sink: loop `deliverySet`, enqueueing the same event shape (fresh `generateId('qe')` id per enqueue is fine) once per head with that `hid` as the third enqueue arg.
   - subAgentEvent sink: enqueue ONCE to `headId` (owner) with the event gaining `...(deliverToHeadIds.length ? { deliverToHeadIds } : {})`. Use the EXTRA heads list (`deliverToHeadIds`, not the full delivery set) so the owner is not duplicated into its own deliver-to.
   - Update the `SensorRunner` interface to `run(slug: string, headId: string, deliverToHeadIds?: string[]): Promise<void>`.
   - Update the JSDoc to note the run-once-fan-out semantics and that `deliverToHeadIds` extends ambient + headEvent to every target head and rides on the single sub-agent trigger.

2. **src/index.ts (~519)** — update the concrete `sensorRunner.run` to accept `deliverToHeadIds?: string[]` and forward it: `return runSensor(slug, headId, scriptPath, ambientBaseDir, queue, undefined, deliverToHeadIds)`. (Pass `undefined` for timeoutMs to keep the default; `exactOptionalPropertyTypes` — a defaulted positional param accepts an explicit `undefined`, this is fine for a plain function param, not an object property.)

3. **src/scheduler/index.ts (~74)** — change the call to pass the extra heads: `this.sensorRunner.run(slug, schedule.headId, schedule.deliverToHeadIds ?? []).catch(...)`. Keep the `enqueued = true` line (one-time script schedules must still disable — Pitfall 1).

4. **src/types/core.ts (~180)** — add `deliverToHeadIds?: string[]` to the `sensor_sub_agent_trigger` event variant, with a doc comment mirroring the `relayGuidance?` field ("Extra heads to fan the sub-agent's completion out to; rides the existing Phase 44 task-completion fan-out. Absent = owner-only.").

5. **src/head/activation.ts (~1158)** — in `handleSensorSubAgentTrigger`, add to the spawn options: `...(event.deliverToHeadIds?.length ? { deliverToHeadIds: event.deliverToHeadIds } : {})`. This reuses the SAME spawn→completeAgent fan-out the scheduled-task path uses; no other change.

6. **src/dashboard/routes/schedules.ts** — extend deliverToHeadIds acceptance to kind:'script':
   - POST (~87): change the `if (kind === 'task')` guard to `if (kind === 'task' || kind === 'script')` for the validate/dedupe/known-head block, and update the `else if` 400 branch + its message to reflect that it is rejected for reminders only (e.g. "deliverToHeadIds is not valid for reminder schedules"). Keep the identical Array/non-empty-string/known-head/dedupe logic.
   - PATCH (~368): change `existing.kind !== 'task'` to `existing.kind === 'reminder'` (i.e. allow task AND script, reject only reminder); update the 400 message to match. Keep the identical validation + `[...new Set(ids)]` dedupe.

7. **src/db/schedules.ts (~24)** — update the doc comment for `deliverToHeadIds` to say it is meaningful for kind:'task' AND kind:'script' (absent on reminders/legacy rows = owner-only; do NOT migrate to []).

Run `npx tsc --noEmit` — `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are ON, so null-check array indexing and OMIT optional keys rather than setting `undefined`.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit</automated>
  </verify>
  <done>tsc passes clean; runSensor fans the three success sinks across dedupe([owner, ...extra]) after one execFile; sub-agent trigger carries deliverToHeadIds and activation threads it into a single spawn; routes accept deliverToHeadIds for script, reject for reminder.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Tests (sensor runner fan-out + route validation) and dashboard head-picker</name>
  <files>src/sensors/runner.test.ts, src/dashboard/routes/schedules.test.ts, dashboard/src/pages/SchedulesPage.tsx</files>
  <behavior>
    - Sensor runner test: with deliverToHeadIds=['bob','carol'] and owner 'ashley', the script executes ONCE (assert via a script that writes a side-effect marker file or a counter, OR assert the JSON output is parsed once by checking enqueue call count matches head count not multiplied by re-runs); ambient written to ashley/, bob/, carol/ with identical content; sensor_event enqueued 3× (once per head, each with its own headId as 3rd arg); sensor_sub_agent_trigger enqueued exactly ONCE to 'ashley' with event.deliverToHeadIds === ['bob','carol'].
    - Dedupe: owner included in deliverToHeadIds does not double-write / double-enqueue.
    - No-extra-heads: deliverToHeadIds=[] or omitted → ambient to owner only, 1 sensor_event, sub-agent trigger has NO deliverToHeadIds key.
    - Route test: POST kind:'script' with valid deliverToHeadIds persists deduped set; POST kind:'reminder' with deliverToHeadIds → 400; PATCH a script schedule's deliverToHeadIds succeeds; unknown head → 404.
  </behavior>
  <action>
Mirror the existing Phase 44 task fan-out test style.

1. **src/sensors/runner.test.ts** — add a new `describe('runSensor — multi-head fan-out')` block following the existing helpers (`makeSink`, `writeScript`, the tmpDir/ambientBaseDir setup at ~line 23). For "runs once" assertion: write a sensor script that emits all three sinks (`{ ambient, headEvent:{text}, subAgentEvent:{prompt} }`), and assert the single-execution invariant by checking `sink.enqueue` was called exactly `headCount` (for sensor_event) + 1 (for the single sub-agent trigger) times — N re-runs would multiply this. Add cases:
   - owner 'ashley' + `['bob','carol']`: assert ambient files exist at `<ambientBaseDir>/ashley/<slug>.md`, `/bob/`, `/carol/` with identical contents; collect the `sensor_event` enqueue calls and assert their 3rd-arg headIds are exactly `{ashley,bob,carol}`; assert exactly one `sensor_sub_agent_trigger` whose 3rd-arg headId is 'ashley' and whose `event.deliverToHeadIds` deep-equals `['bob','carol']`.
   - dedupe: owner 'ashley' + `['ashley','bob']` → ambient written to ashley/ and bob/ only; 2 sensor_events; sub-agent trigger deliverToHeadIds is `['ashley','bob']` (the extra-list as passed) OR document that the runner passes the raw extra list — match whatever the implementation does; the key assertion is no THIRD ashley write.
   - empty: owner only, `[]` → 1 ambient (ashley), 1 sensor_event, sub-agent trigger has no `deliverToHeadIds` key (`expect('deliverToHeadIds' in event).toBe(false)`).
   - Keep all existing tests passing (they call `runSensor(slug, headId, ...)` with no extra arg — the defaulted param preserves behavior).

2. **src/dashboard/routes/schedules.test.ts** — find the existing task deliverToHeadIds route tests (search `deliverToHeadIds`) and add parallel cases: POST `kind:'script'` with a valid deliverToHeadIds persists the deduped set on the created schedule; POST `kind:'reminder'` with deliverToHeadIds → 400; POST `kind:'script'` with an unknown head id → 404; PATCH an existing script schedule's deliverToHeadIds → 200 and the set updates.

3. **dashboard/src/pages/SchedulesPage.tsx** — add the "Also deliver to" head-picker to BOTH sensor forms, mirroring the task forms:
   - `AddSensorScheduleForm` (~1277): add `const [deliverToHeadIds, setDeliverToHeadIds] = useState<string[]>([])`; render a `<select multiple>` (copy the task create-form markup at ~432: label "Also deliver to", options = `headsQuery.data.heads` filtered to exclude the selected `headId`, only render the block when at least one other head exists); include `...(deliverToHeadIds.length ? { deliverToHeadIds } : {})` in the `api.schedules.create({...})` call.
   - `SensorScheduleRow` (~1111): add `const [editDeliverToHeadIds, setEditDeliverToHeadIds] = useState<string[]>([])`; seed it in `startEdit()` from `schedule.deliverToHeadIds ?? []`; add the same `<select multiple>` markup (mirror the task edit modal at ~277, filtering out `schedule.headId`); widen `updateMutation`'s param type to include `deliverToHeadIds?: string[]` and include it in `commitEdit()`'s `updateMutation.mutate({...})` calls (both the cron and runAt branches), and add `deliverToHeadIds` to the unchanged-check so a delivery-set-only edit still PATCHes (mirror the task form's `deliverUnchanged` logic at ~146). Use a `headsQuery` (`useQuery({ queryKey:['heads'], queryFn: api.heads.list })`) in `SensorScheduleRow` if not already present — copy from `AddSensorScheduleForm`.
   - Do NOT touch `dashboard/dist/`.

Run the affected test files and the type-checks.
  </action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx vitest run src/sensors/runner.test.ts src/dashboard/routes/schedules.test.ts && npx tsc --noEmit && cd dashboard && npx tsc --noEmit -p tsconfig.json 2>/dev/null || (cd dashboard && npx tsc --noEmit)</automated>
  </verify>
  <done>New runner fan-out tests + route validation tests pass; all pre-existing runner/route tests still pass; both sensor forms show the head-picker; backend and dashboard type-check clean; dashboard/dist not staged.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes at repo root (and in dashboard/).
- `npx vitest run src/sensors/runner.test.ts src/dashboard/routes/schedules.test.ts` green.
- A sensor schedule with deliverToHeadIds runs its script ONCE: ambient files appear under every target head's dir with identical content; one sensor_event per head; a single sensor_sub_agent_trigger carrying deliverToHeadIds.
- Route POST/PATCH accept deliverToHeadIds for kind:'script', reject for kind:'reminder'.
- `git status` shows no `dashboard/dist/` staged.
</verification>

<success_criteria>
Sensor (`kind:'script'`) schedules deliver identical output to multiple heads via `deliverToHeadIds`, run-once-fan-out, exactly mirroring the Phase 44 task fan-out — backend, queue-event type, activation threading, route validation, dashboard head-picker (create + edit), db doc comment, and mirrored tests all in place. Committed to `main` (no branch, no PR, dashboard/dist unstaged).
</success_criteria>

<output>
Create `.planning/quick/260621-dom-sensor-schedules-multi-head-delivery-del/260621-dom-01-SUMMARY.md` when done.
</output>
