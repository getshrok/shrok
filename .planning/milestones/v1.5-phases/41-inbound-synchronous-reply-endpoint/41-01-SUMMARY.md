---
phase: 41-inbound-synchronous-reply-endpoint
plan: "01"
subsystem: home-assistant
tags: [home-assistant, openai-compat, config, env-allowlist]
dependency_graph:
  requires: []
  provides:
    - extractLastUserTurn (src/channels/home-assistant/types.ts)
    - buildChatCompletionResponse (src/channels/home-assistant/types.ts)
    - HA_INBOUND_API_KEY in ENV_KEY_ALLOWLIST (src/config.ts)
  affects:
    - src/channels/home-assistant/router.ts (Plan 03 — imports extractLastUserTurn + buildChatCompletionResponse)
    - src/channels/home-assistant/adapter.ts (Plan 02 — fail-fast boot check reads ENV_KEY_ALLOWLIST)
tech_stack:
  added: []
  patterns:
    - noUncheckedIndexedAccess optional-chaining guard in reverse-scan loop
    - ChatCompletion type-only import for shape checking (zero runtime cost)
    - node:crypto randomUUID for chatcmpl- id generation
key_files:
  created:
    - src/channels/home-assistant/types.ts
    - src/channels/home-assistant/types.test.ts
  modified:
    - src/config.ts
    - src/config.test.ts
decisions:
  - "Return type of buildChatCompletionResponse is Record<string,unknown> to avoid a breaking ChatCompletion cast; uses double cast (as unknown as Record<string,unknown>) after satisfying the TypeScript type checker via ChatCompletion & {conversation_id:string} intermediate"
  - "HA_INBOUND_API_KEY placed immediately after HA_ACCESS_TOKEN grouping the two HA keys together per PATTERNS.md §config.ts"
metrics:
  duration: 4min
  completed: "2026-05-24T11:46:19Z"
  tasks: 2
  files: 4
---

# Phase 41 Plan 01: Types and Config Foundation Summary

**One-liner:** Pure-function OpenAI-compat helpers (`extractLastUserTurn` + `buildChatCompletionResponse`) with `HA_INBOUND_API_KEY` registered to `ENV_KEY_ALLOWLIST` for inbound bearer-key auth.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (TDD RED) | Failing tests for types.ts | cbe8ce0 | src/channels/home-assistant/types.test.ts |
| 1 (TDD GREEN) | Implement extractLastUserTurn + buildChatCompletionResponse | 09da365 | src/channels/home-assistant/types.ts |
| 2 | Add HA_INBOUND_API_KEY to allowlist + config tests | 2c722a8 | src/config.ts, src/config.test.ts |

## Verification

- `npx vitest run src/channels/home-assistant/types.test.ts`: 19/19 passing
- `npx vitest run src/config.test.ts`: 52/52 passing (includes 2 new HA_INBOUND_API_KEY tests)
- `npx tsc --noEmit`: clean (no new errors)
- `grep -c "export function extractLastUserTurn\|export function buildChatCompletionResponse" src/channels/home-assistant/types.ts`: 2
- `grep -c "from 'express'" src/channels/home-assistant/types.ts`: 0
- `grep -c "conversation_id: conversationId" src/channels/home-assistant/types.ts`: 1
- `grep -c "'HA_INBOUND_API_KEY'" src/config.ts`: 1
- `grep -v '^//' src/config.ts | grep -c "haInboundApiKey"`: 0 (env-only, no ChannelConfigSchema field)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript cast error in buildChatCompletionResponse**
- **Found during:** Task 1 GREEN phase (tsc --noEmit)
- **Issue:** `ChatCompletion & { conversation_id: string }` does not directly cast to `Record<string, unknown>` — tsc error TS2352 "neither type sufficiently overlaps"
- **Fix:** Added intermediate double-cast `as unknown as Record<string, unknown>` to satisfy tsc
- **Files modified:** src/channels/home-assistant/types.ts (line 74)
- **Commit:** 09da365 (included in the GREEN commit)

**2. [Worktree path drift] Accidental writes to main repo**
- **Found during:** Task 1 RED phase
- **Issue:** Shell cwd defaulted to `/home/thenasty/shrok/` (main repo) instead of the worktree; first test file write and git commit landed on `main` branch
- **Fix:** Identified the worktree path, reset the accidental main-branch commit with `git reset HEAD~1 --soft`, deleted the stale file, and rewrote all files to the correct worktree path `/home/thenasty/shrok/.claude/worktrees/agent-a3201fcbdc7e6e2a6/`
- **No code change** — administrative recovery only; no plan artifacts were affected

## Known Stubs

None — this plan creates pure-function utilities with no stubs or placeholder values.

## Threat Flags

No new security-relevant surface introduced. The `HA_INBOUND_API_KEY` entry in `ENV_KEY_ALLOWLIST` is the planned T-41-01 mitigation: key stays in `.env` only, never in git-tracked `config.json`, and no `haInboundApiKey` field was added to `ChannelConfigSchema` or `ConfigSchema` (acceptance criterion verified: grep returns 0).

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/channels/home-assistant/types.ts | FOUND |
| src/channels/home-assistant/types.test.ts | FOUND |
| Commit cbe8ce0 (TDD RED) | FOUND |
| Commit 09da365 (TDD GREEN) | FOUND |
| Commit 2c722a8 (config) | FOUND |
