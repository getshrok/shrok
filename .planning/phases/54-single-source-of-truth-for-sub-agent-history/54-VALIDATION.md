---
phase: 54
slug: single-source-of-truth-for-sub-agent-history
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-21
---

# Phase 54 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` (project root) |
| **Quick run command** | `npx vitest run src/sub-agents/agents.test.ts` |
| **Full suite command** | `npx vitest run` (6 shards on CI; single process locally) |
| **Estimated runtime** | ~10–30s for the sub-agents file; full suite is longer |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/sub-agents/agents.test.ts`
- **After every plan wave:** Run `npx vitest run` + `npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds (single test file)

---

## Per-Task Verification Map

Phase 54 has **no formal REQ-IDs** in REQUIREMENTS.md — it is an internal refactor, not a user-facing feature. CONTEXT.md specifies 7 observable behaviors that require test coverage (T1–T7). All live in `src/sub-agents/agents.test.ts` and are authored in Wave 0 (RED), then made green by the refactor waves.

| Behavior | Wave | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|----------|------|------------|-----------------|-----------|-------------------|-------------|--------|
| T1 — resume-after-idle via live-emitter path: parked agent receives `message_agent`, history DB-sourced on wake | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "resume.*emitter"` | ❌ W0 | ⬜ pending |
| T2 — resume-after-idle via `resumeSuspended` path: completed agent gets new task, history from DB, task not re-injected | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "resume.*suspended"` | ❌ W0 | ⬜ pending |
| T3 — mid-loop `message_agent` delivery: `onRoundComplete` injects; next pass loads from DB without duplication | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "mid-loop"` | ❌ W0 | ⬜ pending |
| T4 — compaction interaction: after `maybeArchiveHistory`, next pass loads summary + newer messages, not full history | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "compact"` | ❌ W0 | ⬜ pending |
| T5 — suspend→answer→continue: suspended agent gets resume answer (no `injected` flag), continues with correct history | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "suspend.*answer"` | ❌ W0 | ⬜ pending |
| T6 — restart-reaping regression: orphaned-agent reaping (`index.ts:349–358`) marks agents failed, does NOT load DB history | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "restart.*reap"` | ❌ W0 | ⬜ pending |
| T7 — anti-double-injection: after `resumeSuspended`, history contains the task message exactly once | 0 | — | N/A | unit | `npx vitest run src/sub-agents/agents.test.ts -t "double.*inject"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Regression coverage:** existing Phase 53 tests A–D (`src/sub-agents/agents.test.ts:1950–2142`) assert `agentStore.get(id)?.history` rows and must remain green after Phase 54 with no modification.

---

## Wave 0 Requirements

- [ ] `src/sub-agents/agents.test.ts` — add test cases T1–T7 after the existing Phase 53 tests
- [ ] No new test files or framework install needed — `freshDb()`, `makeRunner()`, `makeLLMRouter()`, `makeEndTurnResponse()`, `makeToolCallResponse()`, `makeStewardQuestionResponse()`, `runner.awaitAll()` already exist and are sufficient scaffolding

*Test seam: spawn an agent, drive inbox via `runner.update(...)`, assert `agentStore.get(id)?.history` from the DB, verify no duplication.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| — | — | — | — |

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (T1–T7)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
