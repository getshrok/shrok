---
phase: 42-outbound-ha-rest-announce
reviewed: 2026-05-24T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - src/config.ts
  - src/config.test.ts
  - src/channels/home-assistant/adapter.ts
  - src/channels/home-assistant/adapter.test.ts
  - src/channels/home-assistant/router.test.ts
  - src/index.ts
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 42: Code Review Report

**Reviewed:** 2026-05-24T00:00:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Phase 42 adds (a) `HA_ACCESS_TOKEN` log-redaction registration in `extractSecretValues()`
(`src/config.ts`) and (b) a real `assist_satellite.announce` REST caller
(`announceOrStartConversation`) in the home-assistant adapter, replacing the prior
log-and-drop stub, with a 30s `AbortController` fire-and-forget timeout.

The core security requirement is **met**: the `HA_ACCESS_TOKEN` value is interpolated
only into the `Authorization: Bearer` header, never into a `log.*` call or a thrown
`Error` message. `extractSecretValues` + `registerSecrets` provide a redaction net as
defense-in-depth. The throw-vs-resolve semantics (D-03: fast errors throw → router
retry + cross-channel fallback; 30s timeout logs-and-continues, no throw) are
implemented correctly. TypeScript compiles clean under `noUncheckedIndexedAccess` /
`exactOptionalPropertyTypes`. No BLOCKERs.

The findings below are robustness and correctness gaps. The most material are the
post-boot redaction-net gap (WR-01), the trailing-slash URL hazard (WR-02), the
fragile name-only AbortError check (WR-03), and the fast-error double-announce
hazard on router retry (WR-05).

## Warnings

### WR-01: Redaction net registered once at startup — token set/rotated after boot is never redacted

**File:** `src/index.ts:95` (with `src/config.ts:409`, `src/index.ts:576-739`)
**Issue:** `registerSecrets(extractSecretValues(config))` runs once at startup, reading
`HA_ACCESS_TOKEN` from `process.env` at that instant. The five hot-reload blocks call
`loadEnvFile(true)` to pick up vars written by `config:set`, but never re-run
`registerSecrets`. Since `HA_ACCESS_TOKEN` is in `ENV_KEY_ALLOWLIST` (`src/config.ts:514`),
it can be set/rotated via `config:set` after boot — and the new value would bypass the
redaction net. The adapter never logs the token directly, so this is a defense-in-depth
gap, not an immediate leak, but it silently weakens the stated D-05 guarantee.
**Fix:**
```ts
// after each loadEnvFile(true) in the hot-reload blocks, or in a shared env-reload hook:
registerSecrets(extractSecretValues(loadConfig()))
```

### WR-02: `haBaseUrl` with a trailing slash produces a malformed double-slash URL

**File:** `src/channels/home-assistant/adapter.ts:110`
**Issue:** `` `${this.config.haBaseUrl}/api/services/...` `` assumes no trailing slash, but
the Zod validator is only `z.string().url()` (`src/config.ts:54`), which accepts
`http://homeassistant.local:8123/`. That yields `...8123//api/services/...`. Some
reverse proxies / HA setups 404 on double-slash paths; the adapter then throws
`HTTP 404`, triggering router retry + cross-channel fallback for what is really a config
typo.
**Fix:**
```ts
const base = this.config.haBaseUrl.replace(/\/+$/, '')
const url = `${base}/api/services/assist_satellite/${service}`
```

### WR-03: AbortError detection is name-only and narrower than the codebase's own helper

**File:** `src/channels/home-assistant/adapter.ts:130`
**Issue:** `if ((err as Error).name === 'AbortError')`. The sibling voice channel already
solved this with `isAbortError()` (`src/channels/voice/tts.ts:19-22`), which checks
multiple names and notes "Some runtime ... throws APIUserAbortError." For native Node
`fetch` the abort surfaces as a `DOMException` named `AbortError`, so this works today,
but it is fragile: a wrapper / polyfill / `cause`-wrapped error would fail the name
check, fall through to `throw err`, and convert a benign 30s timeout into a router retry
+ double-announce — exactly the double-delivery D-03 says to avoid. Separately,
`(err as Error).name` throws if `err` is a non-object thrown value.
**Fix:** reuse/extract a shared `isAbortError(err)` helper and guard the cast:
```ts
if (err instanceof Error && isAbortError(err)) { /* timeout: log.warn + return */ }
```

### WR-04: `start_conversation` branch silently discards the satellite's reply (latent bug)

**File:** `src/channels/home-assistant/adapter.ts:104-141`
**Issue:** The `wantsReply` parameter selects `start_conversation`, whose purpose is to
capture a spoken reply — but the method returns `void` and never reads the response body
beyond the `res.ok` check. Today the only caller (`send()`, line 91) uses the default
`announce`, so the reply path is dead-but-reachable. The first future caller that passes
`wantsReply=true` gets a silently-dropped reply with no compile-time signal.
**Fix:** Either drop the unused `wantsReply` parameter until reply capture is wired, or
change the return type so the `start_conversation` reply is surfaced (making the gap
type-visible).

### WR-05: `send()` re-fires a full announce on router retry — double-delivery on transient fast errors

**File:** `src/channels/router.ts:19-31` (driving `src/channels/home-assistant/adapter.ts:91`)
**Issue:** The router catches a thrown fast error and retries `adapter.send()` after 2s.
Each null-slot `send()` issues a fresh `assist_satellite.announce`. A 4xx/5xx where HA
*did* accept and speak the message (or a network error after the request reached HA)
causes the satellite to announce the same message twice. The 30s-timeout case is
correctly guarded (resolves, no retry), but the fast-error path has no equivalent
protection — the same double-delivery hazard the timeout branch explicitly avoids is
left unhandled on the error branch.
**Fix:** Document the at-least-once delivery contract explicitly, or make the announce
non-retryable at the router for this adapter (cross-channel fallback already covers true
outages).

## Info

### IN-01: Duplicate HA token pushed into the secret list once per home-assistant channel

**File:** `src/config.ts:408-412`
**Issue:** The `home-assistant` case reads the global `HA_ACCESS_TOKEN` inside the
per-channel loop, so N HA channels append the same token N times to `out`. Harmless but
causes redundant `replaceAll` passes per log line in `redact()`.
**Fix:** Dedup `out` before returning, or read the global token once outside the channel
loop.

### IN-02: Sub-8-char HA token is silently never redacted

**File:** `src/config.ts:415`, `src/logger.ts:33`
**Issue:** Both sites drop secrets shorter than 8 chars. Real HA long-lived tokens are
JWTs (far longer), so not a practical risk, but a short/test token would silently bypass
redaction with no warning.
**Fix:** Consider lowering/removing the floor for explicitly-registered credentials.

### IN-03: Redaction test (case 4) is vacuously true — spies on `console.*`, not the file sink, on a path that never logs the token

**File:** `src/channels/home-assistant/adapter.test.ts:455-476`
**Issue:** Case 4 spies only on `console.warn/info/error` and runs the happy path, where
the adapter never passes the token to any log call — so the assertion passes without
exercising redaction. The logger also writes to a file stream (`src/logger.ts:19-24`),
which is not checked. The test name overstates what is verified.
**Fix:** Force a log line that contains the token through the real `log` +
`registerSecrets` path to prove end-to-end redaction, and/or assert on the file sink.

---

_Reviewed: 2026-05-24T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
