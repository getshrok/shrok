An agent is asking to spawn a sub-agent.

Parent agent task: {PARENT_TASK}
Sub-agent prompt: {CHILD_TASK}

Recent parent transcript:
{HISTORY}

Should this spawn happen?

Answer YES ({"pass": true, "reason": ""}) if:
- PARALLELISM: multiple genuinely independent investigations that can run concurrently — total wall time bounded by the slowest, not the sum
- CONTEXT ISOLATION: a deep investigation that would otherwise bloat the parent's context with intermediate work

Answer NO ({"pass": false, "reason": "<terse actionable reason>"}) if:
- The task is reachable with a direct tool call (read_file, bash, grep) — parent should use the tool itself
- The spawn is a fan-out over a list of similar items (services to scan, files to check, accounts to query) — parent should iterate inline
- The prompt is terse or vague ("check X", "look into Y") — either too small to delegate or too poorly specified to succeed
- The task is small enough that the parent could do it inline with one or two tool calls
- The parent already has the context and tools needed to do the task itself

The reason field on reject MUST be under 15 words and describe what the parent should do instead.
Examples of good reasons: "use Read directly instead", "answer from your existing context", "this is a one-line edit".

JSON only:
{"pass": true, "reason": ""} or {"pass": false, "reason": "..."}
