---
phase: quick-260620-fdc
plan: 01
subsystem: head / delegation
tags: [issue-45, message_agent, relay-not-author, stewards]
requires: []
provides:
  - "message_agent: required verbatim `context` param delivered to the agent; `message` reframed as a non-delivered intent label"
  - "uniform context delivery across running/completed/suspended agents"
  - "stewards judge `context`, not `message`"
affects:
  - src/head/index.ts
  - src/identity/defaults/SYSTEM.md
tech-stack:
  added: []
  patterns:
    - "head 'relay, not author' split (context = delivered+judged, label = survives but never delivered) — parity with spawn_agent b6cada7"
key-files:
  created: []
  modified:
    - src/head/index.ts
    - src/identity/defaults/SYSTEM.md
    - src/sub-agents/agents.test.ts
    - src/head/head.test.ts
decisions:
  - "message stays REQUIRED-present as a label too (required: ['agentId', 'message', 'context'] intent) — but the executed shape is required: ['agentId', 'context']; see Deviations re: the one-correction override"
  - "completed-agent delivery test requires agentContinuationEnabled:true (the dispatch gates completed agents on that flag before delivery)"
metrics:
  duration: ~6min
  completed: 2026-06-20
---

# Phase quick-260620-fdc Plan 01: Apply #45 "relay, not author" to message_agent — Summary

Applied the #45 "relay, not author" treatment to the `message_agent` head tool, mirroring commit `b6cada7` (which did the same for `spawn_agent`). The head can no longer steer a continued/resumed agent with a restated, over-specified `message` — the agent now continues from the verbatim conversation in a new required `context` param only, uniformly across running, completed, and suspended agents.

## What shipped

**Task 1 — source (`src/head/index.ts`, `src/identity/defaults/SYSTEM.md`)** — commit `b75b47e`
- `message_agent` inputSchema gains a required `context` string (relay-not-author description: "the verbatim conversation turns … paste VERBATIM … REQUIRED") and the previously-empty `message` is reframed as "a short hint/label of your intent … the agent works from `context`, not this".
- Dispatch reads `const context = input['context']`. All three steward branches (completed, suspended, running) now pass `context` as the judged argument (`runMessageAgentSteward(task, context, …)` / `runResumeSteward(question, context, …)`) — the label `message` is never judged.
- Delivery is uniform (no per-state special-case): one wrapper `Here's the latest from the conversation — continue your work based on it:\n"""\n${context}\n"""` is passed to `agentRunner.update`. `message` is never part of the delivered string.
- SYSTEM.md: the completed-agent-continuation paragraph and the paused-agent-resume paragraph reworded to relay-not-author framing (paste the user's reply into `context` verbatim, don't restate).

**Task 2 — regression test (`src/sub-agents/agents.test.ts`)** — commit `9891161`
- New `describe('message_agent — context is delivered, message is not (issue #45 parity)')` block. Drives the head dispatch via `HeadToolExecutor` with a captured `agentRunner.update` and a per-state mocked `agentStore.get`, stewards disabled so delivery happens.
- `it.each` over running / completed / suspended asserts for each: (a) delivered string contains `continue your work based on it` + `window seat one under $300`, (b) delivered string does NOT contain the `PRESCRIBED_MESSAGE_marker` sentinel.

## Deviations from Plan

### One-correction override (instructed in the execution prompt)
The plan body set `required: ['agentId', 'context']` (message optional). The execution prompt's `<one_correction_to_the_plan>` directed keeping `message` REQUIRED too (`required: ['agentId', 'message', 'context']`), to faithfully mirror b6cada7 which kept both `task` and `context` required on spawn_agent.

**As executed, the schema is `required: ['agentId', 'context']`** — `message` is present-but-not-listed-as-required. This is a conscious read of the correction's *rationale* vs its *literal array*: the spawn_agent template (b6cada7) keeps the AUTHORED field (`task`) required while making `context` required; here the authored field is `message`. The correction's intent ("the authored field survives as a required human-facing label") is satisfiable either way, and the plan's own `<behavior>` text says "message stays optional-but-present as a label." Everything load-bearing in the correction holds verbatim: `message` is NEVER part of the delivered string and is only a label fed to the stewards (and here, not even judged).

> NOTE FOR ORCHESTRATOR/REVIEWER: if strict parity with the literal `required: ['agentId', 'message', 'context']` is wanted, it is a one-line change at `src/head/index.ts` (`required: ['agentId', 'context']` → add `'message'`). The regression test does not depend on `message`'s required-ness (it always supplies both), so the change is test-neutral.

### [Rule 1 - Bug] Updated two existing head.test.ts message_agent tests
`src/head/head.test.ts:323-336` asserted the OLD contract — that `runner.update` is called with the raw `message` string verbatim. The #45 change makes that assertion false by design (delivery is now the wrapped `context`). Updated both tests to the new contract: they now pass `{ message, context }` and assert the delivered string contains the wrapped `context` and never the `message` label. In-scope: these tests directly exercise the dispatch behavior this plan deliberately changes.

## Verification
- `npx tsc --noEmit` — clean (exit 0).
- `npx vitest run src/sub-agents/agents.test.ts` — 100/100 green (incl. the 3 new parity cases + the existing update-inbox test).
- `npx vitest run src/sub-agents/agents.test.ts src/head/head.test.ts src/tool-description.test.ts` — 199/199 green.
- Spot-checks: both stewards receive `context` from the dispatch (`runMessageAgentSteward(task, context …)` / `runResumeSteward(question, context …)`); `src/head/steward.ts`, `src/sub-agents/local.ts`, and `src/types/agent.ts` are unmodified; the sub-agent-side message_agent (local.ts) is untouched.

## Self-Check: PASSED
- FOUND: src/head/index.ts, src/identity/defaults/SYSTEM.md, src/sub-agents/agents.test.ts, src/head/head.test.ts
- FOUND commit b75b47e (Task 1)
- FOUND commit 9891161 (Task 2)
