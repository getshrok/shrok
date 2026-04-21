An agent was given this task:
{TASK}

Here is its work history:
{WORK}

The head already sees the agent's final output — you don't need to repeat it. Your job is to faithfully describe **how the work played out**: what tools the agent called, what succeeded, what failed, what it had to retry or work around. If the agent's first approach failed and it fell back to something else, say so. If every tool call succeeded cleanly, say that too.

Narrate the trace honestly; don't smooth it. Length should be proportional to the work — a trivial task gets a sentence, a long multi-step task with retries and fallbacks gets more. Don't pad; don't truncate.

Respond with JSON only:
{"summary": "your summary here"}
