---
phase: 40-config-adapter-skeleton
verified: 2026-05-24T06:52:30Z
status: passed
score: 9/9 must-haves verified
overrides_applied: 0
---

# Phase 40: Config + Adapter Skeleton Verification Report

**Phase Goal:** vendor: 'home-assistant' Zod config member, adapter stub registered and started at boot, HA token allowlisted to .env only, lastActiveChannel routing live for the home-assistant channel.
**Verified:** 2026-05-24T06:52:30Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | A `{ vendor: 'home-assistant', id, haBaseUrl, haVoiceSatelliteEntityId }` channel block parses without error (SC1) | VERIFIED | `z.literal('home-assistant')` member present in discriminated union (src/config.ts:53); parse-success test passes in config.test.ts:534 |
| 2  | A home-assistant block with wrong/no-domain entity id prefix throws a clear startup error (SC2) | VERIFIED | `.regex(/^assist_satellite\.[a-z0-9_]+$/, ...)` on haVoiceSatelliteEntityId (config.ts:55-58); two negative tests pass (config.test.ts:562-574) |
| 3  | A home-assistant block with malformed haBaseUrl throws a clear startup error (SC2/D-03) | VERIFIED | `haBaseUrl: z.string().url()` (config.ts:54); negative test passes (config.test.ts:577-583) |
| 4  | A home-assistant block missing haBaseUrl throws a clear startup error (SC2/D-01) | VERIFIED | No `.optional()` on haBaseUrl; negative test passes (config.test.ts:585-591) |
| 5  | A home-assistant block missing haVoiceSatelliteEntityId throws a clear startup error (SC2/D-01) | VERIFIED | No `.optional()` on haVoiceSatelliteEntityId; negative test passes (config.test.ts:593-599) |
| 6  | HA_ACCESS_TOKEN is in ENV_KEY_ALLOWLIST so config:set can write it to .env (SC1/D-04) | VERIFIED | `'HA_ACCESS_TOKEN'` at config.ts:510; explicit `expect(ENV_KEY_ALLOWLIST).toContain('HA_ACCESS_TOKEN')` test passes (config.test.ts:600-601); `haAccessToken` count in config.ts = 0 (no per-channel token field) |
| 7  | A config with NO home-assistant channel still loads unchanged (SC4) | VERIFIED | SC4 backward-compat test passes (config.test.ts:604); multi-head-startup integration tests 6/6 pass |
| 8  | HomeAssistantChannelAdapter instantiates with fixed id 'home-assistant', starts at boot, send() is loud-but-safe (SC3/D-05/D-06) | VERIFIED | `class HomeAssistantChannelAdapter implements ChannelAdapter` with `id = 'home-assistant'` default; start()/stop()/send() all resolve without throwing; send() emits one log.warn matching /Phase 42/ with no token — 12/12 adapter tests pass |
| 9  | lastActiveChannel === 'home-assistant' is stamped on outbound router.send(); inbound injectMessage alone does NOT stamp it (SC3 outbound-only contract) | VERIFIED | Block B test asserts `router.getLastActiveChannel() === null` after injectMessage, then `=== 'home-assistant'` after `router.send('home-assistant', ...)` — passes |

**Score:** 9/9 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/config.ts` | home-assistant discriminated-union member + HA_ACCESS_TOKEN allowlist + extractSecretValues no-op case | VERIFIED | `z.literal('home-assistant')` count=1; `haBaseUrl: z.string().url()` present; regex on entity id present; `case 'home-assistant': break` at line 408; `'HA_ACCESS_TOKEN'` at line 510; `haAccessToken` count=0 |
| `src/config.test.ts` | Phase 40 describe block: parse-success + 4 negatives + allowlist membership + SC4 backward-compat | VERIFIED | `describe('Phase 40 home-assistant channel vendor', ...)` at line 507; 7 tests all pass (50/50 total) |
| `src/channels/home-assistant/adapter.ts` | HomeAssistantChannelAdapter implementing ChannelAdapter, loud-but-safe send(), injectMessage test helper, zero HTTP/env | VERIFIED | 43 lines; class signature present; default id 'home-assistant'; `http_imports=0`; `env_reads=0`; injectMessage present |
| `src/index.ts` | else-if home-assistant branch + HomeAssistantChannelAdapter import, exhaustiveness guard satisfied | VERIFIED | Import at line 72; `ch.vendor === 'home-assistant'` branch at line 324; `new HomeAssistantChannelAdapter(ch.id, head.id)` at line 325; `_exhaustive: never` guard updated to six vendors at line 329 |
| `src/channels/home-assistant/adapter.test.ts` | Block A (contract + send()) + Block B (SC3 lastActiveChannel cycle) | VERIFIED | 12 tests, all pass; `getLastActiveChannel` assertion present in Block B |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/config.ts ChannelConfigSchema` | `z.discriminatedUnion('vendor')` | new union member | WIRED | `vendor: z.literal('home-assistant')` confirmed at config.ts:53 |
| `src/config.ts ENV_KEY_ALLOWLIST` | `'HA_ACCESS_TOKEN'` | array append | WIRED | Confirmed at config.ts:510; test asserts membership explicitly |
| `src/index.ts per-head loop` | `HomeAssistantChannelAdapter` | `else if` branch constructs adapter, then `onMessage(headRouteMessage)` → `headRouter.register` → `start()` | WIRED | Branch at lines 324-326; shared try-block wiring at lines 333-336 applies unchanged |
| `adapter.injectMessage()` | `ChannelRouterImpl.lastActiveChannel` | handler → `router.send('home-assistant', ...)` stamps lastActiveChannel on outbound | WIRED | Block B test proves the outbound-only stamp mechanism end-to-end |

---

### Data-Flow Trace (Level 4)

Not applicable — no dynamic data rendering. This phase produces config parsing (synchronous Zod validation) and a skeleton adapter stub. No component renders DB-sourced data.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| tsc exits 0 (exhaustiveness guard satisfied for all six vendors) | `npx tsc --noEmit` | exit 0, no output | PASS |
| config.test.ts Phase 40 block all green | `npx vitest run src/config.test.ts` | 50/50 tests pass | PASS |
| adapter.test.ts all green (contract + SC3) | `npx vitest run src/channels/home-assistant/adapter.test.ts` | 12/12 tests pass | PASS |
| SC4 backward-compat: multi-head-startup integration | `npx vitest run tests/integration/multi-head-startup.test.ts` | 6/6 tests pass | PASS |

---

### Probe Execution

No probe scripts declared or found for this phase. Behavioral spot-checks above serve as the equivalent empirical gate.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| HACF-01 | 40-01 | Operator configures HA base URL + long-lived token (`.env` only, not `config.json`) + satellite `entity_id` | SATISFIED | `haBaseUrl: z.string().url()` + `haVoiceSatelliteEntityId` with assist_satellite. regex in union member; `'HA_ACCESS_TOKEN'` in ENV_KEY_ALLOWLIST; no `haAccessToken` field in schema; `haAccessToken` count=0 in config.ts |
| HACF-02 | 40-01, 40-02 | `home-assistant` is a configurable channel vendor in Zod discriminated union; started at boot like every other adapter; invalid/missing config fails with clear startup error including entity_id shape validation | SATISFIED | Union member present; `else if (ch.vendor === 'home-assistant')` branch in index.ts per-head loop calls `adapter.start()`; four negative tests all throw /Configuration error/ |

Both requirements marked `[x]` (Complete) in REQUIREMENTS.md traceability table.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/channels/home-assistant/adapter.ts` | 29 | `send()` logs and returns without doing real work | INFO (intentional) | Documented skeleton stub (D-05); Phase 42 wires real outbound. Not a gap. |
| `src/channels/home-assistant/adapter.ts` | 20-22 | `start()` near-noop | INFO (intentional) | Phase 41 wires the HTTP listener. Not a gap. |

No TBD/FIXME/XXX markers found in any phase-40 modified files. No unreferenced debt markers. No blocking anti-patterns.

---

### Human Verification Required

None. All must-haves are verifiable programmatically and confirmed via test runs and source inspection.

---

### Gaps Summary

No gaps. All 9 must-have truths are VERIFIED against the live codebase:

- The home-assistant Zod discriminated-union member exists in `src/config.ts` with the required fields (`haBaseUrl: z.string().url()`, `haVoiceSatelliteEntityId` with strict `assist_satellite.` regex), no `haAccessToken` field.
- `'HA_ACCESS_TOKEN'` is present in `ENV_KEY_ALLOWLIST` and absent from config.json schema fields.
- `extractSecretValues` has a no-op `case 'home-assistant': break` (token is not a per-channel field).
- `HomeAssistantChannelAdapter` implements `ChannelAdapter` with a loud-but-safe `send()`, zero HTTP/env reads, and an `injectMessage` test helper.
- The `else if (ch.vendor === 'home-assistant')` branch is wired in `src/index.ts` with the correct construction and shared `onMessage` → `register` → `start()` path.
- `npx tsc --noEmit` exits 0 (exhaustiveness guard satisfied for all six vendors).
- All 62 relevant tests pass (50 config + 12 adapter).
- SC4 backward-compat: 6/6 multi-head-startup integration tests pass.

---

_Verified: 2026-05-24T06:52:30Z_
_Verifier: Claude (gsd-verifier)_
