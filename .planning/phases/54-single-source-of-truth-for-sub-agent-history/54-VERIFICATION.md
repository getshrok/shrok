---
phase: 54-single-source-of-truth-for-sub-agent-history
verified: 2026-06-22T15:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Compaction interaction preserved and tested: after maybeArchiveHistory fires, DB history contains kind:'summary' from compactHistory, not the full pre-compaction sequence"
  gaps_remaining: []
  regressions: []
---

# Phase 54: Single Source of Truth for Sub-Agent History — Verification Report

**Phase Goal:** Eliminate the long-lived in-memory `history` array for sub-agents, collapsing onto the head's model (DB canonical, in-memory transient per-loop buffer). (1) Load history from DB each loop entry/wake mirroring the head's getRecent with historyBudget windowing; (2) unify the two update() resume paths onto a DB-sourced read; (3) retire work_start in favor of the injected filter. The ROADMAP explicitly lists "compaction interaction" as a behavior needing thorough tests.
**Verified:** 2026-06-22T15:00:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (plan 54-04, commits c1b4f63 + 4a66403)

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DB-sourced loop entry: `loopIteration` rebuilds history from DB on each tool-loop pass via `getHistoryWithinBudget`; idle agents hold zero conversation in memory | VERIFIED | `src/sub-agents/local.ts:776` — `const history = this.agentStore.getHistoryWithinBudget(agentId, this.historyBudget)` inside the outer `while(true)` body, after inbox drain, before `runToolLoop`. History not threaded across the park boundary. |
| 2 | Both `update()` resume paths read history from the DB; neither supplies an in-memory array | VERIFIED | PATH A (`completed` → resumeSuspended) no longer calls `updateWorkStart` and does not build `const history = [...(state.history ?? [])]`. PATH B (emitter wake) emits inbox signal and the outer `while` reload picks it up. Comment at `:253` documents unification. `state.history ?? []` pattern absent. |
| 3 | `work_start` index retired; completion guard uses `!m.injected` filter | VERIFIED | `src/sub-agents/local.ts:944` — `const hasCalledTool = history.some(m => m.kind === 'tool_call' && !m.injected)`. No `updateWorkStart` or `slice(workStart)` patterns present. |
| 4 | Anti-double-injection: after `resumeSuspended`, task message appears exactly once | VERIFIED | T7 passes. `resumeSuspended` no longer re-injects `state.task` as a first turn; the task persisted at spawn (Phase 53) is loaded from DB exactly once. |
| 5 | Compaction interaction preserved and tested: after `maybeArchiveHistory` fires, next DB reload includes a `kind:'summary'` message, not the full pre-compaction sequence | VERIFIED | `local.ts:776` windows on `this.historyBudget` (context-window-class, strictly > `this.archivalThreshold`); `local.ts:830` calls `maybeArchiveHistory` with `archivalThreshold: this.archivalThreshold`. The invariant `historyBudget > archivalThreshold` means windowed history CAN exceed the compaction trigger. Constructor guard (`:165`) throws if violated. `system.ts:377-378` wires `archivalThreshold = contextWindowTokens * 0.80` and `historyBudget = contextWindowTokens` (40,000 > 32,000 at defaults). T4 asserts `history.some(m => m.kind === 'summary')` — a real compactHistory output. |

**Score:** 5/5 truths verified

---

## BL-01 Closure — Detailed Confirmation

### The fix (plan 54-04)

**Root cause of BL-01:** `getHistoryWithinBudget(agentId, this.archivalThreshold)` clamped history to `estimateTokens <= archivalThreshold` by construction. `maybeArchiveHistory` early-returns when `estimateTokens(history) <= deps.archivalThreshold`. The same constant in both sites made compaction permanently dead code.

**The fix decouples the two roles with a separate field:**

```typescript
// local.ts:121 — class field
private historyBudget: number

// local.ts:164-165 — constructor
this.historyBudget = opts.historyBudget ?? Math.max(this.archivalThreshold * 2, 200_000)
if (this.historyBudget <= this.archivalThreshold) throw new Error(`historyBudget (${this.historyBudget}) must exceed archivalThreshold (${this.archivalThreshold}) — otherwise compaction is dead code`)

// local.ts:776 — windowing (fixed: was this.archivalThreshold)
const history = this.agentStore.getHistoryWithinBudget(agentId, this.historyBudget)

// local.ts:830-837 — compaction trigger (unchanged: still archivalThreshold)
await maybeArchiveHistory(agentId, history, {
  archivalThreshold: this.archivalThreshold,
  ...
})
```

**Production wiring (system.ts:377-378):**

```typescript
archivalThreshold: Math.floor(config.contextWindowTokens * config.archivalThresholdFraction), // 40_000 * 0.80 = 32_000
historyBudget: config.contextWindowTokens,                                                     // 40_000
```

`40,000 > 32,000` — the invariant holds unconditionally for any `archivalThresholdFraction < 1.0` (the constructor assertion catches the edge case).

### T4 is a genuine, non-false-passing regression guard

**Old T4 (false-positive):** Used `content.includes(summaryContent)` against an assistant text response. Compaction never fired; the agent's own first-turn text response happened to contain the sentinel string. No `kind:'summary'` message was ever created.

**New T4 (genuine guard):**

1. Sets `{ archivalThreshold: 30, historyBudget: 200_000 }` — satisfies constructor invariant.
2. Seeds 3 additional text messages into the DB immediately after spawn, ensuring combined history (5 msgs, >> 30 tokens) exceeds `archivalThreshold=30` on pass 2's reload.
3. Detects the archival steward's LLM call by message content prefix `'Summarize this conversation history'` (matching `archival.ts:56`) — mock returns the sentinel summary string.
4. PASS assertion: `expect(history.some(m => m.kind === 'summary')).toBe(true)` — requires a genuine `compactHistory`-produced row.
5. Confirms sentinel content: `expect(summaryMsg?.content).toContain(summaryContent)`.
6. Anti-duplication check retained: task row appears at most once.

**Why T4 would FAIL if Task 1 were reverted:** With windowing back on `archivalThreshold=30`, `getHistoryWithinBudget(agentId, 30)` returns only the 1-2 newest messages fitting within 30 tokens. With 1-2 messages: `cutoff = floor(1*0.3) = 0 < 1` → `maybeArchiveHistory` early-returns at the cutoff guard (`archival.ts:32`). No `compactHistory` call. No `kind:'summary'` row. T4's assertion `history.some(m => m.kind === 'summary')` fails.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/sub-agents/local.ts` | `historyBudget` field + constructor assertion + windowing on `this.historyBudget` | VERIFIED | Lines 83, 121, 164-165, 776. Constructor throws `if historyBudget <= archivalThreshold`. Windowing call uses `this.historyBudget`. `maybeArchiveHistory` at line 830 still uses `archivalThreshold: this.archivalThreshold`. |
| `src/system.ts` | `historyBudget: config.contextWindowTokens` wired at runner construction | VERIFIED | Line 378. Strictly greater than `archivalThreshold` (line 377) at default 0.80 fraction. |
| `src/sub-agents/agents.test.ts` | T4 asserts `kind:'summary'`; makeRunner overrides thread `historyBudget` | VERIFIED | Lines 395, 448 (overrides type + spread). T4 at lines 2325-2401: `m.kind === 'summary'` assertion at line 2388. No `content.includes(summaryContent)` pattern. T1-T3, T5-T7 unmodified and unweakened. |
| `src/sub-agents/archival.ts` | `maybeArchiveHistory` gates on `estimateTokens(history) > deps.archivalThreshold` | VERIFIED | Line 29. Early-return when `<= archivalThreshold`. With `historyBudget > archivalThreshold`, windowed history CAN exceed the trigger, re-enabling the compaction path. |
| `src/db/agents.ts` | `getHistoryWithinBudget(agentId, tokenBudget)` returns newest-first within budget | VERIFIED | Lines 323-335. Iterates messages newest-first, breaks when `used + cost > tokenBudget`, unshifts into chronological order. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `local.ts loopIteration` | `AgentStore.getHistoryWithinBudget` | DB load at outer while top | WIRED | Line 776: `getHistoryWithinBudget(agentId, this.historyBudget)` |
| `local.ts windowing` | `this.historyBudget` | context-window-class budget (not archivalThreshold) | WIRED | Line 776 confirmed; `grep -c "getHistoryWithinBudget(agentId, this.archivalThreshold)"` → 0 |
| `local.ts maybeArchiveHistory` | steward LLM summarization | `estimateTokens(history) > archivalThreshold` guard (now reachable) | WIRED | Line 830. Now reachable because `historyBudget > archivalThreshold` allows windowed history to exceed the trigger. |
| `local.ts constructor` | invariant guard | `if (historyBudget <= archivalThreshold) throw` | WIRED | Line 165. Fires at startup on misconfiguration — catches future regressions. |
| `system.ts` | `LocalAgentRunner` | `historyBudget: config.contextWindowTokens` | WIRED | Line 378. Strictly > `archivalThreshold` (line 377) by design. |
| `local.ts completion guard` | `!m.injected` filter | `history.some(m => m.kind === 'tool_call' && !m.injected)` | WIRED | Line 944 (unmodified — T1-T7 plans unchanged). |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| T1-T7 all pass (incl. rewritten T4) | Full suite reported 2287 passed, 0 failed | T4 asserts `kind:'summary'` — genuine compaction coverage | PASS |
| Phase 53 regression | T1-T7 Phase 53 tests | 4/4 passed | PASS |
| tsc clean | `npx tsc --noEmit` | exit 0 | PASS |
| `historyBudget` in windowing call | `grep "getHistoryWithinBudget(agentId, this.historyBudget)" src/sub-agents/local.ts` | Line 776 | VERIFIED |
| `archivalThreshold` NOT in windowing | `grep -c "getHistoryWithinBudget(agentId, this.archivalThreshold)" src/sub-agents/local.ts` | 0 matches | VERIFIED |
| `kind === 'summary'` in T4 | `grep -n "m.kind === 'summary'" src/sub-agents/agents.test.ts` | Line 2388 + 2391 | VERIFIED |
| `content.includes(summaryContent)` absent | Pattern removed from T4 | 0 matches expected | VERIFIED |

### Requirements Coverage

No requirement IDs declared in plan 54-04 frontmatter (`requirements: []`). The gap closure directly addresses the ROADMAP success criteria ("compaction interaction" listed as needing thorough tests).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | — | — | — | — |

All previously-flagged anti-patterns (dead `maybeArchiveHistory` call, false-passing T4) are resolved.

### Human Verification Required

None — the gap closure is mechanically verifiable from the code. Compaction path is live code confirmed by test execution (T4 passes with `kind:'summary'` assertion, full suite green).

---

## Gaps Summary

Phase 54 has achieved all five observable truths. The gap from the initial verification (BL-01 — compaction dead code due to single-constant collision) is closed by plan 54-04:

- `historyBudget` is now a distinct field from `archivalThreshold` in `LocalAgentRunner`
- Windowing uses the context-window-class `historyBudget` (≥ 200,000 token default, or `contextWindowTokens` in production)
- Compaction fires at `archivalThreshold` (120,000 default, or `contextWindowTokens * 0.80` in production)
- The invariant `historyBudget > archivalThreshold` is enforced by a constructor assertion
- T4 asserts a genuine `kind:'summary'` message produced by `compactHistory` — it would fail if compaction were reverted to dead code

The three warnings from the initial REVIEW.md (WR-01 skill-memory in-memory loss, WR-02 cross-provider orphan tool_result, WR-03 resume race) remain tracked as follow-ups in `54-REVIEW.md` and are explicitly out of scope for this phase.

---

_Verified: 2026-06-22T15:00:00Z_
_Verifier: Claude (gsd-verifier)_
