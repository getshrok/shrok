Current time: {CURRENT_TIME}

---

A sensor has detected something and is requesting a sub-agent to act on it.

Sensor: {SLUG}
Task: {SENSOR_PROMPT}

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

You are deciding whether this sensor-triggered task should run right now.
The sensor has already deterministically decided something happened — this is
a refinement, not a first-line filter. Default to running.

Run ({"action": "run"}) if:
- The task makes sense given the user's current context
- When uncertain, prefer to run

Skip ({"action": "skip"}) only if:
- The user is explicitly unavailable and the task would be disruptive
- The same work was clearly done moments ago

Optionally include "context" with any conversation detail directly relevant
to the task. Omit if nothing stands out.

Respond with JSON only:
{"action": "run", "reason": "...", "context": "..."} or {"action": "skip", "reason": "..."}
