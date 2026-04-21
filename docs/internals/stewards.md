# Stewards

Stewards are the non-main-flow model calls that shape how Shrok behaves between steps. They don't do the main work and they don't talk to you directly. They're filters, rewriters, and decision-makers that run quietly in the seams.

## How stewards work in general

Every steward:

- Has its own markdown prompt file in `src/head/prompts/` (or `src/scheduler/prompts/` for the two scheduling stewards), with `{UPPERCASE_PLACEHOLDER}` slots filled in at call time. In developer mode, these can be edited from the dashboard's Identity page — edits go to a workspace overlay (`~/.shrok/workspace/stewards/` or `~/.shrok/workspace/proactive/`) and override the defaults without modifying the source tree.
- Fires at a specific point in activation, a tool call, or a scheduled event.
- Returns JSON constrained by a schema (a boolean, a classification, a rewritten string, or a short reason).
- Runs on the steward model tier (`config.stewardModel`), not the head model. Smaller, cheaper, faster.

Most stewards fail open: if something goes wrong, they let things through rather than blocking the flow.

A subset of stewards have user-facing toggles registered in `src/head/steward-registry.ts`, which surface in the dashboard's Settings > Stewards tab.

## All the stewards

There are twelve stewards in `src/head/steward.ts`, plus the routing steward in the same file and two scheduling stewards in `src/scheduler/proactive.ts`. Grouped by when they fire:

### After the head responds (post-activation compliance bank)

Four stewards run in parallel after the head's response is delivered. Each one either returns a nudge (a synthetic user message that re-activates the head) or nothing. Only `bootstrapSteward` is enabled by default today; the others are scaffolded and currently commented out of the default set.

#### `preferenceSteward` — preference capture

- **Prompt:** `preference.md`
- **Fires when:** the head did NOT call `write_identity` this turn.
- **Checks:** did you state a fact or preference about yourself (for `USER.md`) or give a tone/naming directive (for `SOUL.md`) that wasn't saved?
- **If it fires:** nudges the head to call `write_identity` silently.

#### `spawnSteward` — missed spawn commitment

- **Prompt:** `spawn.md`
- **Fires when:** the head did NOT call `spawn_agent`, `message_agent`, or `cancel_agent` this turn.
- **Checks:** did the head say it would do something ("I'll do X now") without actually spawning an agent?
- **If it fires:** nudges the head to spawn.

#### `actionComplianceSteward` — missed-spawn + hallucination + from-memory computation

- **Prompt:** `action-compliance.md`
- **Fires when:** no agent-management tool was called this turn.
- **Checks three things:** (1) missed spawn commitment, (2) stated current real-world facts (scores, prices, news) not sourced from an agent result, (3) produced an exact computed answer for a task that needs code.
- **If it fires:** one priority-ranked nudge (missed > hallucinated > computed) telling the head to spawn an agent. Overlaps with `spawnSteward` by design; both have separate toggles.

#### `bootstrapSteward` — onboarding completion

- **Prompt:** `bootstrap.md`
- **Skips early if:** `BOOTSTRAP.md` is already empty or `write_identity` was called this turn.
- **Checks:** is the head wrapping up onboarding without having written `USER.md`/`SOUL.md` and cleared `BOOTSTRAP.md`?
- **If it fires:** nudges with an explicit three-call recipe (write `USER.md`, write `SOUL.md`, empty `BOOTSTRAP.md`).

### Before injecting scheduled agent results

#### `runRelaySteward` — relay or suppress

- **Prompt:** `relay.md`
- **Fires when:** a scheduled-trigger agent completes and the relay steward is enabled. User-spawned agents skip this gate.
- **Decides:** should the result be shown to you? Surfaces errors, anomalies, actionable info. Suppresses routine "all clear" completions and transient infra errors. If uncertain, it relays.
- **If suppressed:** the head never sees the completion.

### Before injecting any agent completion

#### `runWorkSummarySteward` — narrate the work trace

- **Prompt:** `work-summary.md`
- **Fires when:** any agent completes and is about to be injected into the head's history.
- **Input:** the agent's work messages, formatted and capped to keep cost down. Failure lines (non-zero exits, stack traces, timeouts) are preserved first so the narration covers retries and fallbacks honestly.
- **Output:** a proportional narration of how the work went. The head already has the agent's final answer, so this covers the *how*, not the *what*.
- **If it fails:** the injector uses a stub like `(work summary unavailable — N tool calls elided)`.

### Sub-agent lifecycle

#### `runCompletionSteward` — done or question

- **Prompt:** `agent-completion.md`
- **Fires when:** an agent's tool loop ends without a terminal tool call.
- **Decides:** is the agent done, or does it need user input? Optional follow-up offers count as done. Called from `src/sub-agents/local.ts`.

#### `runSpawnAgentSteward` — gate depth-1 spawns

- **Prompt:** `spawn-agent.md`
- **Fires when:** a depth-1 agent calls `spawn_agent` and the spawn-agent steward is enabled.
- **Checks:** is the child task genuinely worth delegating, or could the parent handle it directly?
- **If rejected:** returns a short reason that surfaces to the parent as a tool error. Fails open.

### Outgoing messages

#### `runHeadRelaySteward` — rewrite agent leaks before delivery

- **Prompt:** `head-relay.md`
- **Fires when:** the head emits text and the relay steward is enabled. Runs before the message reaches you or gets stored.
- **Checks:** does the message reference "agent", "sub-agent", "spawning", "delegating" as internal implementation?
- **If it fires:** returns a minimally rewritten version using first-person phrasing, preserving everything else. Explicit questions about internals are left alone.

### Agent-management gates (head-side)

#### `runMessageAgentSteward` — block impatient check-ins

- **Prompt:** `message-agent.md`
- **Fires when:** the head calls `message_agent` on a running or completed agent.
- **Checks:** are you actually asking about progress or giving new context, or is this a silent head-initiated check-in?
- **If rejected:** the `message_agent` call is blocked. Fails open.

#### `runResumeSteward` — validate answers to suspended agents

- **Prompt:** `resume.md`
- **Fires when:** the head calls `message_agent` on a *suspended* agent (answering its question).
- **Checks:** does the answer actually come from your recent messages, or did the head fabricate it? Workflow directives ("just proceed", "skip it") count as legitimate.
- **If rejected:** resume is blocked and the head asks you. Fails open.

### Write-path filter

#### `runIdentityFilterSteward` — keep USER.md clean

- **Prompt:** `identity-filter.md`
- **Fires when:** the head writes to `USER.md` via `write_identity`.
- **Checks:** does the content include skill-specific rules, credentials, or integration behavior that belongs in a skill's `MEMORY.md` instead?
- **If it fires:** splits the content into what to keep and what to remove. The keep side is written; the rest is discarded. Fails open.

### Pre-activation routing

#### `runRoutingSteward` — suggest the right approach

- **Prompt:** `routing.md`
- **Fires when:** a user message arrives, the routing steward is enabled (off by default), and the message is long enough and not a greeting.
- **Checks:** six prioritized routes (continue recent agent work, service integration, long-term tracking, user preference, saving info, time-based reminder, recurring task).
- **If it fires:** the hint is injected as a nudge before the head runs.

### Scheduling stewards (in `src/scheduler/proactive.ts`)

These are logically stewards, but they live next to the scheduler because they gate cron fires rather than activation turns.

#### `runProactiveDecision` — run or skip the scheduled task

- **Prompt:** `src/scheduler/prompts/tasks.md`
- **Fires when:** a `schedule_trigger` is dequeued.
- **Decides:** given the task instructions, cron, last run, your profile, ambient context, and recent conversation, should it run now? Defaults to run. Skips only on clear signals (you're on vacation, same task just completed).
- **If skipped:** the reason is recorded; no agent spawns.
- **If run:** can return an optional context string that gets appended to the agent's prompt when recent conversation has something directly relevant.

#### `runReminderDecision` — inject or skip the reminder

- **Prompt:** `src/scheduler/prompts/reminder.md`
- **Fires when:** a `schedule_trigger` with `kind: 'reminder'` is handled. Reminders are unified with the schedule system (v1.2) — there is no separate `reminder_trigger` event type.
- **Decides:** has the reminded task already been handled in recent conversation, or been explicitly cancelled? Defaults to inject.
- **If skipped:** logged, not shown.

## Adding a new steward

1. Add the prompt file under `src/head/prompts/` (or `src/scheduler/prompts/`) with `{UPPERCASE}` placeholders.
2. Implement it in `src/head/steward.ts` using `stewardComplete(...)` with a `jsonSchema` constraint.
3. Add a config flag in `src/config.ts` and gate the call site.
4. Register a descriptor in `src/head/steward-registry.ts` and mirror it in `dashboard/src/pages/settings/stewards-registry.ts` so the UI picks it up.
5. Wire it into the right flow (post-activation bank, pre-injection, tool-call gate, etc).
6. Add it to this doc.

## Debugging a steward

- Prompt files live at the paths listed above. Check that placeholders are intact.
- The debug channel (developer mode) echoes `[steward-name] ...` lines when stewards run or fire.
- The `steward_runs` table records which stewards ran and fired per activation for the dashboard's run-history view.
- `src/head/steward.test.ts` and the eval framework cover regression testing.

## Related docs

- [identity-files.md](./identity-files.md) -- the identity markdown files stewards read and write
- [architecture.md](./architecture.md) -- how stewards fit into the overall flow
- [developer-mode.md](../development/developer-mode.md) -- logs, debug streams, and evals for debugging
