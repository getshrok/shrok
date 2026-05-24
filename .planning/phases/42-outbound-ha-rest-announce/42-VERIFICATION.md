---
phase: 42-outbound-ha-rest-announce
verified: 2026-05-24T09:42:00Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
---

# Phase 42: Outbound HA REST Announce — Verification Report

**Phase Goal:** Shrok speaks on the configured Home Assistant satellite device for background events — when `home-assistant` is the active channel and no live turn is open, async results are delivered via `assist_satellite.announce` or `start_conversation`
**Verified:** 2026-05-24T09:42:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth                                                                                                                | Status      | Evidence                                                                                                                                                              |
|----|----------------------------------------------------------------------------------------------------------------------|-------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | When pendingReply === null, adapter.send() calls HA REST POST /api/services/assist_satellite/announce targeting the configured satellite entity | ✓ VERIFIED | `adapter.ts:91` calls `announceOrStartConversation(text)`; `adapter.ts:110` builds `${haBaseUrl}/api/services/assist_satellite/${service}`. Block D case 1 asserts the exact URL. |
| 2  | A fast error (HA unreachable / 4xx / 5xx) makes send() throw so ChannelRouterImpl retries once and cross-channel falls back | ✓ VERIFIED | `adapter.ts:137` rethrows all non-AbortError errors. Block D cases 5 and 6 assert `rejects.toThrow(/HTTP 404/)` and `/HTTP 500/`. `router.ts:22-41` implements retry + cross-channel fallback. |
| 3  | A 30s playback timeout makes send() resolve (log-and-continue) — does NOT throw, does NOT re-announce               | ✓ VERIFIED | `adapter.ts:129-135`: AbortError catch logs `log.warn` + returns (no throw, no retry). `ANNOUNCE_TIMEOUT_MS = 30_000` at adapter.ts:8. Block D case 7 asserts `resolves.toBeUndefined()` with `mockFetch` called exactly once. |
| 4  | The start_conversation variant exists as a parameterized branch but is NOT auto-selected — announce is the only live auto-trigger | ✓ VERIFIED | `adapter.ts:109`: `const service = wantsReply ? 'start_conversation' : 'announce'`. `send()` at adapter.ts:91 calls `announceOrStartConversation(text)` with no `wantsReply` arg (defaults false). Block D case 9 asserts URL ends in `/announce` not `/start_conversation`. |
| 5  | The Authorization: Bearer header value never appears in any log.* output                                            | ✓ VERIFIED | grep `log\.(info\|warn\|error\|debug)\(.*Bearer` on adapter.ts returns 0 matches. `log.info` at adapter.ts:128 logs only `service` name and `text.length`. Block D case 4 spies on console.warn/info/error and asserts no arg contains the raw token. |
| 6  | HA_ACCESS_TOKEN is registered via extractSecretValues() so it is masked [REDACTED] in all log output                | ✓ VERIFIED | `config.ts:408-411`: home-assistant switch case reads `process.env['HA_ACCESS_TOKEN']` and pushes into candidates. `index.ts:95`: `registerSecrets(extractSecretValues(config))`. The `case 'home-assistant': break` stub is gone (grep returns 0). config.test.ts D-05 describe pins 5 cases. |
| 7  | index.ts constructs HomeAssistantChannelAdapter with haBaseUrl + haVoiceSatelliteEntityId from channel config       | ✓ VERIFIED | `index.ts:328`: `new HomeAssistantChannelAdapter(ch.id, head.id, ch)` — `ch` is narrowed to the home-assistant union member carrying both fields. Constructor signature: `(id, headId, config: HAConfig = {...})`. |

**Score:** 7/7 truths verified

### Deferred Items

None.

### Required Artifacts

| Artifact                                             | Expected                                                   | Status     | Details                                                                                                                              |
|------------------------------------------------------|------------------------------------------------------------|------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `src/config.ts`                                      | extractSecretValues() home-assistant case pushes env token  | ✓ VERIFIED | Lines 408-411 push `process.env['HA_ACCESS_TOKEN']` via candidates gate. HA_ACCESS_TOKEN appears twice: line 409 and line 514 (ENV_KEY_ALLOWLIST). |
| `src/config.test.ts`                                 | Test pinning HA token extraction for redaction              | ✓ VERIFIED | `describe('extractSecretValues — home-assistant HA_ACCESS_TOKEN (D-05)')` with 5 tests covering present, absent, no-HA-channel, no-throw, no-undefined cases. |
| `src/channels/home-assistant/adapter.ts`             | announceOrStartConversation() + send() null-branch wiring  | ✓ VERIFIED | `assist_satellite` in REST URL at line 110. `announceOrStartConversation` at lines 91 (call) and 104 (definition). `ANNOUNCE_TIMEOUT_MS = 30_000` at line 8. |
| `src/channels/home-assistant/adapter.test.ts`        | Block D tests with stubGlobal fetch mock                    | ✓ VERIFIED | Block D (lines 388-549) covers all 9 required cases. `vi.stubGlobal('fetch', mockFetch)` appears 5 times. Stale "until Phase 42" assertion absent (grep returns 0). |
| `src/index.ts`                                       | HomeAssistantChannelAdapter construction with channel config | ✓ VERIFIED | Line 328: `new HomeAssistantChannelAdapter(ch.id, head.id, ch)`. |

### Key Link Verification

| From                                                       | To                                                          | Via                                       | Status     | Details                                                                                                     |
|------------------------------------------------------------|-------------------------------------------------------------|-------------------------------------------|------------|-------------------------------------------------------------------------------------------------------------|
| `adapter.ts send() (pendingReply === null)`                | `HA REST /api/services/assist_satellite/announce`           | Node built-in fetch + AbortController 30s | ✓ WIRED    | `adapter.ts:91` → `adapter.ts:104-141`. URL built at line 110, fetch at line 116, AbortController at lines 113-114. |
| `adapter.ts announceOrStartConversation throw`            | `ChannelRouterImpl.send()` catch (retry + cross-channel fallback) | thrown Error on !res.ok / network error  | ✓ WIRED    | `adapter.ts:137`: `throw err`. `router.ts:22-41`: catch → 2s wait → retry → cross-channel fallback.       |
| `src/index.ts construction site`                          | `HomeAssistantChannelAdapter constructor`                   | `new HomeAssistantChannelAdapter(ch.id, head.id, ch)` | ✓ WIRED    | `index.ts:328` passes narrowed `ch` (union member) with `haBaseUrl` and `haVoiceSatelliteEntityId` fields. |

### Data-Flow Trace (Level 4)

Adapter is not a rendering component — it is a channel I/O adapter. Data flows from the activation loop through `ChannelRouterImpl.send()` → `adapter.send()` → `announceOrStartConversation()` → HA REST. The test suite verifies the full call path via mocked fetch. Level 4 trace N/A for this artifact type.

### Behavioral Spot-Checks

| Behavior                                     | Command                                                                                      | Result         | Status  |
|----------------------------------------------|----------------------------------------------------------------------------------------------|----------------|---------|
| tsc --noEmit clean                           | `npx tsc --noEmit`                                                                           | exit 0, no output | ✓ PASS |
| config.test.ts all pass                      | `npx vitest run src/config.test.ts`                                                          | 57/57 tests pass  | ✓ PASS |
| adapter + router + types test suites all pass | `npx vitest run src/channels/home-assistant/`                                                | 67/67 tests pass  | ✓ PASS |
| Full targeted suite                          | `npx vitest run src/config.test.ts src/channels/home-assistant/`                             | 124/124 tests pass | ✓ PASS |

### Probe Execution

No probe scripts declared or applicable for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description                                                                                                  | Status      | Evidence                                                                                                        |
|-------------|-------------|--------------------------------------------------------------------------------------------------------------|-------------|-----------------------------------------------------------------------------------------------------------------|
| HAAN-01     | 42-01, 42-02 | Background results on home-assistant channel with no live turn spoken via assist_satellite.announce           | ✓ SATISFIED | `adapter.ts:83-92`: pendingReply === null → `announceOrStartConversation(text)` → POST /api/services/assist_satellite/announce |
| HAAN-02     | 42-02       | Outbound HA calls are fire-and-forget with 30s timeout — stuck satellite never hangs activation loop          | ✓ SATISFIED | `ANNOUNCE_TIMEOUT_MS = 30_000`; AbortError catch logs + returns (no throw); Block D case 7 pins resolve-on-timeout |
| HAAN-03     | 42-02       | start_conversation is the parameterized variant — present but not auto-selected; announce is the only live trigger | ✓ SATISFIED | `wantsReply ? 'start_conversation' : 'announce'` at adapter.ts:109; send() always passes wantsReply=false (default) |

All three phase requirements are satisfied. No orphaned requirements found.

### Anti-Patterns Found

| File                                         | Line | Pattern                       | Severity  | Impact    |
|----------------------------------------------|------|-------------------------------|-----------|-----------|
| None                                         | —    | —                             | —         | —         |

Grep checks performed:
- `TBD|FIXME|XXX` in adapter.ts: 0 matches
- `TODO|HACK|PLACEHOLDER` in adapter.ts: 0 matches
- `until Phase 42` in adapter.ts: 0 matches (stale stub fully removed)
- `log.*Bearer|log.*HA_ACCESS_TOKEN` in adapter.ts: 0 matches
- `case 'home-assistant': break` in config.ts: 0 matches (D-05 implemented)

### Human Verification Required

None. All must-haves are verifiable programmatically via static analysis and test results.

### Gaps Summary

No gaps. All 7 observable truths are VERIFIED, all artifacts are substantive and wired, all key links exist in code, all 3 requirement IDs (HAAN-01, HAAN-02, HAAN-03) are satisfied, tsc is clean, and 124 tests pass.

---

_Verified: 2026-05-24T09:42:00Z_
_Verifier: Claude (gsd-verifier)_
