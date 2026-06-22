---
phase: 54-single-source-of-truth-for-sub-agent-history
plan: "02"
subsystem: db/agents
tags: [db, agents, history, budget-windowing, read-method]
dependency_graph:
  requires: [Phase 53 DB persistence layer (agent_messages table, injected flag), Phase 54 Plan 01 (T1-T7 regression tests)]
  provides: [AgentStore.getHistoryWithinBudget — DB-sourced budget-windowed history read primitive]
  affects: [src/db/agents.ts, Wave 3 loop refactor in src/sub-agents/local.ts]
tech_stack:
  added: []
  patterns: [estimateTokens budget windowing, ORDER BY rowid DESC newest-first query, unshift chronological reorder]
key_files:
  created: []
  modified:
    - src/db/agents.ts
decisions:
  - "stmtGetMessagesDesc added as a sibling prepared statement to stmtGetMessages (ASC untouched); DESC variant is required for correct budget-windowed newest-first iteration"
  - "getHistoryWithinBudget mirrors MessageStore.getRecent exactly: same accumulate+break pattern, same unshift for chronological output, same estimateTokens per-message cost"
  - "Only src/db/agents.ts modified — no schema change, no callers changed, no behavior change to any existing method"
metrics:
  duration: ~5m
  completed: "2026-06-22"
  tasks: 1
  files_modified: 1
---

# Phase 54 Plan 02: Add getHistoryWithinBudget to AgentStore — Summary

One-liner: Added `AgentStore.getHistoryWithinBudget(agentId, tokenBudget)` and companion `stmtGetMessagesDesc` (rowid DESC) to `src/db/agents.ts`, mirroring `MessageStore.getRecent` exactly — the DB-read primitive Wave 3 calls on each tool-loop pass.

## What Was Built

A single new read method on `AgentStore` in `src/db/agents.ts`:

| Addition | Description |
|----------|-------------|
| `import { estimateTokens } from './token.js'` | New import (line 5), mirrors messages.ts pattern |
| `stmtGetMessagesDesc: StatementSync` | New private field + prepare in constructor: `ORDER BY rowid DESC` |
| `getHistoryWithinBudget(agentId, tokenBudget): Message[]` | New method after `getRecent` (~line 323) |

**Method shape** (mirrors `MessageStore.getRecent` byte-for-byte with agent_messages schema differences):

```typescript
/** Fetch most-recent messages for the given agent up to tokenBudget, returned in chronological order. Mirrors MessageStore.getRecent. */
getHistoryWithinBudget(agentId: string, tokenBudget: number): Message[] {
  const rows = this.stmtGetMessagesDesc.all(agentId) as unknown as { data: string }[]
  const selected: Message[] = []
  let used = 0
  for (const row of rows) {
    const msg = JSON.parse(row.data) as Message
    const cost = estimateTokens([msg])
    if (used + cost > tokenBudget) break
    selected.unshift(msg)
    used += cost
  }
  return selected
}
```

**Key differences from `MessageStore.getRecent`:**
- Uses `JSON.parse(row.data) as Message` (agent_messages stores a JSON blob) vs `rowToMessage(row)` (messages table has per-column fields)
- Queries `agent_messages` with `agent_id = ?` vs `messages` with `head_id = ?`
- No `created_at` column — rowid IS the chronological-order invariant for agent_messages

## Behavior Contract

- **Generous budget (e.g. 1_000_000):** returns ALL of an agent's persisted messages in chronological (rowid ASC) order — identical sequence to `get(id).history`
- **Tight budget:** returns only the most-recent suffix that fits, still in chronological order (oldest-of-window first)
- **Zero / empty history:** returns `[]`
- **Output order invariant:** for any budget, the returned array is chronological (newest message is LAST), achieved via newest-first DESC query + `unshift`

## Acceptance Criteria Met

- [x] `grep -n "getHistoryWithinBudget" src/db/agents.ts` → line 323 (method)
- [x] `grep -n "ORDER BY rowid DESC" src/db/agents.ts` → line 155 (new statement)
- [x] `grep -n "estimateTokens" src/db/agents.ts` → line 5 (import) + line 329 (per-message call)
- [x] `npx tsc --noEmit` — clean
- [x] `npx vitest run src/sub-agents/agents.test.ts -t "Phase 53"` — 4 passed (regression green)
- [x] Only `src/db/agents.ts` modified

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None. The new method is a parameterized read (`agent_id = ?` bound, never string-concatenated) over data this process already owns and already reads via `get()`/`getRecent()`. No new trust boundary crossed.

## Self-Check: PASSED

Files modified:
- `src/db/agents.ts` — FOUND (21 insertions)

Commits:
- `e9cc8e6` — feat(54-02): add getHistoryWithinBudget + stmtGetMessagesDesc to AgentStore — FOUND
