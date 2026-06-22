# Phase 54: Single source of truth for sub-agent history — Context

**Gathered:** 2026-06-21
**Status:** Ready for planning
**Source:** Design Session (interactive — investigated against live code + the running DB)

<domain>
## Phase Boundary

Eliminate the **long-lived in-memory `history` array** as a second source of truth for sub-agents, collapsing them onto the head's model where the **DB is canonical**. Phase 53 made the DB a complete record (every inbound + outbound message persisted at inject time); Phase 54 makes the running loop *read from* that record instead of carrying conversation state in memory across idle gaps.

**Why now / why it's clean.** Today the sub-agent loop builds an in-memory `history` array, mutates it across the agent's whole lifetime (including idle waits — bash calls, suspended-on-question, finished-and-awaiting-`message_agent`), passes it to `runToolLoop`, and only mirrors the generated subset to the DB. After Phase 53 every message is already in the DB, so the array no longer needs to *be* the truth — it can become a **transient per-`runToolLoop`-invocation buffer**, rebuilt from the DB on each entry/wake and dropped when the loop parks. This is exactly the head's shape: the head re-assembles from the DB each turn (`src/head/assembler.ts:201` → `messages.getRecent`) and only holds an in-memory buffer *during* a single `runToolLoop` execution.

**The divergence this fixes.** `update()` currently has two resume paths that read different history: the live-emitter in-memory path (`src/sub-agents/local.ts:262–264`) and the DB path (`resumeSuspended`, `:266` → `:409`, loads `state.history`). Unifying the history *source* to the DB collapses them — both paths see the same, complete conversation.

**Performance is a non-issue and memory improves.** Reads are synchronous local SQLite at loop-entry/wake (not per round); the head already does this on every single turn. Windowing (`getRecent`/`historyBudget`) and compaction (`maybeArchiveHistory`, summary messages) already bound long histories on both sides. Idle agents — which routinely sit for minutes — end up holding zero conversation in memory, just a parked poller.

**Restart behavior unchanged.** Running agents are still reaped on boot (`src/index.ts:349–358`), not resumed. This phase is not about crash-resume; it's about a single source of truth for the live loop.
</domain>

<decisions>
## Implementation Decisions

### Load history from the DB on each loop entry/wake (LOCKED approach)
Restructure `loopIteration`/`runLoopFrom` (`src/sub-agents/local.ts`) so that instead of threading a long-lived `history` array through suspend/wait/continue, it **loads history from the DB** (mirroring the head's `assembler.ts:201` `messages.getRecent(...)` with `historyBudget` windowing) at the point it's about to run a tool-loop pass, and **drops the array** when the loop parks (suspend / inbox wait). The in-memory array becomes a transient buffer scoped to one `runToolLoop` invocation.

### `runToolLoop` is unchanged
It keeps its transient working buffer and its round-by-round `appendMessage` persistence (`src/llm/tool-loop.ts:310/401`). The head holds an in-memory buffer mid-loop too — that's correct and stays. The change is entirely at the sub-agent loop boundary, not inside `runToolLoop`.

### Collapse the two `update()` resume paths into one DB-sourced path (LOCKED)
Unify the *history source* to the DB. The mechanism may still differ (wake a parked poller via emitter vs. start a fresh `runLoopFrom`), but neither path may read an in-memory array as truth — both reload from the DB. Simplify `update()` (`:239–272`) accordingly.

### Retire the `work_start` index in favor of the `injected`-flag filter (LOCKED)
`work_start` (the index marking where a continued agent's "own work" begins, used to scope completion summaries) is already out of step with the persisted array and becomes redundant once history is DB-sourced with `injected` flags. Replace its role with a filter over `injected` (and/or message role/kind). Identify every reader/writer of `work_start` (`updateWorkStart` at `local.ts:481`, `:255`; the completion-summary path; any slice-by-index) and migrate them. This is the deferred half of the Phase 53 `work_start` decision.

### Anti-double-injection discipline (the core correctness rule)
With history rebuilt from the DB, anything still injected fresh would double up. So inbound messages must be persisted (Phase 53) and then *only read from the DB* — never injected-fresh AND loaded. In particular `resumeSuspended` must stop reconstructing the task as a fresh first turn from the `agents.task` column (the persisted task message from Phase 53 is now in `state.history`); keep the column as metadata only. Mid-loop `message_agent` injection (`onRoundComplete`) still mutates the transient buffer *and* persists within the same invocation — verify it doesn't re-appear on the next reload.

### Claude's Discretion
- Exact `loopIteration` restructure (e.g., reload at top of the `while` vs. on wake-from-`waitForInbox`), and how the transient buffer is handed to `runToolLoop`.
- Whether to add a thin `assembleAgentHistory(agentId, budget)` helper analogous to the head's assembler, or reuse `AgentStore.get(...).history` with windowing.
- How compaction (`maybeArchiveHistory`) interacts with DB-sourced reads (the head already persists summary messages; follow that — a reload should pick up the compacted form).
- Whether `historyBudget` for sub-agents is a new config knob or reuses the head's.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The model to converge on (head)
- `src/head/assembler.ts` — `:201` `messages.getRecent(headId, historyBudget)`: DB-sourced context assembly per turn. The target pattern.
- `src/head/activation.ts` — how the head loops per queue event (assemble → `runToolLoop` → respond), holding only a transient buffer.

### What changes (sub-agent loop)
- `src/sub-agents/local.ts` — `loopIteration` (~619), `runLoopFrom` (~570), `runLoop` (~450), `resumeSuspended` (~409), `update()` (~239–272). `work_start`: `updateWorkStart` (`:481`, `:255`). Inbox/idle wait (`waitForInbox`, suspend handling ~725–729). The `runToolLoop` call site (~816) and its `refreshHistory`/`onRoundComplete` options (~837–882).
- `src/llm/tool-loop.ts` — unchanged, but read it to confirm the transient-buffer + `appendMessage` contract the refactor relies on.
- `src/db/agents.ts` — `AgentStore.get` (history read), `appendMessages` (`:322`), and any `getRecent`-equivalent (add one if absent, mirroring the head's message store).
- `src/index.ts` — `:349–358` orphaned-agent reaping (restart behavior — must remain unchanged).

### Depends on
- **Phase 53** (`.planning/phases/53-persist-sub-agent-inbound-messages/53-CONTEXT.md`) — its persistence is the prerequisite; without complete inbound persistence, a DB-rebuilt history would lose messages.
</canonical_refs>

<specifics>
## Specific Ideas

- This is the "stop having the in-memory history / don't keep it in two places" change the user asked for. Note the precise meaning: not "delete all in-memory history" (a tool loop needs a buffer mid-conversation, head included), but "stop carrying a long-lived array across idle gaps as a second source of truth."
- Sub-agents idle for minutes is the common case (waiting on bash, finished prior work, suspended on a question awaiting a `message_agent` answer) — the win is idle agents holding zero conversation in memory.
- Core-loop refactor → needs thorough tests: resume-after-idle (both former `update()` paths), mid-loop `message_agent` delivery, compaction interaction, suspend→answer→continue, and a restart-reaping regression check.
</specifics>

<deferred>
## Deferred Ideas

- **Resuming running agents across a process restart** — explicitly NOT wanted (terminate-on-restart stays; `index.ts:349–358`).
- **Folding sub-agent storage onto the head's `messages` table** — rejected in Phase 53 (separate `agent_messages` table retained).
- **User-facing version bump / CHANGELOG** — the operator-visible payoff (full sub-agent transcripts in the dashboard) lands with Phase 53; decide at a coherent shipping point whether 53 alone or 53+54 cuts a minor release (both `package.json` files in lockstep per AGENTS.md).
</deferred>

---

*Phase: 54-single-source-of-truth-for-sub-agent-history*
*Context gathered: 2026-06-21 via Design Session*
