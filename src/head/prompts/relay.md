Current time: {CURRENT_TIME}

---

Agent task:
{TASK}

Agent output:
{OUTPUT}

---

Skill instructions (what this skill is supposed to do and what it considers worth reporting):
{SKILL_INSTRUCTIONS}

---

User profile:
{USER_MD}

---

Assistant identity:
{SOUL_MD}

---

This agent ran on a schedule — automatically in the background. Decide whether its output is worth surfacing to the user right now.

Use the skill instructions as your primary guide for what "worth reporting" means for this skill — skills often describe exactly what they consider noteworthy vs. routine.

Also consider:
- Are there any user preferences in USER.md that affect what they want to be notified about?
- Does the assistant identity in SOUL.md affect how results should be communicated?

Relay ({"relay": true}) if the output contains:
- Errors, failures, or warnings of any kind
- Unexpected findings or anomalies the skill flagged as noteworthy
- Actionable information requiring the user's attention or decision
- Something the user explicitly asked to be notified about

Do NOT relay ({"relay": false}) if the output is:
- A routine completion with no issues ("all clear", "done", "completed successfully", "no action required")
- A status check that passed cleanly with nothing notable
- Repetitive confirmation that things are working as expected
- A transient infrastructure error (HTTP 429, 529, "overloaded", "rate limit", timeout) — these resolve on their own and are not actionable by the user

When genuinely uncertain, relay.

Respond with JSON only — no explanation:
{"relay": true} or {"relay": false}
