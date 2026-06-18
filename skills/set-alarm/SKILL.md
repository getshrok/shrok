---
name: set-alarm
description: Set a one-time or recurring alarm that rings the Home Assistant voice device at a specific time. Survives restarts. Use instead of a timer for far-future or recurring alerts.
---

An alarm creates a persisted reminder that fires at a specific time and rings the voice device. Unlike a timer, it survives shrok restarts and supports recurring schedules.

## How to set an alarm

1. Parse the requested time to workspace-local `YYYY-MM-DD HH:MM` (24-hour, **no `Z`, no UTC offset, no timezone suffix** — `create_reminder` interprets it in the workspace timezone and rejects any input carrying an offset). Examples: "7:30am tomorrow" → `"2026-05-27 07:30"`, "next Monday at 8am" → `"2026-06-01 08:00"`.

2. For recurring alarms, derive a cron expression. The allowed cadences are: every N minutes (`*/N * * * *` with N ∈ {5,10,15,30,45,60}), hourly (`M * * * *`), daily (`M H * * *`), weekdays Mon–Fri (`M H * * 1-5`), weekly (`M H * * D`), every N days (`0 H */N * *` with N ∈ {1..7}), monthly (`M H D * *`), yearly (`M H D Mo *`). Examples: "every weekday at 7:30am" → `"30 7 * * 1-5"`, "every day at 9pm" → `"0 21 * * *"`.

3. Call `create_reminder` with:
   - `message`: `"Your alarm is going off. You MUST call ring_device with action 'start' and source 'alarm'. After calling it, briefly tell the user their alarm fired."`
   - `triggerAt`: the `YYYY-MM-DD HH:MM` time computed in step 1 (omit for cron-only recurring alarms)
   - `cron`: the cron expression from step 2 (omit for one-time alarms)

   Example for a one-time alarm at 7:30am tomorrow:
   ```
   create_reminder({
     message: "Your alarm is going off. You MUST call ring_device with action 'start' and source 'alarm'. After calling it, briefly tell the user their alarm fired.",
     triggerAt: "2026-05-27 07:30"
   })
   ```

   Example for a recurring weekday alarm at 7:30am:
   ```
   create_reminder({
     message: "Your alarm is going off. You MUST call ring_device with action 'start' and source 'alarm'. After calling it, briefly tell the user their alarm fired.",
     cron: "30 7 * * 1-5"
   })
   ```

4. Confirm to the user: tell them the alarm was set, when it will first fire, and whether it recurs.

## Important constraints

- **NEVER set `requiresAck: true`** on alarm reminders. Alarms are non-acknowledging — the continuous ring plus the 24-hour auto-dismiss cap is the entire alert mechanism.
- **NEVER set `nagMinutes`, `nagHours`, or `nagDays`**. These nag/escalation fields are for acknowledgment-required reminders only and must not be used for alarms.
- The alarm persists across shrok restarts — the reminder is stored on disk and will fire even if shrok was restarted since the alarm was set.
- If the user wants to cancel an alarm, use `cancel_reminder` with the reminder's `id` (find it via `list_reminders`). There is no `delete_reminder` or `update_reminder` tool.
