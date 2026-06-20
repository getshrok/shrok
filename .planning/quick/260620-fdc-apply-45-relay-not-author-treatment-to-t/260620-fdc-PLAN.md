---
phase: quick-260620-fdc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/head/index.ts
  - src/identity/defaults/SYSTEM.md
  - src/sub-agents/agents.test.ts
requirements:
  - "issue-45-message_agent"
autonomous: true

must_haves:
  truths:
    - "message_agent's `context` param is required and is what gets delivered verbatim to the agent"
    - "message_agent's `message` param survives as the human-facing label/intent, judged by the stewards but never delivered to the agent"
    - "running, completed, and paused/suspended agents all receive the verbatim `context` uniformly (no per-state special-casing)"
    - "the head's stewards (runResumeSteward, runMessageAgentSteward) judge `context`, not `message`"
    - "tsc and the affected vitest files pass"
  artifacts:
    - path: "src/head/index.ts"
      provides: "message_agent tool def (context+message params) + dispatch handler delivering context, judging context in stewards"
    - path: "src/identity/defaults/SYSTEM.md"
      provides: "message_agent guidance reworded to relay-not-author framing"
    - path: "src/sub-agents/agents.test.ts"
      provides: "regression test locking context-delivered / message-not-delivered across all three states"
  key_links:
    - from: "src/head/index.ts message_agent dispatch"
      to: "AgentRunner.update"
      via: "delivers wrapped `context`, not `message`"
      pattern: "agentRunner\\.update\\(agentId, .*context"
---

<objective>
Apply the #45 "relay, not author" treatment to the `message_agent` head tool, mirroring commit `b6cada7` which did the same for `spawn_agent`.

Today `message_agent` has a single `message` param (empty description, src/head/index.ts:110) delivered verbatim to the agent. The head can over-author it. Add a required `context` param (the verbatim conversation turns, what's actually delivered) and reframe `message` as a short intent label that survives for stewards/logs but is NOT shown to the agent — uniformly across running, completed, and paused/suspended agents.

Purpose: structurally prevent the head from steering a continued/resumed agent with restated, over-specified instructions; the agent works from the verbatim conversation only.
Output: updated tool surface + dispatch + steward inputs + SYSTEM.md guidance + a regression test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./AGENTS.md

Reference commit (the template to mirror — analogous treatment for spawn_agent):
- `git show b6cada7` — dropped head's `task` from agent prompt, made `context` required, reworded params + SYSTEM.md, added a regression test.

<interfaces>
<!-- All extracted from the codebase; executor needs no further exploration. -->

`AgentRunner.update` (src/types/agent.ts:130) — keep this signature unchanged:
```typescript
update(agentId: string, message: string, onVerbose?: (msg: string) => Promise<void>): Promise<void>
```
The `message` PARAM NAME on the interface stays (it's the delivered-string slot); the DISPATCH caller passes the wrapped `context` into it. Only ONE implementer: `LocalAgentRunner.update` (src/sub-agents/local.ts:247) — it writes the string verbatim to the inbox as `'update'`/`'signal'` payload; the inbox-injection sites (local.ts:720-728, 730-744, 902-938) add their own `[Message received: …]` framing on top. No change to local.ts is required — it already delivers whatever string it's handed verbatim and uniformly across all three states.

Other internal `update` caller (sub-agent → child, local.ts:1142) — passes `input['message']` for nested message_agent; that surface is sub-agent-side (NOT the head tool) and is OUT OF SCOPE. Leave it untouched.

`message_agent` tool def today (src/head/index.ts:103-114):
```typescript
{
  name: 'message_agent',
  description: 'Send a message to an agent … running, paused, and completed …',
  inputSchema: { type: 'object',
    properties: { agentId: { type: 'string' }, message: { type: 'string' } },
    required: ['agentId', 'message'] },
}
```

Dispatch handler (src/head/index.ts:354-427): reads `message`, runs `runMessageAgentSteward(task, message, …)` for completed+running and `runResumeSteward(question, message, …)` for suspended, then `await this.opts.agentRunner.update(agentId, message, this.opts.onVerbose)`.

Steward signatures (src/head/steward.ts) — keep unchanged; only the ARGUMENT passed changes:
```typescript
runResumeSteward(question, answer, recentHistory, router, model, …)        // :445
runMessageAgentSteward(task, message, recentHistory, router, model, …)     // :475
```

Existing regression test to mirror — `git show b6cada7` added `describe('head-spawn first message — task is not shown to the agent (issue #45)')` in src/sub-agents/agents.test.ts. Also note the existing inbox-payload assertion pattern at agents.test.ts:757-776 (`inboxStore.poll(agentId)` → `updateMsg.payload`), which is the simplest way to assert what string was delivered.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add `context` param + deliver it; judge `context` in stewards; reword SYSTEM.md</name>
  <files>src/head/index.ts, src/identity/defaults/SYSTEM.md</files>
  <behavior>
    - message_agent inputSchema gains `context` (required) and keeps `agentId` + `message`; `required` becomes `['agentId', 'context']` (message stays optional-but-present as a label). Mirror spawn_agent's reworded param descriptions: `context` = "the verbatim conversation turns that prompted this follow-up — what the agent actually works from, paste VERBATIM, REQUIRED"; `message` = "a short hint/label of your intent, not a script; the agent works from `context`, not this".
    - Dispatch reads BOTH: `message` (label, fed to stewards + kept human-facing) and `context` (what's delivered). All three steward branches (completed, suspended, running) now pass `context` as the judged argument: `runMessageAgentSteward(task, context, …)` and `runResumeSteward(question, context, …)` — `context` is what the agent receives, so it's what determines whether a real answer / non-impatient check-in was provided. The label `message` is NOT judged.
    - Delivery is UNIFORM across all three states (no paused special-case): build ONE wrapper string `Here's the latest from the conversation — continue your work based on it:\n"""\n${context}\n"""` and pass it as the delivered string to `agentRunner.update(agentId, wrapped, this.opts.onVerbose)`. `message` is never part of the delivered string.
    - `message` never reaches the agent; `context` (verbatim, inside the wrapper) does.
  </behavior>
  <action>In src/head/index.ts, update the static `message_agent` definition (lines 103-114): add a `context` string property with the relay-not-author description, fill the empty `message` description as a short-intent-label/hint (mirroring how `buildHeadSpawnAgentDef`'s `task` was reworded in b6cada7 — frame it so the head still behaves naturally without revealing the drop), and set `required: ['agentId', 'context']`. In the `case 'message_agent'` dispatch (lines 354-427): read `const context = input['context'] as string` alongside the existing `message`. In each of the three steward call branches, replace the `message` argument with `context` (completed branch ~line 372-376, suspended branch ~line 391-395, running branch ~line 409-413) — leave the `task`/`question` first arg and all other args unchanged. Replace the delivery at line 425 with a wrapped context: build `const delivered = \`Here's the latest from the conversation — continue your work based on it:\\n"""\\n${context}\\n"""\`` and call `await this.opts.agentRunner.update(agentId, delivered, this.opts.onVerbose)`. Do NOT touch local.ts, the AgentRunner interface signature, the steward.ts signatures, or the sub-agent-side message_agent at local.ts:1136-1144. In src/identity/defaults/SYSTEM.md, reword the message_agent guidance (the paragraphs at lines 15 and 19 about continuing completed agents and resuming paused agents) to the relay-not-author framing: paste the verbatim conversation/user-reply as what the agent works from, rather than restating it — mirror the tone of the spawn_agent rewording b6cada7 applied earlier in the same file.</action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx tsc --noEmit</automated>
  </verify>
  <done>tsc clean. message_agent has required `context` + reframed `message`; dispatch delivers wrapped `context` and feeds `context` (not `message`) to both stewards across all three states; SYSTEM.md reworded.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Regression test — context delivered, message never delivered, uniform across states</name>
  <files>src/sub-agents/agents.test.ts</files>
  <behavior>
    - Test via the head dispatch path (HeadToolExecutor) OR by asserting on `inboxStore.poll(agentId).payload` after a `message_agent` dispatch, mirroring the existing pattern at agents.test.ts:757-776. Whichever is most natural given the test fixtures already in the file.
    - (a) The string delivered to the agent (inbox payload / first injected continuation message) CONTAINS the verbatim `context` and the delivery wrapper text.
    - (b) The delivered string does NOT contain a distinct `message` marker (use a sentinel like `PRESCRIBED_MESSAGE_marker` for `message` and a separate verbatim phrase for `context`).
    - (c) All THREE states behave uniformly: running, completed, and suspended/paused agents all deliver the verbatim `context` and drop the `message`. Drive each state (mirror the suspended-state poll-until pattern at agents.test.ts:740-755 and the completed-agent continuation setup elsewhere in the file) and assert the same (a)+(b) invariant for each.
  </behavior>
  <action>Add a new `describe('message_agent — context is delivered, message is not (issue #45 parity)')` block near the end of src/sub-agents/agents.test.ts, mirroring the structure of the b6cada7 head-spawn test (`git show b6cada7` for the exact shape — `captureCalls`/`firstUserText` helpers or the inbox-poll assertion). Construct a HeadToolExecutor (or reuse whatever head-dispatch fixture exists in the file; if none, assert through `runner` + `inboxStore.poll` per the line 757-776 pattern after manually invoking the dispatch). For each of running / completed / suspended: set up an agent in that state, dispatch a `message_agent` with `message: 'PRESCRIBED_MESSAGE_marker'` and `context: 'Ashley: yes go ahead, the window seat one under $300'`, then assert the delivered string contains `continue your work based on it` and `window seat one under $300` and does NOT contain `PRESCRIBED_MESSAGE_marker`. Keep stewards disabled (or stubbed to pass) in the fixture so delivery actually happens.</action>
  <verify>
    <automated>cd /home/thenasty/shrok && npx vitest run src/sub-agents/agents.test.ts</automated>
  </verify>
  <done>New test block passes; locks (a) context delivered, (b) message not delivered, (c) uniform across running/completed/suspended. Full agents.test.ts suite green.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| head LLM → message_agent tool call | head-authored params; the whole point of #45 is that head over-authoring must not steer the agent |
| dispatch → AgentRunner.update → agent inbox | the delivered string becomes the agent's continuation input |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-fdc-01 | Tampering | head over-authors `message` to steer a continued agent | mitigate | structural: `message` is dropped from the delivered string entirely; only verbatim `context` reaches the agent (this plan's core change) |
| T-fdc-02 | Information disclosure | none — no new external surface, no secrets, in-process only | accept | behavioral tool-surface change; no new I/O, no deps |
| T-fdc-SC | Tampering | npm/pip/cargo installs | accept | no package installs in this plan |
</threat_model>

<verification>
- `npx tsc --noEmit` clean.
- `npx vitest run src/sub-agents/agents.test.ts` green (incl. new block + the existing update-inbox test).
- Spot-check src/head/steward.ts: both stewards now receive `context` from the dispatch (grep the dispatch for `context` args). The steward FUNCTION signatures are unchanged.
- No edits to src/sub-agents/local.ts, src/types/agent.ts, or the sub-agent-side message_agent (local.ts:1136-1144).
</verification>

<success_criteria>
- message_agent: `context` required + delivered verbatim (wrapped); `message` reframed as label, judged by stewards, never delivered.
- Uniform behavior across running / completed / suspended.
- SYSTEM.md message_agent guidance reworded to relay-not-author.
- Regression test locks the three invariants.
- tsc + affected vitest pass. All commits straight to `main` (no branch, no PR, never `git add dashboard/dist/`).
</success_criteria>

<output>
Create `.planning/quick/260620-fdc-apply-45-relay-not-author-treatment-to-t/260620-fdc-01-SUMMARY.md` when done.
</output>
