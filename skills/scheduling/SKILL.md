---
name: scheduling
description: How Shrok schedules work — creating, updating, and managing schedules that trigger tasks.
---

## What schedules are

Schedules are separate from tasks. A task defines **what to do**; a schedule defines **when to do it** and optionally **under what conditions** or **with what extra context**.

A task can have multiple schedules (e.g., an intake scan that runs hourly on weekdays and every 4 hours on weekends).

## Schedule fields

| Field | Description |
|-------|-------------|
| `taskName` | The task to run (must already exist). Required. |
| `cron` | Cron expression for recurring schedules (e.g., `0 * * * *` for hourly). |
| `runAt` | ISO datetime for a one-time schedule. Either `cron` or `runAt` is required. |
| `conditions` | Plain-language rules evaluated by the scheduler before running. The scheduler will skip the run if conditions aren't met. |
| `agentContext` | Extra text appended to the task agent's prompt when this schedule fires. |

## conditions

`conditions` is shown to the scheduler steward — a lightweight decision-maker that runs before spawning the task agent. Write it as a plain-language rule:

- `"Only run between 9 AM and 5 PM local time"`
- `"Skip on weekends"`
- `"Only run on weekdays between 7 AM and 9 PM local time"`
- `"Skip if it's a holiday"`

**Time windows belong in `conditions`, not in the task prompt.** Tasks should describe what to do, not when to do it.

## agentContext

`agentContext` is injected into the task agent's prompt alongside the task instructions. Use it for schedule-specific overrides that the task itself shouldn't bake in:

- `"User is traveling this week — only flag urgent items"`
- `"End of quarter — run a full deep scan instead of incremental"`

## Tools

- `list_schedules` — list all schedules
- `create_schedule` — create a schedule for an existing task
- `update_schedule` — modify `cron`, `runAt`, `enabled`, `conditions`, or `agentContext`
- `delete_schedule` — remove a schedule by ID

## Watermarks

Tasks that process feeds (email, messages, tickets) use a watermark in their `MEMORY.md` to avoid reprocessing the same items twice. Store the last-checked time as a local timestamp with timezone offset — **not UTC/Z format**:

```
last_checked: 2026-04-21T07:00:00-04:00
```

Why local time with offset: using a bare Z-suffix UTC timestamp (e.g., `2026-04-21T07:00:00Z`) risks a 4-hour error if the agent reads the system clock as local time but appends Z. Including the offset (like `-04:00` for Eastern Daylight Time) makes the timestamp unambiguous regardless of how the agent formats it.

When reading the watermark back, pass it directly to `--since`; the scripts handle ISO strings with offsets correctly.

Update the watermark after each service is checked, not at the end of the full scan — so a partial run still advances the position for services that completed.
