# Phase 54: Single Source of Truth for Sub-Agent History — Pattern Map

**Mapped:** 2026-06-21
**Files analyzed:** 3 modified files + 1 new method
**Analogs found:** 4 / 4

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/db/agents.ts` — new `getHistoryWithinBudget` method | store/service | CRUD (read with budget windowing) | `src/db/messages.ts` `getRecent` (lines 187–199) | exact |
| `src/sub-agents/local.ts` — `loopIteration` / `runLoopFrom` / `runLoop` DB-reload restructure | controller/loop | event-driven (async worker per agent) | `src/head/activation.ts` `handleEvent` (assembler.assemble → runToolLoop) | role-match |
| `src/sub-agents/local.ts` — `update()` path unification | controller | request-response (resume dispatch) | same file — both paths already present | self-analog |
| `src/sub-agents/local.ts` — `work_start` retirement / `!m.injected` filter | controller | transform (completion guard) | `src/sub-agents/local.ts:939` (existing `workStart` slice, to be replaced) | self-analog |

---

## Pattern Assignments

---

### New method: `AgentStore.getHistoryWithinBudget` in `src/db/agents.ts` (store, CRUD)

**Analog:** `src/db/messages.ts:187–199` — `MessageStore.getRecent`

**Imports pattern** (lines 1–5 of agents.ts, already in place):
```typescript
import { type DatabaseSync, type StatementSync, transaction } from './index.js'
import type { Message, TextMessage } from '../types/core.js'
import type { AgentState, AgentStatus, SpawnOptions } from '../types/agent.js'
import type { DashboardEvent, DashboardEventBus } from '../dashboard/events.js'
// ADD: import { estimateTokens } from './token.js'  ← already imported in messages.ts, mirrors that pattern
```

**Existing prepared-statement pattern** (agents.ts:144–150, ASC — the sibling to mirror with DESC):
```typescript
this.stmtInsertMessage = db.prepare(
  'INSERT INTO agent_messages (id, agent_id, data) VALUES (?, ?, ?)'
)

this.stmtGetMessages = db.prepare(
  'SELECT data FROM agent_messages WHERE agent_id = ? ORDER BY rowid ASC'
)
```
The new `getHistoryWithinBudget` requires a companion DESC statement. Add it in the constructor
alongside `stmtGetMessages`:
```typescript
this.stmtGetMessagesDesc = db.prepare(
  'SELECT data FROM agent_messages WHERE agent_id = ? ORDER BY rowid DESC'
)
```

**Core pattern to copy — `MessageStore.getRecent`** (messages.ts:187–199, verified live):
```typescript
/** Fetch most-recent messages for the given head up to tokenBudget, returned in chronological order. */
getRecent(headId: string, tokenBudget: number): Message[] {
  const rows = this.stmtGetRecent.all(headId) as unknown as MessageRow[]
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {
    const msg = rowToMessage(row)
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)        // prepend → chronological output despite DESC query
    used += cost
  }
  return selected
}
```

**New method shape for AgentStore** (substitute `agent_messages` schema differences):
```typescript
// agent_messages stores data as JSON string (not column-per-field like messages table)
// SQL: agent_messages has no created_at; rowid IS the chronological order invariant
getHistoryWithinBudget(agentId: string, tokenBudget: number): Message[] {
  const rows = this.stmtGetMessagesDesc.all(agentId) as unknown as { data: string }[]
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {          // newest-first (DESC)
    const msg = JSON.parse(row.data) as Message
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)            // prepend → chronological output
    used += cost
  }
  return selected
}
```

**Deserialization pattern** (agents.ts:296–297, used by `getByStatus`):
```typescript
const msgRows = this.stmtGetMessages.all(row.id) as unknown as { data: string }[]
const history: Message[] = msgRows.map(r => JSON.parse(r.data) as Message)
```
The new method follows the same `JSON.parse(row.data) as Message` pattern, adding
per-message token accounting in the loop.

---

### `src/sub-agents/local.ts` — DB-reload at loop entry/wake (controller, event-driven)

**Analog:** `src/head/activation.ts` — per-turn assembly at line 747 (`assembler.assemble(event)`)
returning `context.history`, then immediately passed to `runToolLoop` at line 945.

**Head's per-turn assembly pattern** (activation.ts:747 + 820–826 + 865–871, verified live):
```typescript
// 1. Assemble fresh from DB on every turn:
const context = await this.opts.assembler.assemble(event)
// context.history = this.messages.getRecent(this.headId, historyBudget)  ← assembler.ts:201

// 2. Build transient history for this invocation only (activation.ts:820–826):
const buildHistory = () => {
  const activationMessages = this.opts.messages.getSince(this.opts.headId, activationStart)
  const activationCost = estimateTokens(activationMessages)
  const priorBudget = Math.max(0, context.historyBudget - activationCost)
  const priorHistory = this.opts.messages.getRecentBefore(this.opts.headId, activationStart, priorBudget)
  return [...stripAttachmentsFromHistory(priorHistory), ...activationMessages]
}

// 3. Pass transient buffer to runToolLoop — dropped after this invocation:
const toolLoopOpts = {
  history: filteredBuildHistory(),    // ← transient, not carried across turns
  // ...
  refreshHistory: filteredBuildHistory,
}
finalResponse = await runToolLoop(this.opts.llmRouter, toolLoopOpts)
// After runToolLoop returns, history is NOT stored — next turn re-reads from DB
```

**Current `loopIteration` top-of-`while` section** (local.ts:644–654, verified live):
```typescript
private async loopIteration(
  agentId: string,
  options: SpawnOptions,
  baseToolEntries: AgentToolEntry[],
  systemPrompt: string,
  history: Message[],      // ← long-lived parameter to be removed
  emitter: EventEmitter,
  isSuspended: boolean,
): Promise<void> {
  let toolNudgeSent = false
  while (true) {
    // ... threshold block check, inbox poll ...
    await runToolLoop(this.llmRouter, {
      history,             // ← this long-lived array is what gets replaced
      refreshHistory: () => history,
      // ...
    })
  }
}
```

**Target pattern — reload at iteration top** (after Phase 54):
```typescript
// At the top of the while(true) loop, just before the runToolLoop call, replace
// `history` (the threaded parameter) with a fresh DB load:
const history = this.agentStore.getHistoryWithinBudget(agentId, historyBudget)
// Push any transient nudges AFTER the DB load (see Pitfall 5 in RESEARCH.md):
//   - '[Continue with your current task.]' nudge (local.ts:808–813)
//   - '[Status check requested...]' nudge (local.ts:773–778)
// These are NOT persisted and are pushed to the local `history` array post-reload.
// Then pass that array to runToolLoop — dropped when the loop parks.
```

**`resumeSuspended` current pattern** (local.ts:409–436, verified live):
```typescript
private async resumeSuspended(agentId: string, state: AgentState): Promise<void> {
  // ...
  const history: Message[] = [...(state.history ?? [])]  // ← loads from state.history

  const emitter = new EventEmitter()
  this.emitters.set(agentId, emitter)
  // ...
  const task = this.runLoopFrom(agentId, options, toolEntries, systemPrompt, history, emitter, true)
  // ...
}
```
After Phase 54: `history` is NOT passed from `resumeSuspended` into `runLoopFrom`/`loopIteration`.
The DB load inside `loopIteration` replaces `state.history`. `resumeSuspended` either passes an
empty `[]` (discarded) or the `history` parameter is removed from `runLoopFrom`/`loopIteration`
signatures entirely.

**`runLoop` current pattern** (local.ts:469–592, verified live — start of loop):
```typescript
private async runLoop(
  agentId: string,
  options: SpawnOptions,
  toolEntries: AgentToolEntry[],
  skill: Skill | null,
  emitter: EventEmitter,
  failedMcpCapabilities: string[] = [],
): Promise<void> {
  const systemPrompt = buildSystemPrompt(this.toolSurfaceDeps(), skill)
  const history: Message[] = []          // ← initial empty array, built up with push calls

  // Warn agent about unavailable MCP capabilities (injected: true)
  if (failedMcpCapabilities.length > 0) {
    const mcpWarnMsg: TextMessage = { ..., injected: true, ... }
    history.push(mcpWarnMsg)
    this.persistInbound(agentId, mcpWarnMsg, options)
  }

  // Record where agent's own work begins — line 502 (TO BE REMOVED in Phase 54)
  this.agentStore.updateWorkStart(agentId, history.length)

  // Inject task message as first user turn
  const taskMsg: TextMessage = { ..., content: agentFirstMessage, ... }
  history.push(taskMsg)
  this.persistInbound(agentId, taskMsg, options)

  // Skill injection (injected: true) lines 528–590
  // ...

  await this.runLoopFrom(agentId, options, toolEntries, systemPrompt, history, emitter, false)
}
```
After Phase 54: `runLoop` still pushes task + skills to `history` and calls `persistInbound` on
each (persisting them to DB). It no longer calls `updateWorkStart`. It no longer needs to thread
`history` into `runLoopFrom` — the first `loopIteration` pass will reload from DB.

---

### `src/sub-agents/local.ts` — `update()` path unification (controller, request-response)

**Current two-path pattern** (local.ts:239–272, verified live):
```typescript
async update(agentId: string, message: string, onVerbose?: ...): Promise<void> {
  if (onVerbose) this.verboseCallbacks.set(agentId, onVerbose)
  const state = this.agentStore.get(agentId)

  if (state?.status === 'completed') {
    // PATH A — completed agent restarted with new work
    this.agentStore.resume(agentId, this.headId)
    this.agentStore.updateWorkStart(agentId, state.history?.length ?? 0)  // ← RETIRE (line 255)
    this.inboxStore.write(agentId, 'signal', message)
    await this.resumeSuspended(agentId, state)
    return
  }
  if (state?.status === 'suspended') {
    this.inboxStore.write(agentId, 'signal', message)
    const emitter = this.emitters.get(agentId)
    if (emitter) {
      emitter.emit('inbox')    // PATH B — live-emitter in-memory path
    } else {
      await this.resumeSuspended(agentId, state)  // PATH C — DB path
    }
    return
  }
  this.inboxStore.write(agentId, 'update', message)
  this.emitters.get(agentId)?.emit('inbox')
}
```

**After Phase 54:** Remove `updateWorkStart` call at line 255. Both PATH B and PATH C
wake/restart the agent, which then reloads history from DB inside `loopIteration`. Neither
path passes an in-memory history array. The mechanism (emitter wake vs. `resumeSuspended`)
may still differ — only the history source changes.

---

### `src/sub-agents/local.ts` — `work_start` retirement / `!m.injected` filter (controller, transform)

**Current `workStart`-based slice** (local.ts:939–940, verified live):
```typescript
const workStart = this.agentStore.get(agentId)?.workStart ?? 0
const hasCalledTool = history.slice(workStart).some(m => m.kind === 'tool_call')
```

**`injected` flag — all system-injected message sites** (verified live, local.ts):
```typescript
// line 493 — MCP capability warning
{ ..., injected: true, ... }
// line 579 — skill tool_call message
{ ..., injected: true, ... }
// line 584 — skill tool_result message
{ ..., injected: true, ... }
// line 692 — mid-loop update injection
{ ..., injected: true, ... }
// line 753 — sub-agent notice
{ ..., injected: true, ... }
// line 906 — onRoundComplete mid-loop update
{ ..., injected: true, ... }
// line 701-708 — resume answer: NO injected flag (genuine user input)
{ kind: 'text', role: 'user', id: generateId('msg'), content: msg.payload ?? '', createdAt: now() }
```

**After Phase 54 — replacement pattern** (RESEARCH.md verified):
```typescript
// BEFORE (line 939–940):
const workStart = this.agentStore.get(agentId)?.workStart ?? 0
const hasCalledTool = history.slice(workStart).some(m => m.kind === 'tool_call')

// AFTER:
const hasCalledTool = history.some(m => m.kind === 'tool_call' && !m.injected)
```
All genuine LLM-generated tool calls have `kind: 'tool_call'` and NO `injected` flag.
All system-injected synthetic tool_call messages (skill reads) have `injected: true`.

**`updateWorkStart` write sites to remove** (verified live):
- `local.ts:502` — `this.agentStore.updateWorkStart(agentId, history.length)` inside `runLoop`
- `local.ts:255` — `this.agentStore.updateWorkStart(agentId, state.history?.length ?? 0)` inside `update()`

The `updateWorkStart` method in `AgentStore` (agents.ts:237–239) and the `work_start` column
in `AgentRow`/`rowToState` (agents.ts:19, :54) become dead code — column stays for schema
compat, callers removed.

---

## Shared Patterns

### Transient-buffer + round-by-round persistence contract

**Source:** `src/llm/tool-loop.ts`
**Apply to:** The `runToolLoop` call site in `local.ts:852–924` — this is UNCHANGED.

```typescript
// tool-loop.ts:310 — assistant turn appended to in-memory buffer AND persisted
for (const msg of assistantMsgs) await options.appendMessage(msg, { isFinal })

// tool-loop.ts:401 — tool results turn appended to in-memory buffer AND persisted
await options.appendMessage(resultsMsg)

// tool-loop.ts:473–476 — mid-loop onRoundComplete callback
if (options.onRoundComplete) {
  const shouldAbort = await options.onRoundComplete()
  if (shouldAbort) throw new AgentAbortedError()
}

// tool-loop.ts:480 — refreshHistory called AFTER onRoundComplete
history = options.refreshHistory()
```

**Key invariant:** `appendMessage` (local.ts:864–872) pushes to the local `history` array AND
calls `agentStore.appendMessages` to persist to DB in the same callback. This means by the time
`loopIteration` parks and the next pass reloads from DB, ALL messages generated in the previous
`runToolLoop` invocation are already persisted. No data loss between passes.

### `persistInbound` — the inbound persistence helper

**Source:** `src/sub-agents/local.ts:462–465`
**Apply to:** All inbound message sites — these remain unchanged in Phase 54.

```typescript
private persistInbound(agentId: string, msg: Message, options: SpawnOptions): void {
  this.agentStore.appendMessages(agentId, [msg])
  this.agentStore.emitMessageAdded(agentId, msg, options.trigger, this.headId)
}
```
Every inbound message is persisted at the push site: task (`:524`), MCP warning (`:497`),
skill messages (`:587`, `:589`), update injections (`:696`), resume answers (`:710`),
sub-agent notices (`:757`), onRoundComplete updates (`:914`). This is the Phase 53
foundation that makes Phase 54's DB reload safe.

### Compaction — dual DB+memory atomicity

**Source:** `src/sub-agents/archival.ts:86–87`
**Apply to:** The `maybeArchiveHistory` call at `local.ts:817` — unchanged.

```typescript
// archival.ts — both sides must stay:
deps.agentStore.compactHistory(deps.agentId, lastCompactedId, summaryMsg)  // DB
history.splice(0, cutoff, summaryMsg)                                        // in-memory

// compactHistory (agents.ts:335–355) is a transaction: delete all rows, re-insert summary
// then tail — preserves rowid chronological order invariant.
```
The in-memory splice keeps the current `runToolLoop` invocation consistent after compaction.
The DB write ensures the next `getHistoryWithinBudget` call returns the compacted form.

### Restart reaping — UNCHANGED

**Source:** `src/index.ts:349–358`

```typescript
// Per-head orphaned-agent reaping (lines 349–358, verified live):
const orphanedAgents = headAgents.getByStatus('running')
for (const t of orphanedAgents) {
  const pendingRetract = headSystem.stores.agentInbox.poll(t.id).some(m => m.type === 'retract')
  if (pendingRetract) { headAgents.updateStatus(t.id, 'retracted', head.id); continue }
  headAgents.fail(t.id, 'process restarted mid-execution', head.id)
  headQueue.enqueue({
    type: 'agent_failed', id: generateId('qe'), agentId: t.id,
    error: 'process restarted mid-execution', createdAt: new Date().toISOString(),
  }, 50, head.id)
}
```
Phase 54 does NOT change this. Agents are reaped (failed) on restart — not resumed from DB
history. The DB-sourced reload is a live-session refactor only.

---

## No Analog Found

No files in this phase lack a close analog. All patterns are drawn from existing in-repo code.

---

## Metadata

**Analog search scope:** `src/db/`, `src/head/`, `src/sub-agents/`, `src/llm/`, `src/index.ts`
**Files scanned:** 7 (messages.ts, agents.ts, activation.ts, assembler.ts, local.ts, archival.ts, tool-loop.ts)
**Pattern extraction date:** 2026-06-21

**Line number confidence:** HIGH — all excerpts verified against live code on `main` as of 2026-06-21.
Line numbers most likely to drift before planning if `local.ts` is modified: `update()` (~239),
`resumeSuspended` (~409), `runLoop` (~469), `loopIteration` (~644), `workStart` read (~939),
`runToolLoop` call site (~852).
