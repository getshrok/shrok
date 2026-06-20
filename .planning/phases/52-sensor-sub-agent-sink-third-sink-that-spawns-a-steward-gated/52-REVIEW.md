---
phase: 52-sensor-sub-agent-sink-third-sink-that-spawns-a-steward-gated
reviewed: 2026-06-20T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - src/types/core.ts
  - src/types/agent.ts
  - src/sensors/runner.ts
  - src/scheduler/proactive.ts
  - src/scheduler/prompts/sensor-dispatch.md
  - src/head/activation.ts
  - src/head/assembler.ts
  - src/llm/tool-loop.ts
  - src/db/usage.ts
  - sensors/example-sensor/sensor.mjs
  - src/sensors/runner.test.ts
  - src/scheduler/proactive.test.ts
  - src/head/activation.test.ts
findings:
  critical: 1
  warning: 2
  info: 2
  total: 5
status: issues_found
---

# Phase 52: Code Review Report

**Reviewed:** 2026-06-20
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 52 adds the third sensor sink (`subAgentEvent`), renames the Phase-51 `event` sink to `headEvent`, and wires a schedule-less `sensor_sub_agent_trigger` queue event that gates through the proactive steward and spawns a background sub-agent without waking the head.

The core wiring is largely correct and matches the locked decisions:

- **Head-bypass at the *dispatch* point is correct** — `handleSensorSubAgentTrigger` early-returns at `activation.ts:526-529`, before any history append or context assembly (verified by `assembler.assemble` never-called test). The dispatch itself does not wake the head.
- **Steward fail-open is correct (D-07)** — `runSensorDispatchDecision` mirrors `runProactiveDecision` exactly: defaults to `run` on LLM error / malformed JSON, gated by the same `proactiveShadow`/`proactiveEnabled` flags (D-06).
- **No schedule-store lifecycle calls** on the sensor path — no `markSkipped`/`lastRun`/`delete` against a nonexistent row (verified by test).
- **The `event`→`headEvent` rename is clean** — no dangling references to the old key anywhere; no back-compat fallback (correct per no-back-compat directive).
- **Exhaustiveness ripple is consistent** — `'sensor'` trigger added to `usage.ts`/`tool-loop.ts`/`agent.ts`; `deriveQueryText` handles the new queue type; injection switches have safe `default`s; SQL `trigger` column is plain TEXT (no CHECK to reject `'sensor'`).
- **No new UTC at a model-facing surface** — the prompt's `{CURRENT_TIME}` is fed `formatIanaTimeLine` (zone-abbreviated local), the same already-correct surface every other steward uses.

However, the head-bypass guarantee is only enforced at the *dispatch* point. **The eventual sub-agent *completion* and *suspension* paths both special-case `trigger === 'scheduled'` and were not extended to `'sensor'`**, so the silent-work promise (D-09) breaks at completion time. This is the explicit anti-goal of the phase and is the Critical finding below.

## Critical Issues

### CR-01: Sensor agent completions bypass the relay steward and inject into the head unconditionally (head-chatter anti-goal)

**File:** `src/head/activation.ts:667`
**Issue:**
D-09 promises the sensor sub-agent reuses "the existing `agent_completed` → relay/output-steward path" so a quiet "create a reminder" agent stays silent. But the relay steward — the gate that decides whether a background agent's output warrants waking the head — only runs for scheduled agents:

```ts
for (const ce of completedEvents) {
  const a = this.opts.agentStore.get(ce.agentId)
  if (a?.trigger !== 'scheduled') continue   // ← sensor agents skip the relay steward entirely
  ...
  const relay = await runRelaySteward(...)
  if (!relay) { suppressedEventIds.add(ce.id) ... }
}
```

A `trigger: 'sensor'` agent (set by `handleSensorSubAgentTrigger`'s `spawn({ trigger: 'sensor', ... })`) hits `continue`, is never evaluated by the relay steward, is never added to `suppressedEventIds`, and its output is therefore **injected into the head unconditionally** — exactly the head-chatter the silent sink exists to avoid. The whole value proposition ("the head never sends an unnecessary message") fails for every sensor sub-agent that produces any output.

**Fix:** Include `'sensor'` wherever `'scheduled'` denotes a head-less background agent that must pass the relay gate. Change the guard to admit both triggers:

```ts
if (a?.trigger !== 'scheduled' && a?.trigger !== 'sensor') continue
```

(Consider a shared predicate, e.g. `isBackgroundTrigger(t): t is 'scheduled' | 'sensor'`, used at all three `=== 'scheduled'` sites — see CR-01/WR-01/WR-02 — so the next background trigger can't silently miss one.)

## Warnings

### WR-01: A sensor sub-agent calling `ask_user` suspends and wakes the head instead of force-completing

**File:** `src/sub-agents/local.ts:1040`
**Issue:**
`suspendAsQuestion` force-completes only scheduled agents, on the rationale "scheduled agents have no human attached":

```ts
if (options.trigger === 'scheduled') {
  this.completeAgent(agentId, question, options, history)
  return 'completed'
}
this.agentStore.suspend(...)   // sensor agents fall through here
// ...enqueues an agent_question that wakes the head
```

A sensor sub-agent is equally human-less and head-bypassing by design, but `trigger: 'sensor'` falls through to the `else` branch: it suspends and enqueues an `agent_question` (priority 50), which activates the head — another head-chatter leak (and a stuck/suspended agent on the dashboard). Any sensor prompt that leads the sub-agent to ask a clarifying question triggers this.

**Fix:** Treat `'sensor'` the same as `'scheduled'` here:

```ts
if (options.trigger === 'scheduled' || options.trigger === 'sensor') {
  this.completeAgent(agentId, question, options, history)
  return 'completed'
}
```

### WR-02: Sensor sub-agent spend is mis-bucketed into `manual_agents`, defeating per-sensor attribution (D-08)

**File:** `src/db/usage.ts:346`
**Issue:**
The spend-attribution aggregation buckets only scheduled agents by their target name; everything else falls into a single `manual_agents` bucket:

```ts
if (r.trigger === 'scheduled' && r.target_name) {
  // per-target_name row
} else {
  // manual_agents bucket  ← sensor agents land here
}
```

Sensor agents are spawned with `trigger: 'sensor'` and `targetName: 'sensor:<slug>'` (denormalized onto usage rows at `local.ts:880-881`), so they *carry* the data needed for per-sensor attribution — which is the stated point of adding `'sensor'` to the `UsageEntry.trigger` enum (`usage.ts:23`). But this site never reads it, so sensor spend is silently merged into manual spend and the dashboard cannot show which sensor cost what (D-08 observability goal partially unmet for spend).

**Fix:** Admit sensor-triggered rows into the per-target bucket alongside scheduled:

```ts
if ((r.trigger === 'scheduled' || r.trigger === 'sensor') && r.target_name) {
  const acc = scheduledBySkill.get(r.target_name) ?? { input: 0, output: 0, cost: 0 }
  ...
}
```

(If sensor spend should be visually distinct from scheduled-task spend in the dashboard, key the bucket on a prefixed name — `sensor:<slug>` already provides that prefix — rather than co-mingling, but at minimum it must not fall into `manual_agents`.)

## Info

### IN-01: Test fixture passes a UTC `Z` instant as `currentTime`

**File:** `src/scheduler/proactive.test.ts` (`makeSensorContext`, `currentTime: '2026-06-20T09:00:00Z'`)
**Issue:** The fixture seeds `currentTime` with a UTC-suffixed instant. The production caller (`activation.ts:1121`) passes `formatIanaTimeLine(...)` (zone-local, no `Z`), so this does not violate the runtime model-time invariant — but the fixture models a value the real surface never produces, and is inconsistent with the invariant the codebase otherwise enforces.
**Fix:** Use a workspace-local string (e.g. `'Friday, June 20, 2026, 9:00 AM EDT'`) to match what `formatIanaTimeLine` actually emits, keeping test data faithful to the model-facing contract.

### IN-02: A failed `subAgentEvent` enqueue overwrites a successfully-written ambient block with a failure marker

**File:** `src/sensors/runner.ts:193` (`writeFailure` inside the `subAgentEvent` branch)
**Issue:** If `ambient` was written and/or `headEvent` enqueued successfully earlier in the same tick, a subsequent `subAgentEvent` enqueue failure calls `writeFailure(...)`, which overwrites the per-head ambient file with `⚠ Sensor failed on last run: ...`, discarding the snapshot that was just written. This is the same pre-existing pattern used by the `headEvent` branch (not introduced by this phase), and enqueue failures are rare, so impact is low — but with three independent sinks now sharing one failure marker, a late-sink failure can clobber earlier-sink success.
**Fix (optional):** Track per-tick success and only write the failure marker when no sink succeeded, or scope the failure marker so it does not overwrite a freshly-written ambient block. Acceptable to defer as a pre-existing concern.

---

_Reviewed: 2026-06-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
