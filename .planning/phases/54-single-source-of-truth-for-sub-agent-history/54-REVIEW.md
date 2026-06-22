---
phase: 54-single-source-of-truth-for-sub-agent-history
reviewed: 2026-06-22T04:05:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - src/db/agents.ts
  - src/sub-agents/local.ts
  - src/sub-agents/agents.test.ts
findings:
  blocker: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 54: Code Review Report

**Reviewed:** 2026-06-22T04:05:00Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Phase 54 is a behavior-preserving refactor that collapses the long-lived in-memory `history` array in sub-agents onto the `agent_messages` DB table, mirroring the head's per-turn DB-sourced assembly. The mechanical refactor is clean: `tsc --noEmit` is green, all 7 new T1–T7 tests pass, the `update()` resume paths are unified onto the DB, the `work_start` index is correctly retired in favor of the `!m.injected` filter, and the anti-double-injection discipline (persist-then-reload) holds in the tested paths.

However, the refactor reused `this.archivalThreshold` as **both** the windowing budget for `getHistoryWithinBudget` **and** the compaction trigger for `maybeArchiveHistory`. Because windowing runs first and clamps the history to ≤ `archivalThreshold`, the subsequent `maybeArchiveHistory` call always early-returns — compaction/summarization is now dead, and the oldest context is silently hard-dropped instead of summarized. This breaks the phase's stated "behavior-preserving" contract for long-running agents (BL-01). Two narrower correctness/quality concerns surround it: an in-memory-only `injectSkillMemory` injection that no longer survives a DB reload (WR-01), and a budget-split orphaned tool-pair that only the Anthropic provider sanitizes (WR-02).

The reviewed code does not touch authentication, authorization, input validation, or any external surface; no security findings.

## Critical Issues

### BL-01: Token-budget windowing silently disables history compaction; oldest sub-agent context is hard-dropped instead of summarized

**File:** `src/sub-agents/local.ts:766` (and `:820`); budget source `:766` = `this.archivalThreshold`
**Issue:**
The per-pass reload uses the same constant for two conflicting purposes:

```ts
// 766: window history down to <= archivalThreshold
const history = this.agentStore.getHistoryWithinBudget(agentId, this.archivalThreshold)
...
// 820: only compacts if estimateTokens(history) > archivalThreshold
await maybeArchiveHistory(agentId, history, { archivalThreshold: this.archivalThreshold, ... })
```

`getHistoryWithinBudget` iterates newest-first and breaks as soon as the next message would exceed the budget, so the returned `history` is **always ≤ `archivalThreshold`**. `maybeArchiveHistory` then checks `estimateTokens(history) <= deps.archivalThreshold` and returns early (`src/sub-agents/archival.ts:29`). Result: **compaction/summarization never fires for sub-agents.** Empirically confirmed: with the default 120 000-token threshold and a ~401 200-token history, windowing keeps the newest ~119 messages and drops the 281 oldest — with no steward summary bridging them, where the pre-Phase-54 code would have summarized the oldest 30% into a `summary` message.

This is a behavior regression against the phase's explicit "behavior-preserving" intent and its "windowing matches the head's semantics" contract. It also diverges from the head model the phase set out to mirror: the head derives its window from the *context window* (`contextWindowTokens - baseSystemTokens - outputReserve - memoryBudget`, `src/head/assembler.ts:161-166`) and has **no** separate compaction, so windowing-as-sole-bound is correct *there*. Sub-agents instead window at the *summarization-trigger* threshold, nullifying their summarizer while leaving a misleading, now-dead `maybeArchiveHistory` call in the loop. The DB record itself is intact (windowing doesn't delete rows), so this is context-quality loss, not data loss — but on any long-running sub-agent the LLM abruptly loses old context with no summary, changing agent output.

**Fix:**
Decouple the windowing budget from the compaction trigger so summarization still fires before windowing clamps. Either:

```ts
// Option A: compact first (on the full history), then window the compacted result.
const full = this.agentStore.getHistory(agentId)            // unbounded read (existing stmtGetMessages)
await maybeArchiveHistory(agentId, full, { archivalThreshold: this.archivalThreshold, ... })
const history = this.agentStore.getHistoryWithinBudget(agentId, this.windowBudget)  // windowBudget > archivalThreshold, e.g. a context-window-derived value like the head's
```

or, if windowing is intended to fully replace compaction for sub-agents, **remove the now-dead `maybeArchiveHistory` call** at `:820` and derive the windowing budget from the model context window (mirroring `assembler.ts:161-166`) rather than from `archivalThreshold`, and document that summarization is intentionally retired for sub-agents. Whichever path is chosen, the two responsibilities must not collide on one constant.

## Warnings

### WR-01: `injectSkillMemory` pushes MEMORY.md into the in-memory buffer only — lost on the next DB reload

**File:** `src/sub-agents/local.ts:872-874` → `src/sub-agents/skill-memory.ts:110-117`
**Issue:**
Inside the `runToolLoop` `appendMessage` callback, `injectSkillMemory(...)` is invoked when the agent reads a `SKILL.md`. It pushes two synthetic messages (the MEMORY.md `read_file` call + result) directly onto the in-memory `history` array (`skill-memory.ts:110/114`) and **does not** call `persistInbound`/`appendMessages`, and does not set `injected: true`. Pre-Phase-54 this was fine because `history` was long-lived, so the injected MEMORY content survived for the agent's whole life. After Phase 54, `loopIteration` rebuilds `history` from the DB on every pass (`:766`); since the MEMORY messages were never persisted, they **vanish after the first loop park/reload**. The skill's persistent state silently drops out of the agent's context mid-conversation — a regression the refactor did not account for. (It is re-injected only if the agent happens to re-read SKILL.md.)

**Fix:**
Persist the synthetic MEMORY messages so they survive the reload, matching every other system-injected message in this phase. Either have the `appendMessage` callback persist whatever `injectSkillMemory` appended (capture the array length before/after and `appendMessages` the new tail with `injected: true`), or move MEMORY injection to a persist-then-reload site. The synthetic messages must also carry `injected: true` so the `hasCalledTool` completion guard (`:944`) does not misclassify them as genuine tool calls.

### WR-02: Budget-windowed history can start on an orphaned tool_result — only the Anthropic provider repairs it

**File:** `src/db/agents.ts:323-335` (windowing), consumed at `src/sub-agents/local.ts:766`
**Issue:**
`getHistoryWithinBudget` truncates by token budget at an arbitrary message boundary, so the returned window can begin with a `tool_result` whose paired `tool_call` was dropped (or end with a `tool_call` whose `tool_result` was dropped). Only `src/llm/anthropic.ts:11` (`sanitizeMessages`) strips such orphans. `src/llm/openai.ts:52-60` emits a bare `role:'tool'` message with no preceding `tool_calls`, and `src/llm/gemini.ts:43-49` emits a dangling `functionResponse` — both are 400-class API rejections, which would fail the sub-agent run. This is a latent risk the head's `getRecent` already carries, but Phase 54 newly extends the same windowing to sub-agents at a frequently-hit threshold, so a long-running sub-agent on a non-Anthropic provider can now hard-fail where it previously passed the full/compacted history.

**Fix:**
Either hoist orphan sanitization out of `anthropic.ts` into a provider-agnostic step (e.g. in the router or in `getHistoryWithinBudget` itself, dropping a leading orphan `tool_result` / trailing orphan `tool_call` after windowing), or have `getHistoryWithinBudget` snap the window boundary to a complete tool-call/tool-result group so it never splits a pair. Fixing BL-01 (so windowing happens on already-compacted history at a higher budget) reduces but does not eliminate this exposure.

### WR-03: `update()` PATH C and the deprecated `signal()` can start a second loop without abort-isolating the prior one

**File:** `src/sub-agents/local.ts:259-267` (PATH B/C), `:274-285` (`signal`), `:408-446` (`resumeSuspended`)
**Issue:**
`resumeSuspended` unconditionally installs a fresh `EventEmitter` and `AbortController` into `this.emitters`/`this.abortControllers` (`:431-434`) and starts a new `runLoopFrom` task. PATH C is only reached when `this.emitters.get(agentId)` is currently absent, which normally means the prior loop already settled — but the `.finally` cleanup that deletes the emitter (`:439-443`) runs **after** the loop's terminal work, and `update()`/`signal()` read the map synchronously. Under concurrent `update()` calls (or an `update()` racing a just-parking loop), it is possible to overwrite a live emitter/abortController reference, orphaning the prior loop's abort handle so `retract()` can no longer preempt it. This is a pre-existing structural pattern that Phase 54 leaves intact, but the unified-resume refactor increases how often `resumeSuspended` is the chosen path, so it is worth hardening here.

**Fix:**
Before installing a new emitter/abortController in `resumeSuspended`, assert `!this.emitters.has(agentId)` (or `await` the prior `this.tasks.get(agentId)` to settle), so a resume can never silently displace a live loop's abort handle. At minimum, guard with a log/throw on the unexpected "emitter already present" case to surface the race.

## Info

### IN-01: Dead in-memory `history` array in `runLoop`

**File:** `src/sub-agents/local.ts:484` (declared), pushed at `:496`, `:519`, `:582`, `:584`
**Issue:**
`runLoop` still declares `const history: Message[] = []` and pushes the MCP-warning / task / skill messages onto it, but the array is no longer passed to `runLoopFrom` (the `history` parameter was removed in this phase) — `runLoopFrom` reloads from the DB. The persistence (`persistInbound`) is what now matters; the four `history.push(...)` calls are dead writes that will mislead a future maintainer into thinking the array is consumed.
**Fix:** Drop the `const history` declaration and the four `history.push(...)` calls in `runLoop`, keeping only the `persistInbound` calls.

### IN-02: `getHistoryWithinBudget` is documented as mirroring `MessageStore.getRecent` but uses a semantically different budget

**File:** `src/db/agents.ts:322`
**Issue:**
The JSDoc says it "Mirrors MessageStore.getRecent," which is accurate for the *iteration mechanics* but glosses over the fact that its caller passes `archivalThreshold` (a summarization trigger) rather than a context-window budget like the head. Given BL-01, the doc invites the same conflation that caused the bug.
**Fix:** Once BL-01 is resolved, clarify in the JSDoc what budget callers are expected to pass (context-window-derived, distinct from the archival/compaction threshold).

---

_Reviewed: 2026-06-22T04:05:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
