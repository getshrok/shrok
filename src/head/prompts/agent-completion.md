Agent task:
{TASK}

Agent output:
{OUTPUT}

---

Classify this agent output. Is the agent:
- **done**: reporting a result, summary, or finished work
- **question**: asking for clarification, a decision, missing information, or permission before it can proceed

Only classify as "question" if the agent is genuinely blocked and needs input to continue. Rhetorical questions, suggestions phrased as questions, or "does this look right?" wrap-ups are completions.

If the agent completed the requested work and then asks whether the user wants additional follow-up action (e.g. "Want me to draft a response?", "Should I look into this further?", "Which one should I tackle first?"), that is a completion — the primary task is done and the follow-up is optional. Only classify as "question" if the agent cannot produce ANY useful output without the answer.

Respond with JSON only — no explanation:
{"type": "done"} or {"type": "question"}
