# Phase 18: Persistent Agent Color Slot Assignment - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Add a `color_slot` integer (0–6) column to the `agents` table, assigned at spawn time using LRU logic (least recently active by `updated_at`), so every surface — dashboard and all channel adapters — reads the same deterministic assignment instead of computing an independent hash.

</domain>

<decisions>
## Implementation Decisions

### Storage
- **D-01:** Add `color_slot INTEGER` column to the `agents` table via a new SQL migration (next after `001_init.sql`).
- **D-02:** Null slot = no color. No backfill for existing agents. No hash fallback. Pre-release, so no back-compat concern.

### Assignment Logic
- **D-03:** Assign the slot at agent spawn time (DB insert), not lazily.
- **D-04:** LRU = pick the slot whose current holder has the oldest `updated_at` among running/suspended agents. No new `last_tool_call_at` column — `updated_at` is close enough.
- **D-05:** 7 slots (indices 0–6), matching the 7-color Okabe-Ito palette already in the dashboard.

### Dashboard
- **D-06:** `ConversationsPage` already calls `api.agents.list` (line 564). Add `color_slot` to the agent list response shape and build a `Map<agentId, color>` from it at render time. Replace the current `buildAgentColorMap` / LRU timeline walk entirely.
- **D-07:** The 7-color `AGENT_COLORS` palette in `ConversationsPage.tsx` stays as-is (Okabe-Ito). The map just uses `AGENT_COLORS[agent.color_slot]` instead of computing from timeline.

### Channel Adapters
- **D-08:** Replace the per-agent `AGENT_CIRCLES` hash in `src/sub-agents/local.ts` with a lookup of the stored `color_slot` from the agent record. The agent record is available in `LocalAgentRunner` at the point where `circleIdx` is currently computed.
- **D-09:** `AGENT_CIRCLES` palette stays as-is (the 8 circle emojis). Slot index maps directly — slot 0 → `AGENT_CIRCLES[0]`, etc. Slot null → no circle prefix (or retain hash as silent fallback — Claude's discretion).

### Claude's Discretion
- Whether null-slot agents in channels get a hash fallback circle or no circle at all.
- Exact DB query shape for the LRU slot selection at spawn time.
- Whether `color_slot` is included in the existing agent row upsert or a separate update after insert.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Database
- `sql/001_init.sql` — current agents table schema (no `color_slot` column yet); new migration goes here as a second file

### Agent spawn / color assignment
- `src/sub-agents/local.ts` lines ~805–820 — `AGENT_CIRCLES` hash currently computed here; this is where lookup replaces the hash

### Dashboard
- `dashboard/src/pages/ConversationsPage.tsx` lines ~15–50 — `AGENT_COLORS`, `buildAgentColorMap`; both get replaced
- `dashboard/src/pages/ConversationsPage.tsx` line ~564 — `api.agents.list` already fetched; `color_slot` gets added to the response shape

### Agent list API
- `src/dashboard/routes/` — find the agents list route to add `color_slot` to the response

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `sql/001_init.sql` agents table — add `color_slot INTEGER` column via new migration file
- `api.agents.list` query in `ConversationsPage` (line 564) — already in flight, just needs `color_slot` in response
- `AGENT_CIRCLES` array in `local.ts` (line 811) — stays, just index changes from hash to stored slot

### Established Patterns
- Migrations are single numbered SQL files under `sql/` — next file is `002_*.sql`
- `updated_at` is maintained on the agents table — use it for LRU without adding a new column
- Dashboard uses `@tanstack/react-query` with `api.*` helpers for all data fetching

### Integration Points
- Agent spawn → DB insert in `LocalAgentRunner` (or wherever `agents` rows are created) — slot assigned here
- Dashboard agents list API route → add `color_slot` to SELECT and response type
- `ConversationsPage` render loop → `AGENT_COLORS[agent.color_slot]` lookup replaces `buildAgentColorMap`
- `local.ts` verbose wrapper → `AGENT_CIRCLES[agent.color_slot]` replaces hash

</code_context>

<specifics>
## Specific Ideas

- The LRU query at spawn: SELECT all running/suspended agents' `color_slot` and `updated_at`, find which slot index (0–6) has the oldest `updated_at` (or is unoccupied), assign that to the new agent.
- If all 7 slots are occupied by active agents, still pick the oldest — best-effort, not a hard guarantee.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 18-persistent-agent-color-slot-assignment*
*Context gathered: 2026-04-22*
