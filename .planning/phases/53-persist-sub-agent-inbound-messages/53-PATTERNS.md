# Phase 53: persist-sub-agent-inbound-messages — Pattern Map

**Mapped:** 2026-06-21
**Files analyzed:** 1 file modified (`src/sub-agents/local.ts`)
**Analogs found:** 3 / 3 (head persistence path, DB primitive, type definitions)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/sub-agents/local.ts` | service / runner | event-driven, CRUD | `src/head/activation.ts` (head persistence) | role-match (same persist-as-it-enters pattern, different table) |

Supporting read-only references (no changes):

| Reference File | Role | What It Provides |
|---|---|---|
| `src/db/agents.ts` | persistence primitive | `appendMessages` + `emitMessageAdded` — the only two calls needed |
| `src/head/activation.ts` | analog | "persist at inject, before LLM call" pattern |
| `src/head/injector.ts` | analog | `injected: true` flag convention |
| `src/types/core.ts` | types | `Message` union, `injected` field on every variant |

---

## Pattern Assignments

### `src/sub-agents/local.ts` (service, event-driven)

**Governing principle:** mirror how the head persists inbound messages — append to the DB at the moment the message enters the in-memory array, never later.

---

#### Analog A — Head inbound user append  
**Source:** `src/head/activation.ts` lines 547–564

```typescript
// Append user message to history immediately so the dashboard shows it
// before the routing steward runs (avoids the message appearing to be swallowed).
if (!this.appendedEventIds.has(event.id)) {
  this.appendedEventIds.add(event.id)
  this.opts.messages.append({
    kind: 'text',
    role: 'user',
    id: generateId('msg'),
    content: event.text,
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
    ...(event.injected ? { injected: true } : {}),
    channel: event.channel,
    createdAt: now(),
  }, this.opts.headId)
}
```

**Key rule:** the head appends *before* the LLM call, not after. Sub-agents must do the same — persist right after `history.push(...)`, before `runToolLoop` / before the loop continues.

---

#### Analog B — Head injected system-event append (the `injected: true` flag)  
**Source:** `src/head/injector.ts` lines 207–215, 222–231, 287–289, 313–315

```typescript
// agent_response (mid-task lightweight injection)
this.messages.append({
  kind: 'text',
  id: generateId('msg'),
  createdAt: now(),
  role: 'user',
  content: systemTrigger('agent-response', { agent: event.agentId }, event.response),
  injected: true,       // <-- the flag convention
} as TextMessage, this.headId)

// completed/failed — same shape, injected: true
const resultMsg: TextMessage = {
  kind: 'text',
  id: generateId('msg'),
  createdAt: now(),
  role: 'user',
  content: newContent,
  ...(agentWork ? { agentWork } : {}),
  injected: true,
}
this.messages.append(resultMsg, this.headId)

// webhook / head-message — two-message pattern (event msg + trigger msg), both injected: true
this.messages.append(eventMsg, this.headId)
this.messages.append(triggerMsg, this.headId)
```

**Key rule:** any message that the system generates (not user-typed, not LLM-generated) gets `injected: true`. The sub-agent equivalents are: MCP warning, synthetic skill reads, `message_agent` updates, resume answers, sub-agent notices.

---

#### Analog C — Head outbound assistant append  
**Source:** `src/head/activation.ts` lines 911–916

```typescript
// Store — once, in final form (with attachments if any)
if (msg.kind === 'text' && msg.role === 'assistant' && event.type === 'user_message') {
  this.opts.messages.append({ ...msg, eventId: event.id }, this.opts.headId)
} else {
  this.opts.messages.append(msg, this.opts.headId)
}
```

**Context only:** this is the outbound side that already works in sub-agents via `appendMessage` in `tool-loop.ts`. NOT a target for modification in Phase 53.

---

#### The persistence primitive  
**Source:** `src/db/agents.ts` lines 251–254 (`emitMessageAdded`), 321–326 (`appendMessages`)

```typescript
/** Emit an SSE event for a new message appended to an agent's in-progress history. */
emitMessageAdded(agentId: string, message: Message, trigger?: string, headId?: string): void {
  this.eventBus?.emit('dashboard', {
    type: 'agent_message_added',
    payload: { agentId, message, trigger: trigger ?? 'manual' },
    ...(headId !== undefined ? { headId } : {}),
  } as DashboardEvent)
}

/** Append one or more messages to an agent's history as new rows (append-only — no blob rewrite). */
appendMessages(id: string, messages: Message[]): void {
  for (const msg of messages) {
    this.stmtInsertMessage.run(msg.id, id, JSON.stringify(msg))
  }
}
// → stmtInsertMessage = 'INSERT INTO agent_messages (id, agent_id, data) VALUES (?, ?, ?)'
//   (line 144–146; ORDER BY rowid is the chronological invariant)
```

**The complete pattern for each inject point** (mirrors the existing `onRoundComplete` path at lines 873–875 and the `appendMessage` callback at lines 828–831):

```typescript
// Step 1 — already exists: push to in-memory array
history.push(msg)
// Step 2 — ADD THIS: persist to DB
this.agentStore.appendMessages(agentId, [msg])
// Step 3 — ADD THIS: fire SSE so the dashboard live-updates
this.agentStore.emitMessageAdded(agentId, msg, options.trigger, this.headId)
```

---

## Inject Points — Verified Line Numbers and Current Code

All line numbers verified against live `src/sub-agents/local.ts` (1197 lines total). CONTEXT.md approximations were accurate within ±2 lines.

### 1. MCP-unavailable warning — lines 468–476

```typescript
// current (in-memory only)
if (failedMcpCapabilities.length > 0) {
  history.push({
    kind: 'text',
    role: 'user',
    id: generateId('msg'),
    content: `[System notice: The following capabilities could not be loaded ...]`,
    injected: true,
    createdAt: now(),
  } as TextMessage)
}
// ADD after history.push: appendMessages + emitMessageAdded
```

Note: this message already carries `injected: true` — the flag is correct. Only persistence is missing.

### 2. Initial task user-message — lines 490–505

Two paths (both must persist):

**Path A** — MCP warning present, task appended to its tail (lines 490–495):
```typescript
const last = history.length > 0 ? history[history.length - 1] : null
if (last && last.kind === 'text' && last.role === 'user') {
  ;(last as TextMessage).content += `\n\n${agentFirstMessage}`   // mutates existing entry
  if (options.attachments?.length) { ... }
}
```
This mutates the already-pushed MCP warning object in-place. Since the object was persisted when pushed (after this phase), a mutation requires either re-persisting (DELETE + re-INSERT) or changing the design so the task is always a separate message. **Planning decision needed** (see Claude's Discretion in CONTEXT.md).

**Path B** — normal first message (lines 497–504):
```typescript
} else {
  history.push({
    kind: 'text',
    role: 'user',
    id: generateId('msg'),
    content: agentFirstMessage,
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    createdAt: now(),
  } satisfies TextMessage)
}
// ADD after history.push: appendMessages + emitMessageAdded
// Note: no `injected` flag — this is the genuine user-facing task, same as head's user_message
```

### 3. Synthetic skill/MEMORY reads (tool_call + tool_result pair) — lines 557–564

```typescript
// current (in-memory only)
history.push({
  kind: 'tool_call', id: generateId('msg'), createdAt: now(),
  content: '', toolCalls: toolCalls as [ToolCall, ...ToolCall[]],
} as ToolCallMessage)
history.push({
  kind: 'tool_result', id: generateId('msg'), createdAt: now(),
  toolResults: toolResults as [ToolResult, ...ToolResult[]],
} as ToolResultMessage)
// ADD after each push (or batch both at once): appendMessages + emitMessageAdded
// Per CONTEXT.md LOCKED decision: persist WITH injected:true so they appear in dashboard
```

Current objects lack `injected: true`. The LOCKED decision says to add it. The type allows it on both `ToolCallMessage` and `ToolResultMessage` (confirmed in `src/types/core.ts` lines 62, 69).

### 4a. `message_agent` update — top-of-loop — lines 658–665

```typescript
// current (in-memory only)
if (msg.type === 'update') {
  this.inboxStore.markProcessed(msg.id)
  history.push({
    kind: 'text', role: 'user',
    id: generateId('msg'),
    content: `[Message received: ${msg.payload ?? ''}]\nIf this requires a response, call respond_to_message. Otherwise, continue your current task.`,
    createdAt: now(),
  } satisfies TextMessage)
}
// ADD after history.push: appendMessages + emitMessageAdded
// Note: no `injected` flag here (unlike the onRoundComplete path below — see 4b)
```

### 4b. `message_agent` update — `onRoundComplete` — lines 862–875 (ALREADY PERSISTS)

```typescript
// current — already persists to DB (but does NOT call emitMessageAdded)
const injectedMsg: TextMessage = {
  kind: 'text', role: 'user',
  id: generateId('msg'),
  content: `[Message received: ${msg.payload ?? ''}]\nContinue your current task, addressing this update if relevant.`,
  injected: true,    // <-- already has injected flag
  createdAt: now(),
}
history.push(injectedMsg)
this.agentStore.appendMessages(agentId, [injectedMsg])  // <-- already persisted
// ADD: emitMessageAdded for live SSE
```

CONTEXT.md calls for unifying these two paths to prevent double-storage. Anti-double-storage guard: the inbox row has already been `markProcessed` by the time `onRoundComplete` runs for the same inbox item that the top-of-loop handled — the planner should verify they process different items (top-of-loop polls before the tool loop; `onRoundComplete` polls mid-loop; they are different inbox items at different times). No structural double-storage risk, but the two message content strings differ (`respond_to_message` vs `Continue your current task`) — planner must decide whether to unify the content or keep them distinct with a guard.

### 5. Resume / `signal` answer — lines 668–677

```typescript
if (msg.type === 'signal') {
  this.inboxStore.markProcessed(msg.id)
  if (isSuspended) {
    history.push({
      kind: 'text', role: 'user',
      id: generateId('msg'),
      content: msg.payload ?? '',
      createdAt: now(),
    } satisfies TextMessage)
    this.agentStore.resume(agentId, this.headId)
    isSuspended = false
  }
}
// ADD after history.push: appendMessages + emitMessageAdded
// Note: no `injected` flag — this is genuine user input (the human's answer to the question)
```

### 6. Sub-agent completion/question/failure notices — lines 695–721

```typescript
if (
  msg.type === 'sub_agent_completed' ||
  msg.type === 'sub_agent_question' ||
  msg.type === 'sub_agent_failed'
) {
  this.inboxStore.markProcessed(msg.id)
  const payload = JSON.parse(msg.payload ?? '{}') as { ... }
  let content: string
  if (msg.type === 'sub_agent_completed') {
    content = `[Sub-agent ${payload.subWorkerId} completed]\n${payload.output ?? ''}`
  } else if (msg.type === 'sub_agent_question') {
    content = `[Sub-agent ${payload.subWorkerId} is paused ...]`
  } else {
    content = `[Sub-agent ${payload.subWorkerId} failed: ${payload.error ?? 'unknown error'}]`
  }
  history.push({
    kind: 'text',
    role: 'user',
    id: generateId('msg'),
    content,
    createdAt: now(),
  } satisfies TextMessage)
}
// ADD after history.push: appendMessages + emitMessageAdded
// Per analog B: these are system-generated notices → add injected: true
```

---

## Shared Patterns

### The complete 3-step persist pattern
**Apply to:** every inject point listed above that lacks persistence.

```typescript
// After history.push(msg):
this.agentStore.appendMessages(agentId, [msg])
this.agentStore.emitMessageAdded(agentId, msg, options.trigger, this.headId)
```

The `agentId` and `options` are both in scope at every inject point. `this.headId` is the head identity string on the class instance.

### The `injected: true` flag convention
**Source:** `src/types/core.ts` lines 52, 62, 69; `src/head/injector.ts` throughout

**Apply to:** MCP warning (already has it), synthetic skill/MEMORY reads (missing — add per LOCKED decision), sub-agent completion/question/failure notices (missing — add, these are system notices), `onRoundComplete` update (already has it).

**Do NOT add to:** initial task user-message (genuine user input, same as head's `user_message`), resume/signal answer (genuine user input).

### `emitMessageAdded` — SSE live update
**Source:** `src/db/agents.ts` lines 251–254

Already called in the `appendMessage` callback at lines 831. The `onRoundComplete` path at line 875 calls `appendMessages` but NOT `emitMessageAdded` — this is a gap to fill alongside the other inject points.

---

## Excluded from Phase 53 (Deferred)

| Item | Location | Why Excluded |
|---|---|---|
| `[Continue with your current task.]` nudge | local.ts:771–777 | Framing noise, not a back-and-forth message; leave in-memory per CONTEXT.md Claude's Discretion |
| `[Status check requested...]` nudge | local.ts:737–742 | Same — transient framing, not conversation content |
| `work_start` index alignment | local.ts:481 | Deferred to Phase 54 per LOCKED decision |
| `resumeSuspended` history source change | local.ts:429 | Phase 54 |
| `assembler.ts` / head's `getRecent` read-back | assembler.ts:201 | Out of scope for Phase 53 (persistence only, not read-sourcing) |

---

## No Analog Found

None. Every target has a direct analog in the head's persistence path.

---

## Metadata

**Analog search scope:** `src/head/`, `src/db/`, `src/types/`, `src/llm/`, `src/dashboard/routes/`
**Files read:** `src/sub-agents/local.ts`, `src/head/activation.ts`, `src/head/injector.ts`, `src/head/assembler.ts`, `src/db/agents.ts`, `src/types/core.ts`, `src/llm/tool-loop.ts`, `src/dashboard/routes/agents.ts`, `sql/004_agent_messages.sql`
**Line number drift from CONTEXT.md approximations:** all inject points within ±2 lines of the stated approximations. Confirmed accurate:
- MCP warning: stated ~469–476, actual 468–476
- Initial task: stated ~497–505, actual 490–505 (two-path structure noted)
- Synthetic skill reads: stated ~557–564, actual 557–564
- `message_agent` top-of-loop: stated ~660–665, actual 658–665
- `onRoundComplete` persist: stated ~875, actual 873–875
- Resume/signal: stated ~672–677, actual 668–677
- Sub-agent notices: stated ~715–721, actual 695–721 (block starts at 695)
- Persistence callback: stated ~828–831, actual 828–831
- `resumeSuspended`: stated ~409, actual 409
