# Phase 50: Per-head xray isolation — eliminate cross-head agent-activity bleed in the dashboard timeline - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning

<domain>
## Phase Boundary

The dashboard conversation timeline (and its sibling activity surfaces) currently shows agent/steward/memory activity from **every** head regardless of which head is selected. This phase makes **all per-head dashboard activity head-isolated** — when a head is selected, the dashboard shows that head's activity and nothing else.

**Operator directive (governing):** "NOTHING should be cross-head leaking." Scope is therefore NOT limited to the xray (agent-work) timeline named in the phase title — it is the full set of per-head dashboard events and caches that currently bleed.

The authoritative inventory of the bleed is the "accepted cross-head leakage" list documented in `dashboard/src/hooks/streamFilter.ts` (the deferred T-33-09 from Phase 33). All four flagged event paths are in scope:

1. **`agent_message_added`** — head-spawned (`trigger:'manual'`) sub-agent `tool_call`/`tool_result` items interleaved into the conversation timeline (the "xray" stream). **The primary target.**
2. **`memory_retrieval`** — memory-block retrievals shown inline in the timeline.
3. **`steward_run_added`** — steward run rows.
4. **`agent_status_changed`** — drives agent-pill refresh / activity invalidation.

The researcher MUST also sweep for any OTHER per-head dashboard event, REST backfill, or cache that is not head-scoped (notably the `/api/activity` feed and the `['activity']` cache) and bring them into scope — "nothing leaks" is the acceptance bar, not just these four.

**In scope:** head-isolating live SSE events + their REST backfills + their client caches for the surfaces above. **Out of scope:** any new UI, new timeline item types, or changes to what activity is *captured* — this phase only changes which head's already-captured activity is *shown*.

</domain>

<decisions>
## Implementation Decisions

### Leak scope
- **D-01:** Eliminate **all** cross-head leakage, not just the xray timeline. Close every path in `streamFilter.ts`'s "accepted cross-head leakage" list — `agent_message_added`, `memory_retrieval`, `steward_run_added`, `agent_status_changed` — and any additional per-head event/backfill the researcher finds (e.g. `/api/activity`). Acceptance bar: with two heads each running agents, switching heads in the dashboard shows zero activity from the other head, both on backfill and live.

### Backfill depth
- **D-02:** Keep the existing window of **50, applied per head**. `/api/agents/xray-history` changes from `getRecent(50)` (global) to `getRecent(50, head)`. Do not introduce a new limit constant.

### Head-switch behavior
- **D-03:** On head switch, **clear the previous head's accumulated live items immediately and re-backfill from the newly selected head** — identical UX to the agent pill bar. Mirror the issue #10 precedent (commit `352b9dd`): head-key the relevant React Query caches and reset the live accumulators in a `useEffect` keyed on `[selectedHead]` (the existing `setKnownAgents(new Map())` effect at `ConversationsPage.tsx:578` is the template).

### Backward-compatibility constraint
- **D-04:** Single-head deployments must see **zero behavior change**. `agents.head_id` is `NOT NULL DEFAULT 'default'` (migration 007); any new `head_id` column added (steward_runs) MUST use the same `DEFAULT 'default'` constant-backfill pattern (mirrors `sql/005`/`sql/007`). Scoping by `'default'` is then a no-op when only one head exists. This is the Phase 32 D-03 guarantee ("zero visual change for single-head").

### Claude's Discretion
The mechanism is locked in direction but the exact wiring is the planner/executor's call. The locked pattern (symmetric with the existing `message_added` per-head handling):

- **Tag each leaky SSE event with `headId` at its emit site.** Head context is available at every emit site:
  - `agent_message_added` + `agent_status_changed` — emitted from `AgentStore` (`src/db/agents.ts:253`, `:230` et al.); the agent row carries `head_id`, include it on the payload.
  - `memory_retrieval` — emitted from `src/head/activation.ts:778`; the activation loop is per-head, include its `headId`.
  - `steward_run_added` — emitted from `src/db/steward_runs.ts:41`. **This is the one heavier sub-task: `steward_runs` has no `head_id` column today** (`id, stewards, created_at` only — `sql/001_init.sql:105`). Requires a new migration (`ALTER TABLE steward_runs ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'` + an index, mirroring 005/007) and threading `headId` from the head loop's steward invocation through `StewardRunStore.add`/the `StewardRun` type into the event.
- **Extend `streamFilter.ts`** to drop these per-head events when `event.headId !== selectedHead` (today its drop set is only `{message_added, typing}`; everything else passes). Update its doc comment — it currently *documents* these four as accepted leakage.
- **Head-key the consuming caches and reset on switch:** `['xray-backfill']` → `['xray-backfill', head]`; `['xray-messages']`, `['memory-retrievals']`, `['stewardRuns']` (and `['activity']` if applicable) reset on `[selectedHead]` change (or head-key them). Backfill REST routes gain `?head=` and pass it to head-scoped store reads (`/api/agents/xray-history`, `/api/steward-runs`, `/api/activity`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

ROADMAP.md lists no canonical refs for this phase. The references are in-codebase — they ARE the spec for this bug fix.

### The bug surfaces (read first)
- `dashboard/src/hooks/streamFilter.ts` — the per-head SSE drop filter AND the authoritative inventory of the four "accepted cross-head leakage" events to close (its doc comment names them). Drop set must expand here.
- `dashboard/src/hooks/useStream.ts` §`agent_message_added`/`agent_status_changed`/`steward_run_added`/`memory_retrieval` handlers — where SSE events route into caches (`['xray-messages']` accumulation at lines 60–78).
- `dashboard/src/pages/ConversationsPage.tsx` — xray backfill/live queries (lines ~516–527), the `[selectedHead]` reset effect precedent (lines 576–593), and timeline assembly (lines 710–723).

### Backend emit sites + backfill routes
- `src/dashboard/routes/agents.ts:65` — `/xray-history` route; calls `getRecent(50)` with NO head filter (the backfill leak).
- `src/db/agents.ts` — `getRecent(limit, headId?)` (line 305, already supports the filter), `agent_message_added` emit (253), `agent_status_changed` emits (230, 243, 248, 258, 263, 280).
- `src/head/activation.ts:778` — `memory_retrieval` emit (per-head context available).
- `src/db/steward_runs.ts` — `StewardRun` type (line 4), `steward_run_added` emit (41), `getAll`/`getRecent` reads. **No head_id column.**
- `src/dashboard/routes/steward_runs.ts` + `src/dashboard/routes/activity.ts:66` — steward/activity backfill routes (currently unscoped: `getAll()`, `getRecent(60)`).
- `src/dashboard/events.ts` — server-side `DashboardEvent` union (add `headId` to payloads here + mirror in `dashboard/src/types/api.ts:438+`).

### Precedent + migration patterns
- Commit `352b9dd` (issue #10, quick-task `260607-lwy`) — the exact precedent: head-scoped backend query + head-keyed cache + reset accumulator on switch, applied to the agent pill bar. Follow it.
- `sql/007_agents_head_id.sql` and `sql/005_multi_head.sql` — the `ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'` + compound-index migration pattern to copy for `steward_runs`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AgentStore.getRecent(limit, headId?)` (`src/db/agents.ts:305`) — **already accepts a headId filter**; the xray-history route just doesn't pass it. Backend xray scoping is a one-line change here.
- `shouldDeliverStreamEvent(event, selectedHead)` (`streamFilter.ts`) — the single chokepoint for per-head SSE filtering. Expanding its drop set covers the live path for every event that carries a `headId`.
- The `setKnownAgents(new Map())` effect on `[selectedHead]` (`ConversationsPage.tsx:578`) — copy this shape for resetting `['xray-messages']`, `['memory-retrievals']`, `['stewardRuns']`.

### Established Patterns
- **Per-head cache key convention:** `['messages', selectedHead]`, `['agents', selectedHead]` (Phase 32 D-05). New head-scoped caches follow `['<name>', selectedHead]`.
- **SSE events route to head-scoped cache via `event.headId`** (Phase 33 D-11) — already done for `message_added`; this phase extends the same self-describing-event approach to the four leaky types.
- **Constant-default head_id backfill migration** (Phase 29/34) — `ADD COLUMN head_id TEXT NOT NULL DEFAULT 'default'` populates legacy rows with no explicit UPDATE.

### Integration Points
- New `head_id` on `steward_runs` connects the steward write path (head loop → `StewardRunStore.add`) to the dashboard event + backfill query.
- `DashboardEvent` payload shapes are duplicated server-side (`src/dashboard/events.ts`) and client-side (`dashboard/src/types/api.ts`) — both must gain `headId` in lockstep.

</code_context>

<specifics>
## Specific Ideas

- The acceptance test the operator implicitly wants: two heads, each running agents simultaneously; selecting head A shows only A's agent work / steward runs / memory retrievals / pills, selecting B shows only B's — on both initial backfill and live streaming, including after switching back and forth. This is the UAT bar for "nothing leaks."
- Mirror issue #10 (the pills fix) deliberately — same three-part shape (scope the backend query, head-key the cache, reset on switch) applied uniformly to each leaky surface keeps the codebase consistent.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. The operator widened scope to "all leaks" (a clarification of the existing phase intent, not a new capability), and declined to introduce new limits or UI.

</deferred>

---

*Phase: 50-per-head-xray-isolation-eliminate-cross-head-agent-activity*
*Context gathered: 2026-06-18*
