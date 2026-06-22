---
phase: 53-persist-sub-agent-inbound-messages
reviewed: 2026-06-21T22:30:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - src/sub-agents/local.ts
  - src/sub-agents/agents.test.ts
  - CHANGELOG.md
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 53: Code Review Report

**Reviewed:** 2026-06-21T22:30:00Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Phase 53 adds a `persistInbound(agentId, msg, options)` helper and wires it into six
inbound inject points in `LocalAgentRunner` (initial task, MCP-unavailable warning,
synthetic SKILL.md/MEMORY.md reads, top-of-loop `message_agent` updates, signal/resume
answers, and sub-agent completion/question/failure notices), plus the previously-existing
mid-loop `onRoundComplete` update site. It also removes the old "append the task in place
onto the trailing MCP-warning message" mutation in favor of always pushing the task as its
own row, and unifies the two `message_agent` injection paths through the shared helper.

I traced every changed code path against correctness, idempotency, and persistence
invariants and verified them dynamically:

- **No double-persistence.** The `agent_messages` PRIMARY KEY is `(agent_id, id)`, so a
  duplicate insert with the same message id would throw. Every `persistInbound` call uses a
  freshly `generateId('msg')`-ed message. The resume/continuation path (`resumeSuspended`)
  rebuilds `history` from already-persisted DB rows and runs `runLoopFrom` directly (NOT
  `runLoop`), so it never re-persists the task or synthetic skill reads. Verified by Test C.
- **Single-claim idempotency holds.** `inboxStore.poll` filters `processed_at IS NULL`, and
  both the top-of-loop and `onRoundComplete` sites `markProcessed` the moment they handle an
  `update` row, so exactly one site persists it. Verified by Test B.
- **Archival is unaffected** — it goes through the transactional `compactHistory`
  (delete-all-then-reinsert keyed on existing rows), which is consistent with the new
  inbound rows.
- **The new `injected:true` flag on the synthetic skill reads does NOT change what the agent
  LLM sees** — the agent-side tool loop (`src/llm/tool-loop.ts`) does not filter on
  `injected`; the flag only matters for head-side context-relevance and dashboard rendering.

The whole test file (`agents.test.ts`, 104 tests including the 4 new Phase 53 tests A–D)
passes, and `npx tsc --noEmit` is clean. The CHANGELOG entry is correctly placed under
`[next]`, is user-facing, and references no internal planning artifacts.

No Critical issues. Two Warnings (CI test reliability, a guard asymmetry worth documenting)
and three low-priority Info items.

## Warnings

### WR-01: Test B is timing-dependent and can produce 0 rows under CI load

**File:** `src/sub-agents/agents.test.ts:1986-2022`
**Issue:** Test B drives the two-site idempotency check with fixed wall-clock delays: the
LLM mock sleeps 60 ms per call, the test waits 90 ms, then calls `runner.update(...)`. The
assertion (`updateRows` has length exactly 1) is robust to *which* site claims the row, but
it is NOT robust to the update arriving **after the agent has already auto-completed**. The
agent's path is: round 1 (`bash`, ~60 ms) → end_turn → auto-complete. If the 90 ms wait plus
scheduler jitter on a loaded CI runner lets the agent reach a terminal state before the
update is delivered, no site claims the row, `updateRows.length === 0`, and the test fails
spuriously. The other six CI shards already run heavy workloads in parallel, so this window
is realistic.
**Fix:** Make the agent stay alive deterministically until after the update is observed
rather than relying on sleep timing — e.g. gate the agent's progression on a signal the test
controls. A minimal version: have the LLM mock for round 2 block on a promise the test
resolves only after `runner.update(...)` returns, so the agent cannot complete before the
update lands:
```ts
let releaseRound2: () => void
const round2Gate = new Promise<void>(r => { releaseRound2 = r })
const llmRouter: LLMRouter = {
  complete: vi.fn().mockImplementation(async () => {
    llmCallNum++
    if (llmCallNum === 1) return makeToolCallResponse('bash', { command: 'echo r1' })
    await round2Gate            // hold the agent open until the update is delivered
    return makeEndTurnResponse()
  }),
}
// ...
await runner.update(agentId, 'Phase53-update-payload')
releaseRound2!()
```
This keeps the "exactly once regardless of which site" guarantee under test while removing
the race that can yield zero rows.

### WR-02: Retract-guard asymmetry between the two `update` persist sites

**File:** `src/sub-agents/local.ts:683-697` (top-of-loop) vs `891-915` (`onRoundComplete`)
**Issue:** The `onRoundComplete` site deliberately checks for a pending `retract` first and,
if found, skips injecting/persisting any `update` in the same batch (comment at lines
888-898 — to avoid persisting a message the run is about to abandon). The top-of-loop site
has no such guard: it iterates the polled inbox in `created_at` order, and if an `update`
row sorts before a `retract` row in the same poll, it `markProcessed`+`persistInbound`s the
update and only then hits the `retract` branch and `return`s. The result is that a
top-of-loop update concurrent with a retract IS persisted (and emits an SSE event) for a run
that is immediately retracted, whereas the same race in `onRoundComplete` is not. This is not
a correctness bug — the message was genuinely received, the row is well-formed, and it is not
a "ghost" (it exists in DB) — but the two sites that the phase explicitly set out to unify
now behave differently for the retract-races-update case, which undercuts the unification goal
and could surprise a future maintainer reading the `onRoundComplete` comment as the
authoritative contract.
**Fix:** Either (a) add the same retract-first check to the top-of-loop poll (compute
`const hasRetract = inbox.some(m => m.type === 'retract')` before the for-loop and skip the
`update` persist when set), or (b) add a one-line comment at the top-of-loop `update` branch
documenting that, unlike `onRoundComplete`, a top-of-loop update preceding a retract is
intentionally persisted because it was already fully received. Option (a) makes the two
sites genuinely symmetric.

## Info

### IN-01: Synthetic skill reads now emit SSE and (rarely) reach the xray stream

**File:** `src/sub-agents/local.ts:587,589` (and `persistInbound` → `emitMessageAdded` at 464)
**Issue:** The synthetic SKILL.md/MEMORY.md `read_file` tool_call/tool_result pair now fires
`agent_message_added` SSE events. The dashboard SSE handler pushes `tool_call`/`tool_result`
messages into the xray stream when `trigger` is absent or `'manual'`
(`dashboard` bundle handler: `(!l || l === "manual") && (kind === tool_call || tool_result)`).
For a `manual`-triggered skill spawn the synthetic "read_file → SKILL.md" reads would now
surface as xray tool activity in the channel, which they never did before. In the normal flow
this is moot — head-spawned `manual` agents are ad-hoc and carry no `skillName` (verified in
`src/head/index.ts:351-364`), so the skill-injection branch doesn't run for them; skill
agents are spawned by scheduled tasks/sensors with non-`manual` triggers (whose `agentVerbose`
is `undefined` and whose SSE xray push is gated out). So this only manifests for an
eval/test/nested caller that spawns a skill agent with `trigger:'manual'`.
**Fix:** No change required for correctness. If the rare manual-skill-spawn xray noise is
undesirable, consider leaving the synthetic skill reads off the SSE xray path (they are
boilerplate context, not agent "work"); this would mean emitting the DB row without the
xray-eligible SSE, or having the dashboard suppress `injected:true` tool messages from xray.

### IN-02: SSE `agent_message_added` for inbound rows can double-append on a mid-run reload

**File:** `src/db/agents.ts:252-254` (emitter) consumed by the dashboard SSE handler
**Issue:** The dashboard `agent_message_added` handler unconditionally appends the incoming
message to the `["agent-history", agentId]` query cache (no dedup by message id). Now that
inbound rows (task, updates, notices, skill reads) also emit this event, a dashboard that
backfills an in-progress agent's history (which already contains these persisted rows) and
then receives the same row via a live SSE event could render it twice. This is a pre-existing
class of behavior — assistant/tool messages from the `appendMessage` callback already emitted
this exact event and were already subject to the same backfill-vs-live race — so Phase 53
does not introduce a *new* mechanism, only more message kinds that travel it.
**Fix:** Out of scope for this phase (frontend). If double-render is ever observed, add an
id-based dedup in the SSE `agent_message_added` handler
(`if (o.history.some(m => m.id === s.id)) return o`).

### IN-03: Pre-existing dead variable `tcIds`

**File:** `src/sub-agents/local.ts:530,536`
**Issue:** `const tcIds: string[] = []` is written (`tcIds.push(skillTcId)`) but never read.
This is pre-existing (present at the diff base) and not introduced by Phase 53, so it is
strictly out of scope — flagged only for completeness.
**Fix:** Delete the `tcIds` declaration and its lone `push` if a future touch lands in this
block.

---

_Reviewed: 2026-06-21T22:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
