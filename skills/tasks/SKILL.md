---
name: tasks
description: How Shrok tasks work — structure, scheduling, and best practices. Read this when creating, editing, or reasoning about tasks.
---

## What tasks are

Tasks are things the assistant runs on a schedule without user prompting. Unlike skills (which agents use on demand), tasks fire on a timer and run silently in the background — the user is only notified when the task produces something worth reporting.

Common examples: inbox monitoring, daily briefings, news alerts, system health checks, report generation.

## Structure

A task is a directory in `$SHROK_TASKS_DIR` with:
- `TASK.md` — frontmatter (YAML) + instructions (markdown). Same format as skills, different filename.
- `MEMORY.md` — persistent state: credentials, watermarks, configuration.
- Scripts (optional) — same conventions as skills.

Use `$SHROK_TASKS_DIR` in all paths. Resolve it via `bash` before using in file tools.

## Frontmatter

```yaml
---
name: my-task
description: What the task checks and when it should surface results.
skill-deps:
  - system-stats
  - email
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Task name (kebab-case) |
| `description` | yes | What the task does — shown to the scheduler when deciding whether to run or skip |
| `skill-deps` | no | Skills whose SKILL.md + MEMORY.md get auto-loaded into the task agent's context when it runs |

## Scheduling

Tasks are scheduled through the dashboard Schedules page. A schedule can be:
- **Recurring** — cron expression or interval (e.g., "every 30 min", "daily at 9am")
- **One-time** — fires once at a specific time, then never again

A task can have multiple schedules (e.g., a news monitor that runs hourly on weekdays but twice daily on weekends).

## The bundled-skills pattern

Most tasks are orchestrators — they wire together one or more skills to perform a routine task. Rather than duplicating how those skills work, list them under `skill-deps` and the task agent automatically gets their instructions and state on spawn.

This keeps the task's TASK.md focused on what only the task knows: **when to run, what matters, and what to report** — not how to use each underlying tool.

Example task (`system-monitor`) with `skill-deps: [system-stats]`:

```markdown
---
name: system-monitor
description: Checks the host machine's resource usage and flags issues.
skill-deps:
  - system-stats
---

## When to check

ONLY BOTHER CHECKING IF IT IS BETWEEN THE HOURS OF 11AM and 9PM UTC.
EITHER CHECK BECAUSE IT IS WITHIN THE WINDOW OR SKIP CHECKING,
DO NOT HEDGE OR ASK IF YOU SHOULD CHECK.

## What to report

DON'T WARN ABOUT MEMORY USAGE UNLESS 90% OR ABOVE.
```

That's the whole task. The agent knows how to use `system-stats` because its instructions are auto-included. The task only contains the decision rules the skill doesn't have.

## Writing task instructions

Good task instructions answer three questions:
1. **When to run** — time windows, preconditions, skip conditions
2. **What matters** — thresholds and criteria for "worth reporting"
3. **What to report** — format and tone when there is something to say

Use ALL CAPS and assertive phrasing for hard rules the agent must not hedge on. Tasks run unattended; ambiguity leads to the agent asking questions into a void or wasting tokens second-guessing itself.

## Output behavior

Tasks run as background agents. Their output goes through a relay steward that decides whether the result is worth surfacing to the user. Write instructions so that "nothing to report" is a valid outcome — the relay steward will suppress empty or uneventful results automatically.

If a task should always notify (e.g., a daily briefing), say so explicitly.

## MEMORY.md patterns

Same conventions as skills:

- **Watermarks** — For tasks that process a feed, store `lastChecked: <ISO timestamp>` instead of item ID lists. Prevents unbounded growth.
- **Thresholds and state** — Store the current threshold and last known value.
- **Credentials** — API keys, resolved user IDs. Though for tasks using `skill-deps`, credentials usually live in the dep skill's MEMORY.md, not the task's.

## Differences from skills

| | Skills | Tasks |
|---|---|---|
| **Triggered by** | User request or agent decision | Schedule (recurring or one-time) |
| **Visible to agents** | Yes — included in system prompts | No — never shown to agents |
| **Output** | Direct response to user | Filtered through relay steward |
| **Directory** | `$SHROK_SKILLS_DIR` | `$SHROK_TASKS_DIR` |
| **Marker file** | `SKILL.md` | `TASK.md` |
