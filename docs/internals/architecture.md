# Architecture

## Three kinds of model calls

Shrok isn't one big agent loop. It makes three distinct kinds of model calls, each with a different job.

### The head

The head is the model you talk to. It reads what came in, decides what to do, and keeps the conversation going. Anything that takes real work gets delegated to an agent so the chat stays responsive. Small immediate things (editing your identity files, sending a file, checking usage, managing agents) it handles directly with its own tools.

Its system prompt is assembled from the identity markdown files (every `.md` in `src/identity/defaults/`, with workspace copies overriding), plus dynamic blocks for available tools, skills, environment, and the current time. See `src/head/assembler.ts`.

When an agent finishes, the head doesn't see the raw tool trace. It sees a steward-written narration of how the work went, wrapped in an `<agent-result>` tag. See `src/head/injector.ts`.

### Sub-agents

Sub-agents do the heavy lifting. Each one gets spawned for a specific task, runs its own tool loop, and reports back.

Two things spawn them:

- **The head** calls `spawn_agent` when you ask for something (or when a steward nudges it to).
- **Scheduled tasks** spawn an agent directly when their cron fires, no head call needed, after the proactive-decision steward has approved the run.

Sub-agents can call the full tool surface (bash, file tools, notes, schedules, reminders, MCP tools, anything a skill exposes). They can send interim messages to the head mid-task, or pause with a question when they need info only you can provide. They can also spawn one level of their own children (depth-1 agents get `spawn_agent`; depth-2 and beyond never do).

Sub-agents get their own system prompt: every identity file except `SYSTEM.md` (that's head-only), plus sub-agent-specific directives from `src/identity/sub-agents/`. This is what keeps them consistent with your persona while running under different rules than the head.

### Stewards

Stewards are quiet helpers that sit between steps. Each one is a narrow, single-purpose model call with a markdown prompt template and JSON-schema-constrained output.

What stewards do: rewrite outgoing messages to remove implementation leaks before they reach you. Narrate what happened during an agent's work so the head doesn't have to ingest raw tool traces. Gate a scheduled task's output and decide whether to surface it or suppress it. Check if a reminder still makes sense. Block the head from impatiently nudging a running agent. And more.

Every steward has its own prompt file in `src/head/prompts/*.md` or `src/scheduler/prompts/*.md`. See [stewards.md](./stewards.md) for the full list.

## What happens when you send a message

1. You send a message through a channel (Discord, the dashboard, Slack, Telegram, WhatsApp, Zoho Cliq).
2. The channel adapter enqueues it as a `user_message`; the activation loop picks it up.
3. The context assembler builds a system prompt (identity + tools + skills + environment + time), retrieves relevant memories, and collects recent history within the configured budget.
4. An optional routing steward pre-analyzes the message and injects a hint.
5. The tool loop runs. The head may answer directly, use its own tools, or spawn an agent and return with a brief acknowledgment.
6. The response passes through an optional relay steward (to rewrite any agent-implementation leaks) before being sent to the channel and stored.
7. A bank of post-turn stewards (bootstrap, preference, spawn-miss, action-compliance) runs in parallel and enqueues nudge messages if any fire. The head re-activates to handle them.
8. If a sub-agent was spawned, it runs in the background. You can keep chatting while it works.
9. When the agent finishes, the work-summary steward narrates its trace and the injector attaches that narration to the head's history.
10. The head re-activates on the completion and relays the result to you.

For scheduled agent completions, there's an extra gate: the relay steward decides whether the output is worth showing at all. A clean "nothing to report" gets suppressed silently.

## What happens when a scheduled task fires

1. Cron fires. The scheduler enqueues a `schedule_trigger` for the task.
2. The proactive-decision steward reads the task instructions, your profile, recent conversation, and ambient context, and decides `run` or `skip` (with the reason logged).
3. If `run`: an agent is spawned directly with the task's instructions as its prompt. No head call is made since the target is known.
4. The agent runs, uses skills, calls tools.
5. On completion, the relay steward decides whether the output is worth surfacing.
6. If yes: the result gets injected into the head's history with a work-summary narration, and the head re-activates to relay it through your last-active channel.
7. If no: the result is logged and nothing reaches you.

The "inject and re-activate" pattern is why scheduled output feels like natural conversation rather than system notifications. By the time you see anything, the head has already framed it.

## What happens when a reminder fires

Reminders are unified with the schedule system (v1.2). A reminder is a schedule row with `kind: 'reminder'` and the reminder text stored in `agentContext`.

1. Cron fires. The scheduler enqueues a `schedule_trigger` carrying `kind: 'reminder'` and the schedule ID.
2. The activation loop's `handleScheduleTrigger` detects `kind === 'reminder'` and takes the reminder branch instead of the task branch.
3. The reminder-decision steward reads the reminder text, recent conversation, and ambient context, and decides `inject` or `skip`.
4. If `inject`: the reminder is delivered through the last-active channel.
5. If `skip`: logged, not shown.

Shorter than the task flow because there's no agent work. Reminders are just nudges.

## Memory

Memory is a separate package: [getshrok/infinite-context-window](https://github.com/getshrok/infinite-context-window), imported as `infinitecontextwindow`. `src/memory/index.ts` is a thin shim that constructs the instance and adapts Shrok's message format to what the library expects.

How it plugs in:

- When live history crosses the archival threshold, the oldest chunk is archived into topic memory and deleted from live storage. The library handles verbatim storage, summaries, and a knowledge graph.
- On every activation, the assembler retrieves topics relevant to the trigger and prepends them as a "Memory Context" block.
- For your messages, a small query-rewrite call resolves pronouns and references before retrieval so the topic index gets a clean query.

See [memory.md](./memory.md) for the internals.

## Channels

Each supported chat platform (Discord, WhatsApp, Slack, Telegram, Zoho Cliq, web dashboard) has an adapter that translates between the platform's API and Shrok's internal message format. The adapter receives incoming messages and enqueues them, sends outgoing messages back through the platform, and handles typing indicators, debug routing, and file attachments.

The head doesn't know or care which channel a message came from. Activation tracks the last-active channel and delivers outbound text there.

## Data layer

Everything local. SQLite for structured data (messages, queue events, agents, notes, usage records, steward runs, app state). Flat JSON files for schedules (`workspace/schedules/`) — reminder records are schedule rows with `kind: 'reminder'`, so they live here too. Markdown files on disk for identity and skills. The filesystem under `~/.shrok/` for the workspace.

No phone-home, no telemetry. The only network traffic Shrok generates is to model providers (for inference) and to any external services you've explicitly integrated (Discord API, Slack API, MCP servers, etc).

## Why this shape

A few design choices worth calling out:

- **The head delegates heavy work.** Anything that takes time, many tools, or careful reasoning goes to an agent. The head stays responsive for chat. Small, immediate things still happen directly.
- **Stewards everywhere.** Anywhere we wanted model judgment on a narrow question (is this worth surfacing? did the head miss something? is this answer the user's own?) we put a steward. That's why reminders can be smart, scheduled tasks can have plain-language conditions, and output surfaces only when it matters.
- **Markdown for identity.** Text files are diffable, editable, and feedable back into the system. The same files that define Shrok's personality can be edited by Shrok itself.
- **Local-first.** Self-hosted means your data stays yours. The architecture reinforces this at every layer.
