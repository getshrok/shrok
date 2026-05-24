---
phase: 41-inbound-synchronous-reply-endpoint
verified: 2026-05-24T08:50:00Z
status: passed
score: 12/12 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 11/12
  gaps_closed:
    - "Router auth boundary self-contained (no reliance on upstream caller for key validation)"
  gaps_remaining: []
  regressions: []
---

# Phase 41: Inbound Synchronous Reply Endpoint Verification Report

**Phase Goal:** Home Assistant can send a conversation turn to Shrok via `/v1/chat/completions` and receive an OpenAI-compatible acknowledgment reply within the 5-second device timeout — the held-connection contract is fully established.
**Verified:** 2026-05-24T08:50:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (commit 77fe6e3, CR-01 fix)

---

## Re-verification Summary

The prior verification (2026-05-24T08:40:00Z) returned `human_needed` with a single gap: Truth 12 (router auth self-contained, CR-01). Commit `77fe6e3` ("fix(41): make /v1 router a self-contained auth boundary (CR-01)") applied the fix. This re-verification confirms:

1. The fix is real in the codebase (not just claimed in a SUMMARY).
2. All three changes from the fix specification are present in the actual code.
3. `npx tsc --noEmit` exits clean (no output).
4. `npx vitest run src/channels/home-assistant/` passes 62/62 tests including the new CR-01 regression test.
5. No regressions in the 11 previously-verified truths.

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|--- |-------|--------|---------|
| 1  | POST /v1/chat/completions returns an OpenAI-compat body when head replies in-deadline | VERIFIED | router.ts returns `buildChatCompletionResponse(text, conversationId)`; HACV-01 tests: 200 + choices/finish_reason/usage confirmed; 4/4 HACV-01 tests pass |
| 2  | Missing/invalid bearer token returns a JSON 401 with no WWW-Authenticate header | VERIFIED | router.ts line 38: `if (!inboundApiKey \|\| !auth?.startsWith('Bearer ') \|\| auth.slice(7) !== inboundApiKey)` — empty key rejects ALL; no WWW-Authenticate set; 4/4 HACV-02 tests pass including CR-01 regression |
| 3  | Only the last role:'user' turn is extracted; no user turn → 400 | VERIFIED | `extractLastUserTurn` reverse-scans messages[]; router returns 400 if null; HACV-03 tests cover multi-turn history and empty array |
| 4  | Deadline lapse produces no response body (D-01 — no filler ack) | VERIFIED | catch branch on 'HA turn deadline lapsed' explicitly does NOT call res.json/res.end; HACV-04/D-01 test confirms slot cleared |
| 5  | conversation_id echoed from request; generated server-side UUID when absent | VERIFIED | router.ts lines 61-71; HACV-05 tests confirm echo and UUID-shaped generation |
| 6  | /v1/* is excluded from CSRF/same-origin middleware (HACV-06) | VERIFIED | server.ts line 154: `if (req.path.startsWith('/v1/')) return next()` placed before `requireSameOrigin` on line 155 |
| 7  | Adapter holds at most one pendingReply slot; concurrent turn replaces prior (D-04 latest wins) | VERIFIED | adapter.ts setPendingReply clears prior timer + rejects prior promise; D-04 tests in router.test.ts + adapter.test.ts Block C |
| 8  | req close event clears slot and timer (SC4 — no dangling reference) | VERIFIED | res.on('close') in router.ts lines 81-85 calls adapter.clearPendingReply(); SC4 test in router.test.ts confirms null-slot path after abort |
| 9  | Constructor fails fast when HA_INBOUND_API_KEY is absent (D-02 boot fail-fast) | VERIFIED | adapter.ts lines 22-28; Block C constructor fail-fast tests confirm throw on absent/empty key |
| 10 | HA_INBOUND_API_KEY is in ENV_KEY_ALLOWLIST, env-only, distinct from HA_ACCESS_TOKEN | VERIFIED | config.ts line 511; config.test.ts contains HA_INBOUND_API_KEY assertions; no haInboundApiKey ChannelConfigSchema field |
| 11 | Apache /v1 auth-bypass snippet captured in docs (NOT applied — D-03/HADOC-01) | VERIFIED | docs/internals/channel-integrations.md lines 116-119 contain `<Location "/v1/">` block with clear "RECORDED, NOT APPLIED — Phase 43" note |
| 12 | Router auth boundary self-contained (no reliance on upstream caller for key validation) | VERIFIED | router.ts line 38: `!inboundApiKey` guard rejects all requests when key is empty; server.ts lines 282-290: `?? ''` fallback dropped, `/v1` is not mounted at all when env var is absent/empty; CR-01 regression test (router.test.ts line 209) asserts 401 for empty-key router + empty-token Bearer |

**Score:** 12/12 truths verified

---

### CR-01 Fix Verification (Previously FAILED Truth 12)

Three specific code changes were required by the fix. All three are confirmed present in the live code:

**1. router.ts line 38 — empty configured key guard:**
```
if (!inboundApiKey || !auth?.startsWith('Bearer ') || auth.slice(7) !== inboundApiKey)
```
The `!inboundApiKey` prefix rejects ALL requests when the router is constructed with an empty key, independent of the presented Bearer value.

**2. server.ts lines 282-290 — `?? ''` fallback dropped, conditional mount:**
```typescript
const haInboundApiKey = process.env['HA_INBOUND_API_KEY']
if (haInboundApiKey) {
  for (const haAdapter of this.opts.homeAssistantAdapters) {
    app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))
  }
}
```
The `/v1` router is not mounted at all when `HA_INBOUND_API_KEY` is unset or empty. The `?? ''` fallback is gone.

**3. router.test.ts line 209 — CR-01 regression test:**
Test "CR-01: empty configured key rejects `Authorization: Bearer ` (empty token) — self-contained auth boundary" constructs a router with `createHomeAssistantRouter(adapter, '')` and asserts a request with an empty Bearer token receives 401. This test passes in the live run.

**Commit evidence:** `77fe6e3` (2026-05-24T08:42:27Z) — "fix(41): make /v1 router a self-contained auth boundary (CR-01)" — touches exactly `router.ts`, `router.test.ts`, `server.ts`. Authored by `thenasty`.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/channels/home-assistant/types.ts` | extractLastUserTurn + buildChatCompletionResponse | VERIFIED | Both exported, no express dep, conversation_id echoed, 19/19 type tests pass |
| `src/channels/home-assistant/types.test.ts` | Unit coverage for extraction + response shape | VERIFIED | 19 tests covering all behavior rows |
| `src/channels/home-assistant/adapter.ts` | pendingReply slot lifecycle, upgraded send(), dispatchInbound, fail-fast | VERIFIED | All methods present and substantive; 25/25 adapter tests pass |
| `src/channels/home-assistant/adapter.test.ts` | Block A/B preserved + Block C added | VERIFIED | Three describe blocks all green |
| `src/channels/home-assistant/router.ts` | createHomeAssistantRouter + REPLY_DEADLINE_MS + CR-01 self-contained auth | VERIFIED | Both exported; `!inboundApiKey` guard added to auth check; all HACV behaviors present |
| `src/channels/home-assistant/router.test.ts` | Standalone Express integration suite (HACV-01..05, SC4, D-04) + CR-01 regression | VERIFIED | 18 tests (was 17); CR-01 test at line 209; all green |
| `src/config.ts` | HA_INBOUND_API_KEY in ENV_KEY_ALLOWLIST | VERIFIED | Line 511, immediately after HA_ACCESS_TOKEN |
| `src/dashboard/server.ts` | CSRF /v1/* exclusion + homeAssistantAdapters option + conditional /v1 router mount | VERIFIED | Line 154 exclusion; line 106 option field; lines 281-290 guarded mount with no `?? ''` fallback, before SPA fallback |
| `src/index.ts` | haAdapters collection + DashboardServer wiring | VERIFIED | Line 237 declaration; line 330 push; line 445 constructor wiring |
| `docs/internals/channel-integrations.md` | Apache /v1 auth-bypass snippet captured | VERIFIED | Lines 116-119; "RECORDED, NOT APPLIED" note present |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| router.ts | types.ts | `import { extractLastUserTurn, buildChatCompletionResponse } from './types.js'` | VERIFIED | router.ts line 6 |
| router.ts | adapter.ts | `adapter.setPendingReply / clearPendingReply / dispatchInbound` | VERIFIED | router.ts lines 81, 91, 97 |
| server.ts | router.ts | `app.use('/v1', createHomeAssistantRouter(haAdapter, haInboundApiKey))` guarded by `if (haInboundApiKey)` | VERIFIED | server.ts lines 286-289 |
| index.ts | server.ts | `homeAssistantAdapters: haAdapters` in DashboardServer constructor | VERIFIED | index.ts line 445 |
| send() → pendingReply.resolve | held HTTP slot | clearTimeout + resolve + null | VERIFIED | adapter.ts lines 73-76 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| router.ts | `userText` | `extractLastUserTurn(body.messages)` from HA request body | Yes — real HA payload | FLOWING |
| router.ts | `replyText` promise | `adapter.send(text)` → resolves pending slot | Yes — head's real reply | FLOWING |
| adapter.ts | `pendingReply.resolve` | router wires, head triggers via send() | Yes — wired to activation loop | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| HACV-01/03/05 + CR-01 router tests | `npx vitest run src/channels/home-assistant/router.test.ts` | 18/18 passing, 4230ms | PASS |
| Adapter slot lifecycle tests | `npx vitest run src/channels/home-assistant/adapter.test.ts` | 25/25 passing, 26ms | PASS |
| Types unit tests | `npx vitest run src/channels/home-assistant/types.test.ts` | 19/19 passing, 9ms | PASS |
| TypeScript type check | `npx tsc --noEmit` | No output (exit 0) | PASS |
| Full HA subset | `npx vitest run src/channels/home-assistant/` | 62/62 passing | PASS |

---

### Probe Execution

Step 7c: SKIPPED — no probe-*.sh scripts declared or found for this phase. The plans declare vitest tests as the verification mechanism, which were run above.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| HACV-01 | Plans 01, 03, 04 | OpenAI-compat POST /v1/chat/completions | SATISFIED | buildChatCompletionResponse produces correct shape; 200 + choices/finish_reason/usage verified |
| HACV-02 | Plans 01, 02, 03 | Bearer token auth independent of dashboard session | SATISFIED | JSON 401 with no WWW-Authenticate; fail-fast constructor; CR-01 closed — router self-contained auth boundary confirmed |
| HACV-03 | Plans 01, 02, 03 | Last user turn extracted; HA history discarded | SATISFIED | extractLastUserTurn reverse-scans and returns only the last role:'user' entry; dispatchInbound carries conversation thread ID |
| HACV-04 | Plans 02, 03 | Reply within deadline or connection lapses (no filler) | SATISFIED | REPLY_DEADLINE_MS=3000; deadline catch branch sends no body; SC4 close cleanup tested |
| HACV-05 | Plans 01, 03 | conversation_id echoed or generated; thread keyed ha-${id} | SATISFIED | Echo path + UUID fallback in router; rawPayload carries conversationId in dispatchInbound |
| HACV-06 | Plan 04 | /v1/* bypasses CSRF middleware; bearer auth reaches Shrok | SATISFIED | CSRF exclusion at server.ts line 154 before requireSameOrigin; router mounts before SPA fallback |

---

### Anti-Patterns Found

No new anti-patterns introduced by the CR-01 fix. Previously noted warnings (carried from initial verification, unchanged severity):

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/channels/home-assistant/router.ts | 80 | `req.on('close', () => { /* SC4 — see res close handler below */ })` — empty listener | Warning (WR-05) | Dead code; actual cleanup is on `res.on('close')`; misleads future readers |
| src/channels/home-assistant/router.ts | 38 | `auth.slice(7) !== inboundApiKey` — non-constant-time string comparison | Warning (WR-01) | Diverges from project's timingSafeEqual convention in src/webhook/index.ts; LAN-only threat model reduces risk |

Note: Both warnings were present in the initial verification and are non-blocking. The CR-01 BLOCKER (previously `server.ts:282` `?? ''` fallback) is now CLOSED.

---

### Human Verification Required

None. The CR-01 decision was resolved by code fix, not by risk acceptance. All must-haves are now mechanically verified.

---

### Deferred Items (D-03 — intentional, per 41-CONTEXT.md)

The following are explicitly deferred to Phase 43 per decision D-03 and the authoritative scope notes. They are NOT gaps.

| Item | Addressed In | Evidence |
|------|-------------|---------|
| Live Apache vhost edit (`<Location "/v1/"> AuthType None` applied to gigaashley-le-ssl.conf) | Phase 43 | D-03 in 41-CONTEXT.md; Apache snippet captured in docs/internals/channel-integrations.md with "NOT APPLIED — Phase 43" note |
| `curl -v https://jarvis.gigaashley.click/v1/chat/completions` showing Shrok's JSON 401 (not Apache Basic 401) | Phase 43 | D-03 / ROADMAP SC3 reframed as Phase-43 gate |
| Exact REPLY_DEADLINE_MS tuning against real TTS + TLS + Apache + network latency | Phase 43 | D-01 in 41-CONTEXT.md |

---

### Gaps Summary

No gaps. All 12 truths verified. Phase goal achieved.

---

_Verified: 2026-05-24T08:50:00Z_
_Verifier: Claude (gsd-verifier)_
