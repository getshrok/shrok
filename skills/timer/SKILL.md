---
name: timer
description: Set a countdown timer for a specific duration and notify the user when it elapses. Use when the user asks to "set a timer", "timer for N minutes", "ping me in N minutes", etc. For recurring alerts, far-future alerts, or anything that must survive a restart, use a reminder (create_reminder) instead.
---

A timer is a one-shot countdown: you sleep for the requested duration, then report that it's up. Because you are an async sub-agent, sleeping does **not** block the head, and it costs nothing while asleep (no tokens are spent during the sleep).

## How to run a timer

1. Convert the requested duration to whole **seconds** (`S`). Examples: "10 minutes" → 600, "90 seconds" → 90, "1h30m" → 5400.
2. Run **one** `bash` call that sleeps for `S`, and set the tool `timeout` to `(S + 10) * 1000` milliseconds — the bash default is only 30000 ms, so without this the call is killed early and the timer fires too soon:

   - command: `sleep S`
   - timeout: `(S + 10) * 1000`

   Example — a 10-minute timer → command `sleep 600`, timeout `610000`.
3. When the sleep returns (exit code 0), the time is up. Call `ring_device` with `action: "start"` and `source: "timer"` to start the audible alert on the voice device. Then finish with a short, friendly completion message, e.g. `⏰ Your 10-minute timer is up.` Include what it was for if they said one (e.g. "tea's ready"). If you are not running on a Home Assistant voice channel, ring_device is a safe no-op.

## Guidance & limits

- **Precision is to the second** — much better than scheduled reminders (which fire on a coarse interval). Ideal for kitchen-timer / "ping me in N minutes" use.
- **Does not survive a restart.** The countdown is an in-memory `sleep`; if shrok restarts, the timer is lost. For anything important, far in the future, or recurring, create a **reminder** (`create_reminder`) instead — it's persisted and supports acknowledgment/nagging.
- Rule of thumb: timers from a few seconds up to ~2 hours are the sweet spot. For longer than that, prefer a reminder.
- One `bash` call per timer — `sleep` the whole duration, don't poll in a loop.
