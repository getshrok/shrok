An agent is paused and waiting for information from the user.

The agent asked:
{QUESTION}

The coordinator is attempting to resume the agent with this answer:
{ANSWER}

Recent conversation (most recent first):
{HISTORY}

Did the user actually provide this information? Check the recent conversation:

Answer YES ({"pass": true}) if:
- The answer reflects information the user provided in the recent conversation — credentials, decisions, data, confirmations, or explicit instructions (including "skip it" or "just proceed" if the user actually said that).
- The user told the coordinator to reuse or pass along information from earlier in the conversation (e.g. "do you still have it?", "yeah give it the key", "use the one I gave you before"). The coordinator legitimately has information from earlier turns.
- The coordinator is giving a task management directive — telling the agent to proceed, finish, skip a step, change approach, retry, or re-check something. The coordinator manages its own workflow and does not need user permission to direct an agent. Examples: "No, just finish the task", "Output the list and stop", "Skip that and move on", "Re-read the skill and try again", "Check the instructions again and proceed as they say", "The user updated X, please re-read it".

Answer NO ({"pass": false}) if:
- There is no recent user message containing this information
- The coordinator fabricated, paraphrased beyond recognition, or embellished what the user said
- The answer is a stalling message ("please wait", "hold on") not sourced from the user
- The coordinator is telling the agent to proceed without the information on its own initiative

Respond with JSON only:
{"pass": true} or {"pass": false}
