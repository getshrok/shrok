# Phase 53: Persist sub-agent inbound messages — Context

**Gathered:** 2026-06-21
**Status:** Ready for planning
**Source:** Design Session (interactive — investigated against live code + the running DB at `~/.shrok/workspace/data/shrok.db`)

<domain>
## Phase Boundary

Make the database a **complete record of every sub-agent turn** by persisting the *inbound* half of a sub-agent's conversation that today lives only in memory.

**The problem (verified empirically).** Sub-agents persist only LLM-*generated* output. In `runToolLoop` (`src/llm/tool-loop.ts`), the `appendMessage` callback (wired at `src/sub-agents/local.ts:828–831`) writes assistant turns (`tool-loop.ts:310`) and tool results (`tool-loop.ts:401`) to the `agent_messages` table. It never writes the input `history` array back. Everything the sub-agent *receives* — the initial task, `message_agent` follow-ups, resume answers, sub-agent notices, the synthetic skill reads — is pushed into the in-memory `history` array only and is lost when that array goes away.

Evidence from the live DB (hundreds of agents): `text/assistant` = 1466 rows, `tool_call` ≈ 2359, `tool_result` ≈ 2355, but `text/user` = **2** (both are loop-detection nudges from `tool-loop.ts:444`, the only user-role message that happens to flow through `appendMessage`). Zero initial-task messages, zero `message_agent` messages, zero `tc_`-prefixed synthetic skill reads are stored. The newest agent's first stored row is a `toolu_`-prefixed (LLM-generated) tool call, confirming the seed is dropped.

**Two concrete harms this causes:**
1. **Dashboard can't show the inbound side.** `AgentStreamView` (`dashboard/src/pages/ConversationsPage.tsx:394`) renders `GET /api/agents/:id/history`, which reads `agent_messages` from the DB (`src/dashboard/routes/agents.ts:30–43` → `AgentStore.get`). Since inbound rows aren't in the table, the operator sees only the agent's own output, never the prompts that drove it.
2. **Suspended-agent resume divergence (a latent correctness bug, not just cosmetics).** `update()` has two resume paths that see *different* history: the live-emitter in-memory path (`src/sub-agents/local.ts:262–264`, wakes the parked loop using its in-memory array) and the DB path (`resumeSuspended`, `local.ts:266` → `409`, loads `state.history` from the DB). Because inbound messages aren't persisted, an agent that received a `message_agent` "also do X" and then resumes via the DB path can come back having **forgotten** that instruction.

**The blueprint already exists — the head does this correctly.** The head persists *both* sides as they happen to its `messages` table: inbound user text immediately on event (`src/head/activation.ts:555`), injected system events with an `injected: true` flag (`src/head/injector.ts:208/223/288/314`), and outbound assistant turns (`src/head/activation.ts:915`). It then assembles its LLM context by reading the table back (`src/head/assembler.ts:201` → `messages.getRecent`). Phase 53 brings sub-agents to parity on the *persistence* half.

**Scope of THIS phase = additive persistence only.** No change to loop control flow. The in-memory `history` array stays as the working buffer. Removing it / making the loop DB-sourced is **Phase 54**.
</domain>

<decisions>
## Implementation Decisions

### Storage location — keep the `agent_messages` table (LOCKED)
Sub-agents keep their own agent-scoped `agent_messages` table; we simply start writing inbound rows to it too, reusing the same `injected` flag convention as the head. **Do NOT** fold sub-agent storage onto the head's `messages` table. Rationale: same data model and flag semantics as the head, no storage migration, and it doesn't touch the head's hot path. (`appendMessages` already exists at `src/db/agents.ts:322`; the only INSERT into `agent_messages` is `agents.ts:145`, so all rows route through one place.)

### Inject points to persist (in `src/sub-agents/local.ts`)
Persist at the moment each message enters the conversation (mirroring `activation.ts:555`'s "append before the LLM call" pattern). Each maps to an existing `history.push(...)`:
- **Initial task user-message** — built in `runLoop` (~497–504). Persist it at spawn, right after it's built, before `runToolLoop`. Also persist the **MCP-unavailable warning** (~469–476) when present.
- **Synthetic skill/MEMORY reads** — the seeded `read_file` tool_call/tool_result pair (~557–564, `tc_`-prefixed). Persist as `injected` tool messages. **(See "persist + show" decision below.)**
- **`message_agent` updates** — inbox `update` injection. There are TWO injection sites today: top-of-loop (~660–665, currently in-memory only) and the `onRoundComplete` mid-loop path (~875, which *already* calls `appendMessages`). **Unify to one idempotent persist** so a single inbox message can't be stored twice; guard on `markProcessed` (inbox rows already carry `processed_at`).
- **Resume / `signal` answers** — the answer injected on resume (~672–677).
- **Sub-agent completion/question/failure notices** — the `sub_agent_completed` / `sub_agent_question` / `sub_agent_failed` injections (~715–721).

### Synthetic skill/MEMORY reads — persist AND show (LOCKED)
Persist the seeded SKILL.md/MEMORY.md reads and let the dashboard render them. Full fidelity: the transcript should reflect what the agent actually saw, including its skill instructions. Mark them `injected`; the dashboard already collapses `tool_call`+`tool_result` into a tidy `MergedToolBubble`, so noise is minimal.

### `work_start` — DEFER to Phase 54 (LOCKED)
Do **not** touch the `work_start` index in this phase. It's an integer index into history marking where a *continued* agent's "own work" begins (so completion summaries only cover new work) and it's already out of step with the persisted array. It gets retired in Phase 54 in favor of the `injected`-flag filter. Keeping it untouched here preserves "Phase 53 is purely additive." ⚠️ One thing to verify during planning: persisting the seed shifts in-memory vs. persisted index alignment — confirm nothing 53 changes makes the *existing* `work_start` behavior worse in the interim (it should be inert since 53 doesn't change how `work_start` is read or set).

### Anti-double-storage discipline (the one real gotcha)
Anything currently reconstructed-fresh-each-run must become "persist once at inject, then it's in the DB" — never both injected-fresh AND loaded-from-DB. Concretely for 53: the task is also stored in the `agents.task` column (keep that — it's used for display, the commit message at `local.ts:614`, and resume reconstruction), but once it's persisted as a message, the resume path must not *also* re-inject it from the column. Since 53 doesn't change resume's history source (that's 54), the safe rule for 53 is: persist the task as a message at spawn, and ensure `resumeSuspended` (which loads `state.history`) doesn't separately re-add the task. Verify there's no path that yields a duplicated first turn.

### Claude's Discretion
- Exact helper/shape for the persist calls (a small `persistInbound(agentId, msg)` wrapper vs. inline `appendMessages`), and whether to also fire `emitMessageAdded` for live SSE vs. relying on the dashboard's 3s refetch (`ConversationsPage.tsx:400`). Prefer emitting for live updates if cheap.
- Whether the internal plumbing pushes that are NOT conversation — the `[Continue with your current task.]` prefill nudge (~772–777) and `[Status check requested…]` (~737–742) — are persisted. Recommendation: leave these in-memory (they're framing noise, not back-and-forth). Decide during planning.
- Whether to backfill display of the existing `agents.task` column for *old* agents whose task predates this change (nice-to-have; the dashboard endpoint already returns `task`).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The pattern to mirror (head persistence)
- `src/head/activation.ts` — `:555` inbound user append before LLM call; `:915` outbound assistant append. The "persist as it enters" model.
- `src/head/injector.ts` — `:208/223/288/314` injected system events persisted with `injected: true`. The flag convention to copy.

### Where sub-agent persistence lives today
- `src/sub-agents/local.ts` — the runner. Inject points: ~469–476 (MCP warning), ~497–505 (initial task), ~557–564 (synthetic skill reads), ~660–665 / ~875 (`message_agent` update, two sites to unify), ~672–677 (resume answer), ~715–721 (sub-agent notices). Persistence callback at ~828–831. `update()` resume paths at ~251–272. `resumeSuspended` at ~409.
- `src/llm/tool-loop.ts` — `appendMessage` usage (`:310`, `:401`, `:444`); confirms input `history` is never persisted by the loop.
- `src/db/agents.ts` — `appendMessages` (`:322`), the sole `agent_messages` INSERT (`:145`), `AgentStore.get` (reads messages for the history endpoint).
- `sql/004_agent_messages.sql` — the `agent_messages` schema (JSON `data` column; append-only, ordered by rowid).
- `src/types/core.ts` — `Message` union (`TextMessage`/`ToolCallMessage`/`ToolResultMessage`/`SummaryMessage`) and the `injected` field.

### Where it surfaces (dashboard)
- `dashboard/src/pages/ConversationsPage.tsx` — `AgentStreamView` (`:394`), `MessageBubble` (`:163`, already renders `role:user` and `injected` messages), `MergedToolBubble` (`:298`).
- `src/dashboard/routes/agents.ts` — `:30–43` the `/:id/history` endpoint.
</canonical_refs>

<specifics>
## Specific Ideas

- "Treat sub-agents like the head" is the governing principle, but for Phase 53 it means *same persistence pattern + same `injected` flag*, NOT same table (see Storage decision).
- The dashboard fix is genuinely free once rows exist — `MessageBubble` already styles inbound (`role:user` → right-aligned zinc bubble) and `injected` (muted mono), and `AgentStreamView` passes `showSystemEvents={true}` / `showToolMessages={true}` so nothing is filtered out.
- Restart behavior is out of scope and unchanged: running agents are reaped on boot (`src/index.ts:349–358`), never resumed. This phase is about the DB being a complete record of what *did* happen, not crash-resume.
</specifics>

<deferred>
## Deferred Ideas

- **Removing the long-lived in-memory `history` array / making the loop DB-sourced** → Phase 54.
- **Collapsing the two `update()` resume paths into one DB-sourced path** → Phase 54.
- **Retiring the `work_start` index in favor of the `injected` filter** → Phase 54.
- **Folding sub-agent storage onto the head's `messages` table** → rejected (kept separate by decision above).
</deferred>

---

*Phase: 53-persist-sub-agent-inbound-messages*
*Context gathered: 2026-06-21 via Design Session*
