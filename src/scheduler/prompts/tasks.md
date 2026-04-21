Current time: {CURRENT_TIME}

---

Scheduled task "{SKILL_NAME}" is due to run.
Description: {SKILL_DESCRIPTION}
Frequency: {SCHEDULE}
Last ran: {LAST_RUN}

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

You are deciding whether this scheduled task should run right now. Scheduled tasks run silently in the background — they do not interrupt or notify the user unless they find something worth reporting. The user's current activity (busy, in meetings, at lunch) is not a reason to skip.

Run ({"action": "run"}) if:
- The task is relevant given the current context
- There is no reason to skip it
- When uncertain, prefer to run

Skip ({"action": "skip"}) only if:
- The user is unavailable for an extended period and has indicated they don't need this (e.g., on vacation, out of office for days)
- The same task was completed very recently — within the last scheduled interval or less (e.g., a task that runs every 2 hours was manually done 30 minutes ago)

When running, optionally include a "context" field — but only if the conversation contains something directly relevant to what this task does. The task agent already has ambient context (AMBIENT.md) in its system prompt, so don't repeat that. This field is for conversation-specific details the task wouldn't otherwise know. Omit the context field entirely if nothing stands out.

Always provide a brief reason.

Respond with JSON only:
{"action": "run", "reason": "...", "context": "..."} or {"action": "skip", "reason": "..."}
