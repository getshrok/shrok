Current time: {CURRENT_TIME}

---

A reminder is about to be surfaced to the user:
"{REMINDER_MESSAGE}"

Frequency: {SCHEDULE}

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

You are deciding whether this reminder should be surfaced to the user right now.

Inject ({"action": "inject"}) if:
- The reminder is still relevant
- The thing it's reminding about hasn't already been handled
- When uncertain, prefer to inject

Skip ({"action": "skip"}) only if:
- Recent conversation clearly shows the reminded task was already completed
- The user explicitly cancelled or dismissed the underlying need

Always provide a brief reason.

Respond with JSON only:
{"action": "inject", "reason": "..."} or {"action": "skip", "reason": "..."}
