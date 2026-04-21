# Tasks and Scheduling

This is the under-the-hood companion to the tasks overview. It covers how tasks are stored, how schedules become sub-agent spawns, the two steward decision points, and how completed task output makes it back to you.

## What a "task" is (and isn't)

A **task** is a scheduled-only unit of work. Structurally it's a directory under `<workspacePath>/tasks/` (default `~/.shrok/workspace/tasks/`), loaded by a `FileSystemKindLoader` with `kind: 'task'`, `filename: 'TASK.md'`. Each task directory contains:

- `TASK.md` -- YAML frontmatter (name, description, optional `skill-deps`, optional `model`, optional `npm-deps`) plus markdown instructions.
- `MEMORY.md` (optional) -- persistent state across runs (watermarks, credentials, thresholds).
- Any scripts the task needs (optional).

A **skill** is a directory under `<workspacePath>/skills/` with `SKILL.md`. The key difference:

| | Skills | Tasks |
|---|---|---|
| Triggered by | User request or agent decision | Schedule only |
| Visible to agents | Yes (listed in agent system prompt) | No (deliberately invisible) |
| Marker file | `SKILL.md` | `TASK.md` |

## Storage

- **Task content** -- on disk at `<workspacePath>/tasks/<name>/TASK.md`.
- **Schedules** -- flat JSON files in `<workspacePath>/schedules/`, via `ScheduleStore` (`src/db/schedules.ts`). Each file has an id, target task name, cron or one-shot `runAt`, last run, next run, last skipped, and last skip reason.

Tasks and schedules both live in the workspace as portable flat files. Copy the workspace to a new install and everything comes with you.

## The scheduler tick loop

`ScheduleEvaluatorImpl` (`src/scheduler/index.ts`) runs `tick()` on a timer (default every 60 seconds):

1. Pulls all enabled schedules where `nextRun <= now`.
2. For each due schedule, enqueues a `schedule_trigger` queue event carrying the schedule ID, target name, and kind.
3. **nextRun is advanced immediately** so the tick won't double-fire. For repeating schedules, `advanceNextRun` updates the next fire time and the row stays in the store; `lastRun` is stamped later, only after the proactive steward approves the run. For one-time schedules (`runAt`, no cron), the row is **deleted from the store** immediately — there is no disabled record left behind.

Cron parsing uses `cron-parser` with the configured IANA timezone. Human-readable descriptions come from `cronstrue`.

## Handling a schedule trigger

`schedule_trigger` events are picked up by the head's activation loop, which short-circuits to `handleScheduleTrigger` (`src/head/activation.ts`) instead of running a normal head turn:

1. **Resolve target.** Load the task. If not found, drop the event with a warning (orphan schedule).
2. **Proactive decision.** The proactive steward (`runProactiveDecision` in `src/scheduler/proactive.ts`) reads the task instructions, your profile, recent conversation, and ambient context, and decides `run` or `skip` (with the reason logged). On `skip`, the schedule row records the reason and nothing else happens. On `run`, an optional context string may be returned when the steward noticed something relevant in recent conversation.
3. **Mark ran.** For repeating schedules, stamp `lastRun` on the schedule row. For one-time schedules the row was already deleted in the tick; nothing more is written.
4. **Spawn.** An agent is spawned directly with the `TASK.md` body as its prompt, optionally suffixed with the context from step 2. No head LLM call is needed since the target is known. Any `skill-deps` are resolved through the normal skill-dep mechanism. The agent gets the usual sub-agent system prompt (identity files minus `SYSTEM.md`, ambient context).

## From agent completion back to you

Scheduled task output doesn't go through the head the way a normal agent reply does:

1. The sub-agent finishes and emits an `agent_completed` event.
2. Before the head activates on it, `runRelaySteward` runs. It sees the output, the original task, the full `TASK.md` body, your `USER.md` and `SOUL.md`, and the current time. It decides relay or suppress. If suppressed, the head never sees the completion.
3. If relayed, the work-summary steward narrates the trace.
4. The head activates on the completion, composes a response, and sends it through your last-active channel.

This is why task output feels like a conversational follow-up rather than a notification. The head actually runs a turn on top of the agent's result, with full identity, memory, and routing.

## Running a task on demand

There's no "run this task now" button yet. Tasks only run when a schedule fires. To run one immediately, create a one-shot schedule with `runAt` set to the current time (via conversation or the dashboard). It still goes through the proactive steward, though a just-created one-shot is unlikely to be skipped. Once it fires, the schedule row is deleted — no disabled record accumulates.

## Plain-language conditions

Because the proactive steward sees the full `TASK.md` body every tick, skip conditions written in plain English work:

```
Check my work email and summarize anything needing a response.
Skip if it's a weekend, or if the last summary was less than 4 hours ago,
or if I'm on vacation (see USER.md).
```

The steward has access to: the prompt, `USER.md`, `AMBIENT.md`, recent conversation, and the current time. It does *not* have access to external systems, so conditions need to be things it can infer from those inputs.

## Failure modes

- **`TASK.md` missing or malformed** -- the trigger is dropped with a warning. The schedule keeps advancing but never runs.
- **Proactive steward always skips** -- usually over-restrictive prompt conditions. Skip reasons are recorded and visible on the dashboard.
- **Proactive steward fails** (LLM error) -- defaults to `run`, so a broken steward doesn't silently stop all tasks.
- **Relay steward always suppresses** -- tasks run but never surface. Inspect the relay prompt inputs.
- **Relay steward fails** -- defaults to relay (don't drop output on error).
- **Sub-agent fails or times out** -- produces an `agent_failed` event; the relay gate only applies to completions, so failures take the regular head path and you're told.

## Debugging

- **Logs** (`[scheduler]`, `[proactive]`, `[activation]`) show every tick, every steward decision, every suppression.
- **Schedules dashboard page** shows `lastRun`, `lastSkipped`, `lastSkipReason` per schedule. One-time schedules are deleted after firing, so they won't appear here after completion.
- **Steward runs** are recorded and visible in the dashboard's steward-runs view.

## Related docs

- [architecture.md](./architecture.md)
- [stewards.md](./stewards.md) -- proactive, reminder, and relay steward internals
- [developer-mode.md](../development/developer-mode.md)
