---
name: tasks
description: How Shrok tasks work — structure, scheduling, and best practices. Read this when creating, editing, or reasoning about tasks.
---

## What tasks are

Tasks are saved prompts that can be run in the future (on demand, recurring, or one-time).

Common examples: inbox monitoring, daily briefings, news alerts, system health checks, report generation.

## Structure

A task is a directory in `$SHROK_TASKS_DIR` with:
- `TASK.md` — frontmatter (YAML) + instructions (markdown). Same format as skills, different filename.
- `MEMORY.md` — persistent **non-secret, instance-specific** state: watermarks, thresholds, configuration. **Secrets do NOT go here** — see the `skills` skill's Credentials section; a task's own secrets (if any) belong in a `.<service>-credentials.json` store, not MEMORY.md.
- Scripts (optional) — same conventions as skills.

Use `$SHROK_TASKS_DIR` in all paths. Resolve it via `bash` before using in file tools.

## Frontmatter

```yaml
---
name: my-task
description: What the task does.
model: smart   # optional, task-only — worker tier for scheduled runs
skill-deps:
  - system-stats
  - email
---
```

Same fields as a skill (`name`, `description`, `skill-deps`, `mcp-capabilities`, `npm-deps`, `max-per-month-usd`) plus one that's **task-only**:

- `model` — the worker tier a scheduled run of this task uses (e.g. `dumb`/`smart`/`genius`, mapped to the configured model IDs). This is the field that distinguishes a task from a skill; it is parsed but ignored on a plain skill.

## Scheduling

Tasks can be scheduled through the dashboard Schedules page or by using the create_schedule tool. A schedule can be:
- **Recurring** — cron expression or interval (e.g., "every 30 min", "daily at 9am")
- **One-time** — fires once at a specific time, then never again

A task can have multiple schedules (e.g., a news monitor that runs hourly on weekdays but twice daily on weekends).

A schedule references its task by **name** (the schedule's `taskName` field), not by a stable ID. Two consequences:
- **Renaming a task cascades** — every schedule pointing at the old name is updated automatically.
- **Deleting a task does NOT delete its schedules** — they're left orphaned (they'll fail to find the task at fire time). Clean up or repoint a task's schedules before deleting it.

## The bundled-skills pattern

Most tasks are orchestrators — they wire together one or more skills to perform a routine task. Rather than duplicating how those skills work, list them under `skill-deps` and the task agent automatically gets them loaded from the start.

This keeps the task's TASK.md focused on what only the task knows: **what matters, and what to report** — not how to use each underlying tool.

Example task (`system-monitor`) with `skill-deps: [system-stats]`:

```markdown
---
name: system-monitor
description: Checks the host machine's resource usage and flags issues.
skill-deps:
  - system-stats
---

## What to report

DON'T WARN ABOUT MEMORY USAGE UNLESS 90% OR ABOVE.
```

That's the whole task. The agent knows how to use `system-stats` because its instructions are auto-included. The task only contains the decision rules the skill doesn't have. Time windows and run conditions belong on the **schedule**, not in the task — see the `scheduling` skill.

## Writing task instructions

Good task instructions answer two questions:
1. **What matters** — thresholds and criteria for "worth reporting"
2. **What to report** — if scheduled, not everything done or found while executing a task is worth reporting to the user

Time windows and skip conditions belong on the schedule's `conditions` field, not in the task — see the `scheduling` skill.

## MEMORY.md patterns

Same conventions as skills:

- **Watermarks** — For tasks that process a feed, store a last-checked timestamp instead of item ID lists. See the `scheduling` skill for the correct format. Prevents unbounded growth. Timestamps follow **config.timezone** (the dashboard setting) via the `TZ` env var propagated at startup — do not hardcode or assume the host OS zone.
- **Thresholds and state** — Store the current threshold and last known value.
- **Instance data only, no secrets** — non-secret config and resolved IDs are fine; API keys/tokens are not. For tasks using `skill-deps`, credentials live in the dep skill's credential store (`.<service>-credentials.json`), and the task selects an account with `--account <alias>` — it never handles the secret itself.