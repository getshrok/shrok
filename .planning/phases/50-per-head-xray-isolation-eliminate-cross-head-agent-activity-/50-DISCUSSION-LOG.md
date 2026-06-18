# Phase 50: Per-head xray isolation — eliminate cross-head agent-activity bleed in the dashboard timeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-18
**Phase:** 50-per-head-xray-isolation-eliminate-cross-head-agent-activity
**Areas discussed:** Leak scope, Backfill depth, Switch behavior

---

## Leak scope

| Option | Description | Selected |
|--------|-------------|----------|
| Just the xray timeline | Fix only the agent tool-call/result items in the conversation timeline; leave the sibling leaks. | |
| Xray + sibling leaks | Also head-scope steward_run_added, memory_retrieval, and the agent_status_changed pill refresh. | |
| Let me decide after you scope each | List effort/risk per sibling leak and pick. | |

**User's choice:** "NOTHING should be cross-head leaking." (Goes beyond all three presented options — full isolation of every per-head dashboard path, plus any additional leaks the researcher surfaces.)
**Notes:** Reframes the phase from "xray timeline only" to "no cross-head bleed anywhere on the dashboard." The four `streamFilter.ts`-flagged events are the known inventory; researcher must sweep for others (e.g. `/api/activity`). Acceptance bar: two heads, switch, zero bleed either direction, backfill + live.

---

## Backfill depth

| Option | Description | Selected |
|--------|-------------|----------|
| Keep 50 per head | Same constant, now applied per head. | ✓ |
| Lower it | Drop to a smaller per-head window (e.g. 25). | |
| You choose | Pick whatever's consistent and note it. | |

**User's choice:** Keep 50 per head.
**Notes:** `getRecent(50)` → `getRecent(50, head)`. No new limit constant.

---

## Switch behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Clear + re-backfill (mirror pills #10) | Drop the old head's live items immediately and re-backfill from the new head. | ✓ |
| Other behavior | A different reset/retain idea. | |

**User's choice:** Clear + re-backfill, mirroring the issue #10 pill-bar fix (commit 352b9dd).
**Notes:** Head-key the caches + reset accumulators in a `[selectedHead]` effect, the existing `setKnownAgents(new Map())` shape.

## Claude's Discretion

- Exact wiring of the fix mechanism (event payload `headId` tagging, streamFilter drop-set expansion, cache head-keying/reset, REST `?head=` threading) — locked in direction (mirror `message_added` + issue #10), free in detail.
- Whether `['stewardRuns']`/`['memory-retrievals']`/`['xray-messages']` get head-keyed cache keys vs. reset-on-switch accumulators — planner's call as long as the switch behavior matches D-03.

## Deferred Ideas

None — discussion stayed within phase scope.
