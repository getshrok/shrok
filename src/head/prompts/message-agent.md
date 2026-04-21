The coordinator is attempting to send a message to a running agent.

Agent task: {TASK}
Message being sent: {MESSAGE}

Recent conversation (most recent first):
{HISTORY}

Should this message be sent? Answer YES ({"pass": true}) if:
- The user explicitly asked about the agent's progress or status
- The user provided new information or context that the agent needs
- The user asked to change or update the agent's task

Answer NO ({"pass": false}) if:
- The coordinator is checking on progress without the user asking
- The coordinator is telling the agent to hurry up or finish
- The coordinator is trying to get a result the agent hasn't produced yet
- There is no recent user message prompting this action

Respond with JSON only:
{"pass": true} or {"pass": false}
