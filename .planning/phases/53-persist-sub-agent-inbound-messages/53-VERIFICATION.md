---
phase: 53-persist-sub-agent-inbound-messages
verified: 2026-06-21T22:45:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification: null
gaps: []
deferred: []
human_verification: []
---

# Phase 53: Persist Sub-Agent Inbound Messages — Verification Report

**Phase Goal:** Persist every *inbound* message a sub-agent receives to `agent_messages` at the moment it enters the conversation, with the `injected` flag — mirroring how the head persists both sides to its `messages` table. Inject points covered in `src/sub-agents/local.ts`: the initial task user-message, `message_agent` updates (top-of-loop and onRoundComplete, unified to one idempotent persist guarded by `markProcessed`), resume/signal answers, sub-agent completion/question/failure notices, and synthetic skill/MEMORY reads (persisted as `injected` tool messages). Additive only — no change to loop control flow, the in-memory `history` array stays (Phase 54 removes it), `work_start` untouched.
**Verified:** 2026-06-21T22:45:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | The operator opens the dashboard agent-stream view and sees the inbound side of a sub-agent's conversation (the initial task, message_agent updates, resume answers, sub-agent notices, skill reads), not just the agent's own output. | ✓ VERIFIED | `persistInbound` is wired at every inbound inject point. `GET /api/agents/:id/history` reads `agent_messages` rows (confirmed via `agentStore.get(id)?.history` in tests). `MessageBubble` and `AgentStreamView` already handle `role:user` and `injected` messages per CONTEXT.md — no dashboard code changes needed. Test A–D each assert via DB-read history, proving rows reach the table. |
| 2 | A spawned sub-agent's initial task text is stored in `agent_messages` as a `role:user` row at spawn time, before the first LLM call. | ✓ VERIFIED | `local.ts:515–524`: `taskMsg` const built as `{kind:'text',role:'user',...}` (no `injected` flag), `history.push(taskMsg)` then `this.persistInbound(agentId, taskMsg, options)` immediately after — before `runLoopFrom`. Old in-place mutation branch (`last.content +=`) is absent (grep confirms). Test A asserts `agentStore.get(id)?.history` contains exactly this row, content matches task text, no `injected` flag. |
| 3 | A `message_agent` update delivered to a running sub-agent is stored in `agent_messages` exactly once — never duplicated across the top-of-loop and onRoundComplete inject paths. | ✓ VERIFIED | Top-of-loop site (`local.ts:684`): `inboxStore.markProcessed(msg.id)` before build+persist. `onRoundComplete` site (`local.ts:901`): same `markProcessed` before build+persist. `inboxStore.poll` filters `processed_at IS NULL`, so a single inbox row is claimed by exactly one site. Both sites now route through `persistInbound`. Test B asserts `updateRows.toHaveLength(1)` after delivery and `awaitAll`. |
| 4 | An agent resumed via the DB path (`resumeSuspended`) shows no duplicated first turn — the task appears exactly once in its history. | ✓ VERIFIED | `resumeSuspended` (`local.ts:409–436`) builds `history` as `[...(state.history ?? [])]` — loads from DB, no separate task re-injection from `agents.task`. The task was persisted as a message at spawn so it arrives in `state.history` already. No code in `resumeSuspended` re-adds the task. Test C spawns → suspends → resumes via DB path → asserts `taskRows.toHaveLength(1)`. |
| 5 | Synthetic SKILL.md / MEMORY.md reads injected at spawn are stored as `injected` tool messages so the dashboard renders the agent's starting instructions. | ✓ VERIFIED | `local.ts:576–589`: `skillTcMsg` has `injected: true`, `skillTrMsg` has `injected: true`; each followed by `this.persistInbound(...)`. Test D uses a mock `SkillLoader` returning a skill with `instructions`, asserts `injectedTc` (`kind:'tool_call'`, `injected:true`) and `injectedTr` (`kind:'tool_result'`, `injected:true`) in persisted history, and verifies `toolCalls[0].input.path` matches skill path. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/sub-agents/local.ts` | `persistInbound(agentId, msg, options)` helper + appendMessages/emitMessageAdded calls at every inbound inject point | ✓ VERIFIED | Helper at `local.ts:462–465`. Call sites at lines 497, 524, 587, 589, 696, 710, 757, 914 — 9 call sites total (MCP warning, task, 2× skill reads, top-of-loop update, resume answer, sub-agent notice, onRoundComplete update). |
| `src/sub-agents/agents.test.ts` | Tests proving inbound persistence, message_agent single-store idempotency, no-duplicate-first-turn after resume, and injected skill reads | ✓ VERIFIED | `describe('Phase 53: inbound persistence', ...)` at line 1957 with Tests A–D. All 104 tests pass (`npx vitest run src/sub-agents/agents.test.ts` → 104 passed). |
| `CHANGELOG.md` | User-facing entry under [next] noting the dashboard now shows the full sub-agent back-and-forth | ✓ VERIFIED | `CHANGELOG.md` line 10: under `## [next] ### Fixed` — "The background-agent view now shows the full back-and-forth". No phase numbers, plan IDs, file paths, or `work_start` references. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/sub-agents/local.ts persistInbound` | `src/db/agents.ts appendMessages + emitMessageAdded` | `this.agentStore.appendMessages` / `this.agentStore.emitMessageAdded` | ✓ WIRED | `local.ts:463–464` calls both methods directly on `this.agentStore`. Pattern matches `this\\.agentStore\\.(appendMessages\|emitMessageAdded)`. |
| `GET /api/agents/:id/history` | `agent_messages` table | `AgentStore.get` → `stmtGetMessages` (ORDER BY rowid) | ✓ WIRED | `agentStore.get(id)?.history` in tests reads from DB table; tests A–D confirm inbound rows appear in this surface. `src/db/agents.ts` `get()` reads all `agent_messages` rows for the agent ordered by rowid. |

### Data-Flow Trace (Level 4)

Level 4 tracing is applied to the two dynamic paths that render to users.

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `GET /api/agents/:id/history` (dashboard history endpoint) | `agent.history` (agent_messages rows) | `appendMessages` INSERT → `stmtGetMessages` SELECT | Yes — Tests A–D confirm rows inserted by `persistInbound` appear in `agentStore.get().history` | ✓ FLOWING |
| `emitMessageAdded` SSE event | `agent_message_added` event payload | `this.agentStore.emitMessageAdded(agentId, msg, ...)` at each `persistInbound` call | Yes — SSE events carry the actual message objects with correct content | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript type-clean | `npx tsc --noEmit` | exit 0, no output | ✓ PASS |
| All 104 tests pass including A–D | `npx vitest run src/sub-agents/agents.test.ts` | 104 passed | ✓ PASS |

### Probe Execution

No probes declared for this phase. Step 7c: SKIPPED (no probe files found for this phase).

### Requirements Coverage

No REQ-IDs mapped to Phase 53 (PLAN.md `requirements: []`; REQUIREMENTS.md contains no Phase 53 mappings; ROADMAP.md explicitly states "No REQ-IDs mapped — must-haves derived from the ROADMAP goal + 53-CONTEXT.md LOCKED decisions"). Coverage is N/A for this phase.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/sub-agents/local.ts` | 530, 536 | `const tcIds: string[] = []` / `tcIds.push(...)` — written but never read | ℹ️ Info | Pre-existing dead variable (flagged in REVIEW.md as IN-03, not introduced by Phase 53). No impact on correctness. |

No `TBD`, `FIXME`, or `XXX` markers found in any of the three modified files. No `TODO`/`HACK`/`PLACEHOLDER` markers found. No stub implementations. No hardcoded empty returns in modified regions.

**Framing nudges correctly excluded from persistence (CONTEXT.md decision honored):**
- `[Status check requested...]` (`local.ts:776`) — in-memory only, no `persistInbound` call
- `[Continue with your current task.]` (`local.ts:811`) — in-memory only, no `persistInbound` call

**Scope boundary honored:**
- `work_start` / `updateWorkStart` untouched — still at `local.ts:502` and `255`
- `resumeSuspended` history source unchanged — `local.ts:429`: `[...(state.history ?? [])]`
- In-memory `history` array unchanged — still the working buffer throughout `loopIteration`
- Old in-place mutation branch for MCP-warning + task removed (no `last.content +=` pattern found)

### Human Verification Required

None. All observable truths are verifiable programmatically via the test suite and source inspection.

### Gaps Summary

No gaps. All 5 must-have truths VERIFIED. All 3 required artifacts VERIFIED. Both key links WIRED. Tests pass (104/104). TypeScript clean. No debt markers.

The two warnings from REVIEW.md (WR-01: Test B timing-dependent, WR-02: retract-guard asymmetry) are code-quality findings that do not block the phase goal:
- WR-01 is a CI reliability concern for Test B, not a correctness failure. Test B currently passes in the test run.
- WR-02 documents a guard asymmetry between the two `update` sites that is informational — both sites persist correctly, and the top-of-loop behavior (persisting an update before a retract) is defensible.

Neither constitutes a failure of the must-have truths.

---

_Verified: 2026-06-21T22:45:00Z_
_Verifier: Claude (gsd-verifier)_
