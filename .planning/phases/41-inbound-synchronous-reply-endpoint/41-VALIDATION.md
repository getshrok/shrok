---
phase: 41
slug: inbound-synchronous-reply-endpoint
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-24
---

# Phase 41 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 41-RESEARCH.md § Validation Architecture. Task IDs are finalized
> when PLAN.md files are written; this map is the contract those tasks must satisfy.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 |
| **Config file** | `vitest.config.ts` (root) — includes `src/**/*.test.ts` |
| **Quick run command** | `npx vitest run src/channels/home-assistant/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5–15 seconds (channel subset); full suite is sharded on CI |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/channels/home-assistant/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds (channel subset)

---

## Per-Task Verification Map

> Task IDs (`41-NN-MM`) are assigned by the planner. Each behavior below MUST map to
> at least one task's `<automated>` verify or a Wave 0 test stub.

| Behavior | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|----------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| POST with valid bearer enqueues `user_message` + returns OpenAI-compat JSON | 1 | HACV-01 | — | Authenticated turn reaches `headRouteMessage` | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| `choices[0].message.content` non-empty; `finish_reason:"stop"`; zeroed `usage` | 1 | HACV-01 | — | N/A | unit | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| Missing bearer → JSON 401 (no `WWW-Authenticate: Basic`) | 1 | HACV-02 | T-bearer-spoof | Shrok-origin JSON 401, not Apache Basic | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| Wrong bearer → JSON 401 | 1 | HACV-02 | T-bearer-spoof | Reject invalid token | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| Last `role:"user"` extracted; prior messages discarded | 1 | HACV-03 | — | No HA history persisted (anti-feature) | unit | `npx vitest run src/channels/home-assistant/` | ❌ W0 | ⬜ pending |
| Deadline lapse → no response body sent; slot cleared | 1 | HACV-04 | — | No leaked timer/promise | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| `send()` before deadline → reply arrives in response body | 1 | HACV-04 | — | Exactly-once delivery to held slot | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| `conversation_id` echoed from request body | 1 | HACV-05 | — | N/A | unit/integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| Missing `conversation_id` → server-side UUID generated + echoed | 1 | HACV-05 | — | N/A | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| CSRF exclusion: cross-origin POST to `/v1/*` not 403 | 1 | HACV-06 | — | `/v1/*` exempt from `requireSameOrigin` | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| `req.on('close')` → timer cleared, `pendingReply=null`, no dangling ref | 1 | HACV-04 / SC4 | T-dos-held-conn | Bounded memory; no leak | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| Concurrent turn while slot held → slot replaced, prior timer cleared | 1 | D-04 | T-dos-held-conn | Single active `pendingReply`; latest wins | integration | `npx vitest run src/channels/home-assistant/router.test.ts` | ❌ W0 | ⬜ pending |
| `send()` with open slot → resolves slot, returns immediately | 1 | HACV-04 | — | N/A | unit | `npx vitest run src/channels/home-assistant/adapter.test.ts` | ❌ W0 | ⬜ pending |
| `send()` with null slot → `log.warn` (Phase 42 stub, no token logged) | 1 | HACV-04 | T-key-leak | Never log bearer/key | unit | `npx vitest run src/channels/home-assistant/adapter.test.ts` | ✅ (update) | ⬜ pending |
| `ENV_KEY_ALLOWLIST` contains `HA_INBOUND_API_KEY` | 1 | HACV-02 | — | Key only via `.env` allowlist | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| Boot fail-fast when `home-assistant` configured but inbound key missing | 1 | HACV-02 | — | Refuse boot on missing secret | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/channels/home-assistant/router.test.ts` — covers HACV-01, HACV-02, HACV-04, HACV-05, HACV-06, SC4, D-04
- [ ] `src/channels/home-assistant/adapter.test.ts` — existing file; add Block C tests for upgraded `send()` (open-slot resolve, null-slot warn)
- [ ] Last-user-turn extraction tests (HACV-03) — in `router.test.ts` or a split `types.test.ts`
- [ ] Config tests — `HA_INBOUND_API_KEY` in `ENV_KEY_ALLOWLIST`; boot fail-fast on missing key

*Framework already installed (vitest 2.1.9) — no install step needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live `curl -v` JSON-401 vs Apache Basic-401 against production domain | HACV-02 (SC3) | Requires the live Apache vhost edit + production TLS | **Deferred to Phase 43** (CONTEXT.md D-03). Phase 41 verifies JSON-401 via Express tests directly. |
| Real VPE device timeout UX + exact deadline tuning | HACV-04 (D-01) | Needs real TTS + TLS + Apache + network latency stack | **Deferred to Phase 43** (CONTEXT.md D-01 / deferred ideas). |

*All in-scope Phase 41 behaviors have automated verification via tests against the Express endpoint.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
