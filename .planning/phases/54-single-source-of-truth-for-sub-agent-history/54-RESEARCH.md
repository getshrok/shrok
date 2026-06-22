# Phase 54: Single Source of Truth for Sub-Agent History — Research

**Researched:** 2026-06-21
**Domain:** TypeScript / Node.js / SQLite — sub-agent loop refactor (internal, no external packages)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

1. **Load history from the DB on each loop entry/wake** — restructure `loopIteration`/`runLoopFrom` so the long-lived `history` array is replaced by a transient per-`runToolLoop`-invocation buffer rebuilt from DB at the point the agent is about to run a tool-loop pass. Mirrors the head's `assembler.ts:201` `messages.getRecent(...)` pattern.

2. **`runToolLoop` is unchanged** — it keeps its transient working buffer and its round-by-round `appendMessage` persistence. The change is entirely at the sub-agent loop boundary, not inside `runToolLoop`.

3. **Collapse the two `update()` resume paths into one DB-sourced path** — unify history source to the DB. The mechanism may still differ (wake a parked poller vs. start fresh `runLoopFrom`), but neither path may read an in-memory array as truth.

4. **Retire `work_start` in favor of the `injected`-flag filter** — remove `updateWorkStart` calls (`local.ts:255`, `:502`) and the `workStart`-based slice (`local.ts:939`). Replace with a filter over `message.injected`.

5. **Anti-double-injection discipline** — with history rebuilt from DB, anything still injected fresh would double up. `resumeSuspended` must stop reconstructing the task as a fresh first turn; the persisted task message from Phase 53 is already in `state.history`.

### Claude's Discretion

- Exact `loopIteration` restructure (reload at top of `while` vs. on wake-from-`waitForInbox`).
- Whether to add a thin `assembleAgentHistory(agentId, budget)` helper or reuse `AgentStore.get(...).history` with windowing.
- How compaction (`maybeArchiveHistory`) interacts with DB-sourced reads.
- Whether `historyBudget` for sub-agents is a new config knob or reuses the head's.

### Deferred Ideas (OUT OF SCOPE)

- Resuming running agents across a process restart (terminate-on-restart stays; `index.ts:349–358` unchanged).
- Folding sub-agent storage onto the head's `messages` table (separate `agent_messages` table retained).
- User-facing version bump / CHANGELOG (decide at a coherent shipping point).
</user_constraints>

---

## Summary

Phase 54 is a pure internal refactor with no external package changes, no schema changes, and no user-visible behavior changes. It eliminates the long-lived in-memory `history` array in `src/sub-agents/local.ts`, which today acts as a second source of truth alongside the `agent_messages` DB table that Phase 53 made complete. After Phase 54 the array becomes a transient per-`runToolLoop`-invocation buffer, built from the DB on each loop entry or wake and released when the loop parks.

The primary model to converge on is the head's assembly pattern: `src/head/assembler.ts:201` calls `this.messages.getRecent(this.headId, historyBudget)` on every turn, building a fresh token-budget-windowed history from DB; the head holds zero conversation history across idle gaps. Sub-agents have idled for minutes between tool-loop passes (waiting on bash completions, suspended on a steward question, finished and awaiting a `message_agent` reply) while holding the full conversation in memory. After this phase those idle agents hold nothing.

Three surgical changes drive the entire phase: (1) replace the `history` parameter threading through `runLoop`/`runLoopFrom`/`loopIteration` with a DB load at the top of each `while(true)` iteration or equivalent wake point; (2) collapse the two `update()` resume paths (`:262–266`) to a single DB-sourced path; (3) replace the `workStart` index-based slice at `:939` with an `!m.injected` filter. A new `getHistoryWithinBudget(agentId, budget)` method is needed in `AgentStore` — no equivalent exists today.

**Primary recommendation:** load history at the top of the `loopIteration` `while(true)` loop on each pass (not only on wake), mirroring the head's per-turn assembly. Add `AgentStore.getHistoryWithinBudget(agentId, budget)` following the `MessageStore.getRecent` pattern (newest-first SQL, reverse-iterate with token accumulation, return chronological). Test all resume paths plus the anti-double-injection invariant.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Conversation history persistence | DB (`agent_messages` table) | — | Phase 53 made this the single write site |
| History assembly for a tool-loop pass | `AgentStore` (new `getHistoryWithinBudget`) | `local.ts` caller | Mirrors `MessageStore.getRecent` owned by `MessageStore` |
| Transient working buffer during `runToolLoop` | In-memory (`local.ts` array scoped to one `runToolLoop` call) | — | `runToolLoop` is unchanged; it mutates a local buffer |
| Budget windowing | New `AgentStore` method | — | Token counting already in `src/db/token.ts` via `estimateTokens` |
| Compaction | `archival.ts` + `AgentStore.compactHistory` | `local.ts` caller | Atomically replaces messages in DB; in-memory splice within one invocation still needed |
| `work_start` retirement | `local.ts` (remove calls) + `AgentStore` (method becomes dead code) | `agents.ts` (column stays for schema compat) | `injected` flag replaces index semantics |
| `update()` path unification | `local.ts` | — | Both resume paths converge on DB read |

---

## Standard Stack

This phase installs no packages. All dependencies exist. [VERIFIED: live code]

| Component | Location | Purpose |
|-----------|----------|---------|
| `node:sqlite` `DatabaseSync` | `src/db/index.ts` | Synchronous SQLite — agent_messages queries |
| `estimateTokens` | `src/db/token.ts` | Token counting for budget windowing |
| `AgentStore` | `src/db/agents.ts` | Agent state + message retrieval |
| `MessageStore.getRecent` | `src/db/messages.ts:187` | Pattern to mirror |
| `maybeArchiveHistory` | `src/sub-agents/archival.ts` | Compaction — called at `local.ts:817` |

## Package Legitimacy Audit

No external packages are installed in this phase. Omitted.

---

## Architecture Patterns

### System Architecture Diagram

```
[loopIteration while(true)]
        │
        ▼
[AgentStore.getHistoryWithinBudget(agentId, budget)]   ← NEW each pass
        │  builds chronological history from agent_messages (newest-first SQL, reversed)
        ▼
[runToolLoop(history, ...)]                            ← unchanged
        │  appendMessage → push to local buffer AND persist to agent_messages
        │  onRoundComplete → push injected msgs to local buffer AND persist
        ▼
[loop parks: suspend / inbox-wait / done]
        │  in-memory buffer dropped
        │  next wake: reload from DB
        ▼
[update() wake path]                                   ← collapses two paths to one
        │  either: emit on parked poller (was in-memory path)
        │  or: start fresh runLoopFrom (was resumeSuspended)
        │  BOTH: history source = DB, not array
```

### Recommended Restructure

The key structural change is replacing the `history` parameter passed through `runLoop` → `runLoopFrom` → `loopIteration` with a DB load inside `loopIteration`:

```typescript
// CURRENT (simplified): history threaded as a long-lived parameter
async runLoop(...) {
  const history: Message[] = []
  // ... push task, skills ...
  await runLoopFrom(..., history, ...)
}

async loopIteration(..., history: Message[], ...) {
  while (true) {
    // ... inbox poll, push inbound to history ...
    await runToolLoop(history, ...)
  }
}

// AFTER Phase 54: history rebuilt from DB on each pass
async loopIteration(...) {
  while (true) {
    // ... inbox poll, push inbound to transient local array (THEN persist) ...
    const history = await assembleAgentHistory(agentId, budget)
    await runToolLoop(history, ...)
    // history dropped here — not carried forward
  }
}
```

Source: [VERIFIED: live code] `src/sub-agents/local.ts:469–592` (runLoop), `src/sub-agents/local.ts:595–640` (runLoopFrom), `src/sub-agents/local.ts:644+` (loopIteration)

### Pattern: `getHistoryWithinBudget` — mirror of `MessageStore.getRecent`

The head's `MessageStore.getRecent` [VERIFIED: live code] `src/db/messages.ts:187–199`:

```typescript
// MessageStore.getRecent (the pattern to mirror):
getRecent(headId: string, tokenBudget: number): Message[] {
  // SQL: SELECT * FROM messages WHERE head_id = ? ORDER BY created_at DESC
  const rows = this.stmtGetRecent.all(headId)
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {          // newest-first iteration
    const msg = rowToMessage(row)
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)            // prepend → chronological output
    used += cost
  }
  return selected
}
```

The equivalent for `AgentStore` (NEW — does not currently exist [VERIFIED: live code] `src/db/agents.ts:305`):

```typescript
// To add to AgentStore:
getHistoryWithinBudget(agentId: string, tokenBudget: number): Message[] {
  // agent_messages uses rowid ASC for chronological order
  // SQL: SELECT data FROM agent_messages WHERE agent_id = ? ORDER BY rowid DESC
  const rows = this.stmtGetMessagesDesc.all(agentId) as { data: string }[]
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {          // newest-first
    const msg = JSON.parse(row.data) as Message
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)            // prepend → chronological output
    used += cost
  }
  return selected
}
```

Note: requires a new prepared statement for `ORDER BY rowid DESC` alongside the existing `stmtGetMessages` which uses `ORDER BY rowid ASC`. [VERIFIED: live code] `src/db/agents.ts:148–149`

### Pattern: `work_start` retirement — `injected` filter replacement

Current code at `local.ts:939` [VERIFIED: live code]:

```typescript
const workStart = this.agentStore.get(agentId)?.workStart ?? 0
const hasCalledTool = history.slice(workStart).some(m => m.kind === 'tool_call')
```

After Phase 54 (history is now DB-loaded, all messages tagged with `injected` where appropriate):

```typescript
const hasCalledTool = history.some(m => m.kind === 'tool_call' && !m.injected)
```

This is safe because: task message (`injected: true`, `src/sub-agents/local.ts:493`), MCP warning (`injected: true`, `:493`), skill messages (`injected: true`, `:579/:584`), `message_agent` deliveries (`injected: true`, `:692`, `:753`, `:906`), and resume answers are NOT injected (`:702` — "genuine user input — no injected flag"). Only actual tool calls made by the agent have `kind: 'tool_call'` and `!injected`.

Source: [VERIFIED: live code] `src/sub-agents/local.ts:693`, `:754`, `:903`

### Pattern: `update()` path unification

Current two paths [VERIFIED: live code] `src/sub-agents/local.ts:252–284`:

```typescript
// PATH A: completed agent restarted with new work
if (state.status === 'completed') {
  this.agentStore.resume(agentId, headId)
  this.agentStore.updateWorkStart(agentId, state.history?.length ?? 0)  // ← retire
  await this.resumeSuspended(agentId, state)                             // ← DB path
}
// PATH B: suspended agent with live emitter (in-memory path)
else if (state.status === 'suspended' && emitter) {
  emitter.emit('inbox')   // ← wakes the parked loopIteration
}
// PATH C: suspended with no emitter
else if (state.status === 'suspended') {
  await this.resumeSuspended(agentId, state)                             // ← DB path
}
```

After Phase 54: Path A still calls `resumeSuspended` (or equivalent), Path B still wakes the emitter — but neither supplies history from memory. The `updateWorkStart` call on line 255 is removed. Both ultimately load history from DB inside `loopIteration`.

### Pattern: `resumeSuspended` — stop re-injecting task

Current code [VERIFIED: live code] `src/sub-agents/local.ts:409–436` loads `state.history` from the DB (already persisted by Phase 53), passes it to `runLoopFrom`. After Phase 54, `loopIteration` loads from DB itself, so `resumeSuspended` need not pass `history` at all — or passes an empty array that is immediately replaced at the first `loopIteration` pass.

The anti-double-injection safety is already verified: Phase 53 Test C (`:2009–2054` of `agents.test.ts`) confirms that `resumeSuspended` does NOT create a second task row when history is loaded from `state.history`. After Phase 54, since `loopIteration` loads from DB, the task is read from DB (already there from spawn) and never re-pushed.

### Anti-Patterns to Avoid

- **Loading from `state.history` in `resumeSuspended`**: after Phase 54, `state.history` is the DB record already; but `resumeSuspended` should not reconstruct and re-push the task message — it would double it on the next DB reload.
- **Passing history through `runLoop`/`runLoopFrom` signatures long-term**: the in-progress approach of threading `history` as a parameter should be replaced by the load-at-iteration-top pattern. Do not keep it as a threading artifact.
- **Resetting `work_start` on resume**: line 255 `updateWorkStart(agentId, state.history?.length ?? 0)` must be removed. Under DB-sourced history this would produce a wrong index anyway since the DB has all messages, not just `state.history.length` of them.
- **Reusing `stmtGetMessages` (rowid ASC)** for budget windowing: that fetches ALL messages then you'd have to reverse-iterate. Add the DESC variant instead.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token-budget windowing | Custom token counter | `estimateTokens` from `src/db/token.ts` | Already shared by `MessageStore.getRecent` and all head assembly |
| Message deserialization | Custom JSON parse | `JSON.parse(row.data) as Message` (same as `stmtGetMessages`) | `agent_messages.data` is already serialized Message objects [VERIFIED: live code] `src/db/agents.ts:322` |
| Compaction DB write | Custom delete+insert | `AgentStore.compactHistory` | Atomic transaction; already handles the rowid-after-deletion ordering invariant |
| `injected` flag semantics | New field/column | Existing `Message.injected?: true` field | Already set on all system-injected messages by Phase 53 writers |

---

## Runtime State Inventory

Not applicable — this is a purely in-process refactor. No stored data migrations, no live service config changes, no OS-registered state, no secret/env changes, no build artifacts affected. The `agent_messages` table and `agents.work_start` column are unchanged in schema (work_start column stays; only the write/read code is removed).

---

## Common Pitfalls

### Pitfall 1: Double-injection of the task message on `resumeSuspended`
**What goes wrong:** `resumeSuspended` currently loads `state.history` (which includes the task message) and passes it to `runLoopFrom`, which calls `loopIteration`, which now loads from DB (which also has the task message) — result: task appears twice in the LLM context.
**Why it happens:** Two sources that are both complete, both including the task.
**How to avoid:** After Phase 54, the `runLoopFrom`/`loopIteration` entry point must not accept a pre-built history. The DB load happens inside `loopIteration` unconditionally. `resumeSuspended` either passes an empty array (immediately discarded) or is refactored to not pass history at all.
**Warning signs:** Test asserting a single task message in history fails; LLM sees "[Task]: X" twice.

### Pitfall 2: `onRoundComplete` mid-loop injection appearing twice on next reload
**What goes wrong:** `onRoundComplete` fires between LLM rounds inside `runToolLoop` (`:874–917`). It pushes an injected message to the in-memory `history` AND calls `persistInbound`. If `loopIteration` rebuilds from DB at the top of EVERY `while` pass including between `runToolLoop` rounds, the message would be pushed again.
**Why it happens:** `onRoundComplete` runs INSIDE `runToolLoop`, not at the `loopIteration` boundary.
**How to avoid:** The DB reload must happen at the `loopIteration` top (outer while loop), NOT inside `runToolLoop`. Since `runToolLoop` is unchanged and holds its own transient buffer, `onRoundComplete` additions are seen inside that invocation via the buffer, and on the NEXT `loopIteration` pass (after parking) they are in the DB and loaded fresh. No double-injection.
**Warning signs:** Mid-loop `message_agent` deliveries appear twice in the next-pass history.

### Pitfall 3: `work_start` index mismatches with DB message count
**What goes wrong:** `updateWorkStart(agentId, state.history?.length ?? 0)` at `:255` uses the in-memory array length, but after Phase 54 the DB has all messages — the index is meaningless and the `history.slice(workStart)` at `:939` would slice incorrectly.
**Why it happens:** The index was calibrated against the in-memory array length, which differs from total DB message count.
**How to avoid:** Remove all `updateWorkStart` calls. The `work_start` column stays in the schema but becomes inert. The `hasCalledTool` check at `:939` uses `!m.injected` filter instead of `slice(workStart)`.
**Warning signs:** Completion summary skips real tool calls made before the agent was last continued.

### Pitfall 4: Budget exceeds total token context for long-lived agents
**What goes wrong:** A long-running agent accumulates hundreds of messages. If `historyBudget` is generous (e.g., full model context), the DB-sourced load may return the same large history that was previously in memory — no improvement.
**Why it happens:** Compaction (`maybeArchiveHistory`) already handles this, but it fires on a heuristic. The budget clamps it from the other side.
**How to avoid:** `historyBudget` should mirror the head's approach: `contextWindowTokens - baseSystemTokens - outputReserve`. Reuse the head's calculation from `src/head/assembler.ts` rather than a hard-coded constant. The CONTEXT.md explicitly leaves this to Claude's discretion.
**Warning signs:** Agents with long histories load identically to before; no memory improvement observed.

### Pitfall 5: The `[Continue with your current task]` nudge double-loading
**What goes wrong:** Line ~808 of `local.ts` pushes a nudge message to `history` but does NOT call `persistInbound`. If `loopIteration` reloads from DB at the top of the while loop, the nudge would vanish from the in-memory buffer and need to be pushed again, OR it would be lost.
**Why it happens:** The nudge is framing noise, deliberately not persisted.
**How to avoid:** The nudge must be pushed to the transient `history` AFTER the DB reload at the top of each pass, not before. Verify it is pushed unconditionally before `runToolLoop` is called in the new structure.
**Warning signs:** Agent loses its "continue with task" framing after idle waits.

### Pitfall 6: Forgetting that `compactHistory` mutates BOTH DB and in-memory array
**What goes wrong:** `maybeArchiveHistory` calls `agentStore.compactHistory(...)` (DB) AND `history.splice(0, cutoff, summaryMsg)` (in-memory). After Phase 54, the in-memory splice still matters WITHIN the current `runToolLoop` invocation. On the NEXT `loopIteration` pass, the DB contains the compacted form and `getHistoryWithinBudget` returns the summary + newer messages naturally.
**Why it happens:** `maybeArchiveHistory` is called INSIDE `loopIteration` after `runToolLoop` returns (`:817`). The in-memory buffer at that point is the one `runToolLoop` used.
**How to avoid:** Keep the `history.splice(...)` call in `maybeArchiveHistory`. After compaction, the next DB reload picks up the summary. The in-memory splice ensures the current-invocation buffer is consistent if there's any code that reads it after `maybeArchiveHistory` returns.
**Warning signs:** Summary message lost between compaction and next reload; LLM sees full pre-summary history again.

---

## Code Examples

### The full `messages.getRecent` pattern (canonical source) [VERIFIED: live code]
```typescript
// src/db/messages.ts:187–199
// SQL: SELECT * FROM messages WHERE head_id = ? ORDER BY created_at DESC
getRecent(headId: string, tokenBudget: number): Message[] {
  const rows = this.stmtGetRecent.all(headId) as unknown as MessageRow[]
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {
    const msg = rowToMessage(row)
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)
    used += cost
  }
  return selected
}
```

### Current `stmtGetMessages` (existing, ASC) [VERIFIED: live code]
```typescript
// src/db/agents.ts:148–149
this.stmtGetMessages = db.prepare(
  'SELECT data FROM agent_messages WHERE agent_id = ? ORDER BY rowid ASC'
)
```
The new `getHistoryWithinBudget` needs a companion DESC statement.

### Current `injected` flag set on all system-injected messages [VERIFIED: live code]
```typescript
// src/sub-agents/local.ts:493 (MCP warning)
injected: true,
// src/sub-agents/local.ts:579 (skill tool_call)
injected: true,
// src/sub-agents/local.ts:584 (skill tool_result)
injected: true,
// src/sub-agents/local.ts:692 (message_agent update)
injected: true,
// src/sub-agents/local.ts:753 (sub-agent notice)
injected: true,
// src/sub-agents/local.ts:906 (onRoundComplete mid-loop update)
injected: true,
```
Resume answers at `:702` deliberately omit `injected` — genuine user input.

### Current `work_start` read site to replace [VERIFIED: live code]
```typescript
// src/sub-agents/local.ts:939–940 — BEFORE Phase 54
const workStart = this.agentStore.get(agentId)?.workStart ?? 0
const hasCalledTool = history.slice(workStart).some(m => m.kind === 'tool_call')

// AFTER Phase 54
const hasCalledTool = history.some(m => m.kind === 'tool_call' && !m.injected)
```

### `compactHistory` DB+memory atomicity [VERIFIED: live code]
```typescript
// src/sub-agents/archival.ts (calls both sides)
deps.agentStore.compactHistory(deps.agentId, lastCompactedId, summaryMsg)  // DB
history.splice(0, cutoff, summaryMsg)                                        // in-memory
```
Both must remain. The in-memory splice keeps the current `runToolLoop` invocation consistent; DB write ensures the next `getHistoryWithinBudget` call returns the compacted form.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| DB messages + in-memory array (two sources of truth) | DB is canonical; in-memory is transient per-invocation buffer | Phase 53 made DB complete; Phase 54 makes loop read from it | Idle agents hold zero conversation memory |
| `work_start` index to scope "own work" | `injected` flag on all system messages | Phase 53 added `injected` flag; Phase 54 retires the index | Semantically correct; no index drift |
| Two `update()` resume paths (in-memory vs DB) | Single DB-sourced path | Phase 54 | Consistent history across all wake paths |

**Deprecated/outdated by this phase:**
- `AgentStore.updateWorkStart(id, workStart)`: call sites removed; method becomes dead code (column stays for schema compat).
- Long-lived `history: Message[]` parameter threading through `runLoop` → `runLoopFrom` → `loopIteration`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `historyBudget` should mirror the head's calculation rather than a fixed constant | Architecture Patterns | If sub-agents have different model context windows than heads, a shared constant would be wrong |
| A2 | Nudge messages (`[Continue with your current task]`, `[Status check requested]`) are not persisted and should be pushed AFTER DB reload on each pass | Common Pitfalls | If nudge is omitted post-reload, agent may re-attempt tasks it was paused on |

---

## Open Questions

1. **`historyBudget` value for sub-agents**
   - What we know: head uses `contextWindowTokens - baseSystemTokens - outputReserve` from assembler; sub-agents are currently unbounded
   - What's unclear: whether sub-agents should share the same budget or use a smaller one (they have less system prompt overhead)
   - Recommendation: reuse the same config constant as the head, sourced from `config.json`; verify the assembler budget calculation is accessible from `local.ts`

2. **DB reload frequency: every `while` pass vs. only on wake**
   - What we know: the head reloads on every turn; sub-agent `loopIteration` may spin through inbox polls before each `runToolLoop` call
   - What's unclear: whether reloading on every inbox-poll pass (many times per minute during busy inbox) is needlessly expensive vs. only reloading when waking from an idle wait
   - Recommendation: reload at the point `runToolLoop` is about to be called (after inbox drain, before the LLM call) — not on every while loop pass that doesn't result in a `runToolLoop` invocation

---

## Environment Availability

SKIPPED — Phase 54 is a code/config-only refactor. No external tools, services, or runtimes beyond what is already running. TypeScript compiler and Vitest are the only tooling required; both are present in the existing workspace.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via `npx vitest`) |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npx vitest run src/sub-agents/agents.test.ts` |
| Full suite command | `npx vitest run` (6 shards on CI; run locally as single process) |

### Phase Requirements → Test Map

Phase 54 has no formal REQ-IDs in REQUIREMENTS.md (it is an internal refactor, not a user-facing feature). The CONTEXT.md specifies 7 observable behaviors that require test coverage:

| # | Behavior | Test Type | Automated Command | Exists? |
|---|----------|-----------|-------------------|---------|
| T1 | Resume-after-idle via live-emitter path: agent parks waiting for inbox, receives `message_agent`, history is DB-sourced on wake | unit | `npx vitest run src/sub-agents/agents.test.ts -t "resume.*emitter"` | ❌ Wave 0 |
| T2 | Resume-after-idle via `resumeSuspended` path: completed agent receives new task, history loaded from DB without re-injecting task | unit | `npx vitest run src/sub-agents/agents.test.ts -t "resume.*suspended"` | ❌ Wave 0 |
| T3 | Mid-loop `message_agent` delivery: `onRoundComplete` injects message; next pass loads from DB without duplication | unit | `npx vitest run src/sub-agents/agents.test.ts -t "mid-loop"` | ❌ Wave 0 |
| T4 | Compaction interaction: after `maybeArchiveHistory`, next pass loads summary + newer messages, not full history | unit | `npx vitest run src/sub-agents/agents.test.ts -t "compact"` | ❌ Wave 0 |
| T5 | Suspend→answer→continue: suspended agent receives resume answer (no `injected` flag), continues with correct history | unit | `npx vitest run src/sub-agents/agents.test.ts -t "suspend.*answer"` | ❌ Wave 0 |
| T6 | Restart-reaping regression: orphaned-agent reaping (`index.ts:349–358`) marks agents failed and does NOT attempt DB history load | unit | `npx vitest run src/sub-agents/agents.test.ts -t "restart.*reap"` | ❌ Wave 0 |
| T7 | Anti-double-injection: after `resumeSuspended`, history contains task message exactly once | unit | `npx vitest run src/sub-agents/agents.test.ts -t "double.*inject"` | ❌ Wave 0 |

**Existing Phase 53 tests (A–D, `src/sub-agents/agents.test.ts:1950–2142`) provide regression coverage:** they assert `agentStore.get(id)?.history` rows and should remain green after Phase 54 without modification.

### Test Infrastructure Pattern (from Phase 53)

The existing test helpers in `src/sub-agents/agents.test.ts` are the correct scaffolding:

```typescript
// freshDb() — in-memory SQLite with all migrations applied
// makeRunner(llmRouter, db, overrides?) — LocalAgentRunner with stub deps
// makeLLMRouter([responses]) — vi.fn router returning responses in sequence
// makeEndTurnResponse() — LLM end-turn
// makeToolCallResponse(toolName, input) — LLM tool call
// makeStewardQuestionResponse(q) — steward question
// runner.awaitAll(timeout) — drain all pending agents
```

Phase 54 tests follow the same pattern: spawn an agent, simulate inbox messages (via `runner.update(...)`), assert `agentStore.get(id)?.history` from DB, and verify no duplication.

### Sampling Rate
- **Per-task commit:** `npx vitest run src/sub-agents/agents.test.ts`
- **Per-wave merge:** `npx vitest run`
- **Phase gate:** full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/sub-agents/agents.test.ts` — new test cases T1–T7 (add after existing Phase 53 tests)
- [ ] No new test files needed; `freshDb()` / `makeRunner()` / `makeLLMRouter()` infrastructure already exists and is sufficient

---

## Security Domain

This phase makes no changes to authentication, authorization, session handling, input validation, cryptography, or any user-facing surface. It is an internal memory-management refactor. No ASVS categories apply.

---

## Sources

### Primary (HIGH confidence)
- [VERIFIED: live code] `src/sub-agents/local.ts` — full file read; all line numbers confirmed against current `main`
- [VERIFIED: live code] `src/db/agents.ts` — `AgentRow`, `updateWorkStart`, `appendMessages`, `compactHistory`, `getRecent` (agents, not messages), `stmtGetMessages`
- [VERIFIED: live code] `src/db/messages.ts:187–199` — `MessageStore.getRecent` (the pattern to mirror)
- [VERIFIED: live code] `src/head/assembler.ts:201` — `messages.getRecent(this.headId, historyBudget)`
- [VERIFIED: live code] `src/sub-agents/archival.ts` — `maybeArchiveHistory` full implementation
- [VERIFIED: live code] `src/llm/tool-loop.ts` — `appendMessage` at `:310`/`:401`, `onRoundComplete` at `:474`, `refreshHistory` at `:480`
- [VERIFIED: live code] `src/index.ts:349–358` — orphaned-agent reaping
- [VERIFIED: live code] `src/sub-agents/agents.test.ts:1950–2142` — Phase 53 test infrastructure + tests A–D
- [VERIFIED: live code] `.planning/phases/54-single-source-of-truth-for-sub-agent-history/54-CONTEXT.md` — locked decisions
- [VERIFIED: live code] `.planning/config.json` — `nyquist_validation` absent → treat as enabled

### Secondary (MEDIUM confidence)
None — this is a pure internal codebase refactor; all claims are from live code.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all existing tools confirmed in situ
- Architecture: HIGH — canonical refs read directly from live code with line numbers
- Pitfalls: HIGH — derived from reading both the current code and the Phase 53 test patterns
- Test requirements: HIGH — test infrastructure confirmed; specific test names are guidance, not prescriptive

**Research date:** 2026-06-21
**Valid until:** This research is tied to specific line numbers in `src/sub-agents/local.ts`. If `local.ts` is modified before planning, re-verify line numbers for: `update()` (~239–284), `resumeSuspended()` (~409), `runLoop()` (~469), `loopIteration()` (~644), `onRoundComplete` (~874–917), `workStart` read (~939). The patterns and pitfalls remain valid regardless.
