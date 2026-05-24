---
phase: 42-outbound-ha-rest-announce
plan: "02"
subsystem: home-assistant-channel
tags: [home-assistant, outbound, announce, rest-api, tdd]
dependency_graph:
  requires: [42-01]
  provides: [HAAN-01, HAAN-02, HAAN-03]
  affects: [src/channels/home-assistant/adapter.ts, src/channels/home-assistant/adapter.test.ts, src/channels/home-assistant/router.test.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [AbortController-fetch-timeout, vi.stubGlobal-fetch-mock, DOMException-AbortError-signal]
key_files:
  created: []
  modified:
    - src/channels/home-assistant/adapter.ts
    - src/channels/home-assistant/adapter.test.ts
    - src/channels/home-assistant/router.test.ts
    - src/index.ts
decisions:
  - "Constructor signature: HomeAssistantChannelAdapter(id, headId, config: HAConfig = { haBaseUrl: '', haVoiceSatelliteEntityId: '' }) — safe zero-arg default for existing tests; index.ts passes ch directly (narrowed home-assistant union member)"
  - "ANNOUNCE_TIMEOUT_MS = 30_000 named module constant; AbortController timeout fires ac.abort() after 30s"
  - "D-03 throw/timeout contract: AbortError → log.warn + return (no throw); all other errors rethrow (router fallback)"
  - "D-05 redaction: token read from process.env at call-time, never concatenated into log string, never logged in options object"
  - "Case 7 timeout test: mock fetch must respect AbortController signal (addEventListener('abort')) to avoid 30s test wall-clock hang"
  - "router.test.ts HACV-04 + SC4 updated: null-slot path now calls announce; tests set HA_ACCESS_TOKEN + stub fetch for those send() calls"
metrics:
  duration: 8min
  completed: "2026-05-24"
  tasks: 2
  files: 4
---

# Phase 42 Plan 02: Outbound HA REST Announce Summary

**One-liner:** Real `assist_satellite.announce` REST call replacing the Phase-42 log-drop stub, with AbortController 30s fire-and-forget timeout, D-03 throw/resolve semantics, and 9-case Block D test suite using mocked fetch.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Config-bearing constructor + announceOrStartConversation() + send() null-branch wiring | ae2c05f | adapter.ts, index.ts |
| 2 | Block D announce tests + update stale Phase-42-seam tests | 9f16a3e | adapter.test.ts, router.test.ts |

## What Was Built

**Task 1 — adapter.ts + index.ts:**

- Added `HAConfig` interface (`{ haBaseUrl: string; haVoiceSatelliteEntityId: string }`) and `private readonly config: HAConfig` field.
- Added `ANNOUNCE_TIMEOUT_MS = 30_000` named module constant.
- Implemented `private async announceOrStartConversation(text, wantsReply = false)`:
  - Reads `HA_ACCESS_TOKEN` from `process.env` at call-time (never stored, matches D-04/Phase 40 pattern).
  - Missing token → throws a clear Error naming the env var.
  - Selects service = `wantsReply ? 'start_conversation' : 'announce'`.
  - Builds `POST {haBaseUrl}/api/services/assist_satellite/{service}` with `Authorization: Bearer ${token}` and `Content-Type: application/json` headers, body `{ entity_id, message }`.
  - AbortController + `setTimeout(() => ac.abort(), ANNOUNCE_TIMEOUT_MS)` with `clearTimeout` in `finally`.
  - AbortError catch → `log.warn` + return (no throw) — D-03/P5 fire-and-forget.
  - All other errors rethrow — router retries once, then cross-channel falls back.
  - HTTP `!res.ok` → throws `Error('[home-assistant] announce failed: HTTP ${res.status}')`.
- Replaced `pendingReply === null` log stub in `send()` with `await this.announceOrStartConversation(text)`.
- Constructor signature: `(id, headId, config: HAConfig = { haBaseUrl: '', haVoiceSatelliteEntityId: '' })` — safe default preserves zero-arg ergonomics for existing tests.
- `src/index.ts`: updated construction site to `new HomeAssistantChannelAdapter(ch.id, head.id, ch)` — `ch` is already narrowed to the home-assistant union member with `haBaseUrl` and `haVoiceSatelliteEntityId`.

**Task 2 — adapter.test.ts + router.test.ts:**

- Block D added with all 9 required cases, using `vi.stubGlobal('fetch', mockFetch)`:
  1. Correct announce URL (`POST {haBaseUrl}/api/services/assist_satellite/announce`).
  2. Correct payload (`{ entity_id, message }`).
  3. Correct headers (`Authorization: Bearer`, `Content-Type: application/json`).
  4. Redaction: no `console.warn/info/error` call receives the raw token value.
  5. HA 404 → `send()` throws.
  6. HA 500 → `send()` throws.
  7. 30s timeout → `send()` resolves to undefined, `mockFetch` called exactly once. Mock implements AbortController signal listener to avoid 30s wall-clock hang.
  8. Missing `HA_ACCESS_TOKEN` → `send()` throws naming the env var.
  9. `wantsReply=false` default → URL ends in `/announce`.
- Block A (loud-but-safe stub assertions) removed/updated — the stub behavior is gone.
- Block B (SC3) updated to set `HA_ACCESS_TOKEN` + stub fetch (the router test calls `router.send()` which hits the announce path).
- Block C null-slot tests updated to reflect announce behavior.
- `router.test.ts` HACV-04 and SC4 tests updated: after the slot is cleared, `send()` hits the announce path, not the old warn stub. Both tests now set `HA_ACCESS_TOKEN` + stub `global.fetch` and assert `mockFetch` was called once.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] router.test.ts HACV-04 and SC4 tests broken by send() behavior change**
- **Found during:** Task 2
- **Issue:** `router.test.ts` HACV-04 and SC4 tests called `fx.adapter.send()` on a cleared slot and asserted the old log-warn stub behavior (`warnSpy` called with "Phase 42" text). After Task 1, the null-slot path now calls `announceOrStartConversation()` which throws when `HA_ACCESS_TOKEN` is absent.
- **Fix:** Updated both tests to set `process.env['HA_ACCESS_TOKEN']` + stub `global.fetch` returning 200, then assert `mockFetch` was called once instead of checking for the stale warn string.
- **Files modified:** `src/channels/home-assistant/router.test.ts`
- **Commit:** 9f16a3e (bundled with Task 2)

**2. [Rule 1 - Bug] Timeout test (case 7) would hang for 30s without AbortSignal-aware mock**
- **Found during:** Task 2
- **Issue:** `vi.useFakeTimers()` + `vi.advanceTimersByTime(ANNOUNCE_TIMEOUT_MS + 100)` triggers `ac.abort()` inside the adapter, but a mock fetch returning `new Promise(() => {})` never rejects even when the signal is aborted (mock doesn't observe the signal). Result: test hung for 30s and timed out.
- **Fix:** Mock fetch implementation listens to the `AbortSignal` via `signal.addEventListener('abort', ...)` and rejects with a `DOMException('AbortError')` when the signal fires. This mirrors real Node.js fetch behavior and allows fake timers to drive the timeout path correctly.
- **Files modified:** `src/channels/home-assistant/adapter.test.ts`
- **Commit:** 9f16a3e

## Key Decisions

- Constructor config arg has a safe zero-arg default (`{ haBaseUrl: '', haVoiceSatelliteEntityId: '' }`) rather than forcing all existing tests to supply config — only tests that exercise the announce path need to supply a real config.
- `HA_ACCESS_TOKEN` is read at call-time from `process.env` (never stored in the adapter), consistent with `HA_INBOUND_API_KEY` Phase 40 D-04 pattern. This also means it can be updated in `.env` without restart.
- The `start_conversation` variant is present in `announceOrStartConversation(wantsReply=true)` but has no production caller; `send()` always passes the default `wantsReply=false`. HAAN-03 is satisfied: one parameterized mechanism, announce is the only live auto-trigger.
- No new npm dependencies: `fetch` and `AbortController` are Node 22 built-ins.

## Known Stubs

None. The Phase-42 stub has been fully replaced with the real announce implementation.

## Threat Flags

None. All STRIDE threats in the plan's threat register are mitigated by the implementation:
- T-42-01 (token disclosure): token never in log string, Block D case 4 pins the contract.
- T-42-02 (SSRF): `haBaseUrl` is operator-controlled Zod-validated config, path is a fixed literal.
- T-42-03 (DoS via hung satellite): 30s AbortController timeout, Block D case 7 pins the contract.
- T-42-04 (message loss on fast error): fast errors throw → router retries once + cross-channel fallback.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/channels/home-assistant/adapter.ts` | FOUND |
| `src/channels/home-assistant/adapter.test.ts` | FOUND |
| `src/channels/home-assistant/router.test.ts` | FOUND |
| `src/index.ts` | FOUND |
| Commit `ae2c05f` (Task 1) | FOUND |
| Commit `9f16a3e` (Task 2) | FOUND |
