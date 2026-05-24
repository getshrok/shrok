---
phase: 43-end-to-end-smoke-test-setup-docs
plan: "02"
subsystem: home-assistant-channel
tags: [home-assistant, live-test, smoke-test, vpe, sc1, sc2, sc3, sc4]
dependency_graph:
  requires: [40-02, 41-04, 42-02, 43-01]
  provides: [HADOC-01-live-validation]
  affects:
    - .planning/phases/43-end-to-end-smoke-test-setup-docs/43-VERIFICATION.md
    - docs/user-guide/home-assistant.md
tech_stack:
  added: []
  patterns: [live-hardware-attestation, openai-compat-endpoint, assist_satellite-announce]
key_files:
  created:
    - .planning/phases/43-end-to-end-smoke-test-setup-docs/43-VERIFICATION.md
  modified:
    - docs/user-guide/home-assistant.md
decisions:
  - "deadline tuning needed: NO — 43-03 deadline candidate is a no-op (see verdict below)"
  - "P6 busy-satellite skip: NOT needed — satellite was idle throughout, no collision observed → 43-03 p6-skip no-op"
  - "entity-check: NOT needed — pre-resolved entity was correct, no wrong-entity confusion → 43-03 entity-check no-op"
  - "HADOC-01 doc bugs found live were FIXED in-phase (Skip Authentication step; Apache /v1 block must be AFTER the catch-all, not before; corrected verify-step log-line names) rather than deferred"
  - "~16s HA-route-specific latency overhead filed as a high-value follow-up (out of 43-03 bounded scope — lives in the context/memory layer, not the adapter or the 3 D-01 tunables)"
metrics:
  duration: live-session
  completed: "2026-05-24"
  tasks: 3
  files: 2
---

# Phase 43 Plan 02: Live VPE Smoke Test Summary

**One-liner:** Live end-to-end validation of the v1.5 Home Assistant Voice integration against the real Voice PE device (co-located topology) — all four success criteria (SC1–SC4) met on real hardware; the conditional 43-03 tuning resolves to **no-op**.

## 43-03 GATING VERDICT

**deadline tuning needed: NO.** → Plan 43-03 = **no-op (zero production code)**.

- **deadline bump — no-op.** The model turn itself is fast (Sonnet @ ~2.1s, operator-confirmed). The ~20s end-to-end latency is **pipeline overhead specific to the HA inbound route** (a same-head text turn was ~4s), NOT model latency and NOT the `REPLY_DEADLINE_MS` deadline. No value in the D-01 envelope (3000–4000ms) could change the outcome, and the lapse→announce UX is acceptable. Bumping the constant is pointless.
- **P6 busy-satellite skip — no-op.** Satellite was `idle` throughout; no interleaved-audio / stuck-state / dropped-turn collision was observed.
- **entity-check — no-op.** The pre-resolved entity ID was correct; no wrong-entity silent failure occurred.

43-03 should select **no-op** and record the latency item + the SC3 doc fixes (already applied) as backlog/follow-up.

## Tasks Completed

| Task | Name | Type | Outcome |
|------|------|------|---------|
| 1 | Bring up the test rig | checkpoint:human-action | ✓ shrok restarted onto v1.5, 3 HA containers up, channel + .env configured, HA adapter registered, HACS + Extended OpenAI Conversation installed/selected |
| 2 | Spoken-turn Scenarios A–D + SC4 ledger | checkpoint:human-verify | ✓ SC1 two-leg flow confirmed; SC4 ledger filled (conversation_id stitching works; deadline verdict = no-op); D deferred |
| 3 | Apache /v1 bypass apply → verify → revert | checkpoint:human-action | ✓ SC2 confirmed (Shrok JSON 401 through proxy), reverted clean (no standing public /v1) |

## What Was Validated

**SC1 — full two-leg spoken flow (real hardware):** Operator spoke "What's the capital of France?" to the VPE. Journal: inbound `/v1` POST → `turn lapsed` at +3s → `announce delivered via announce (6 chars)` at +21s; the VPE spoke "Paris" via `assist_satellite.announce`. The in-turn slot did not win (pipeline overhead ≫ deadline), and the answer correctly rode the announce path. Device-side lapse UX = silence then the answer, no error tone, no double-response (acceptable).

**SC2 — Apache `/v1` bypass:** Baseline (no bypass) returned Apache's Basic 401 (`WWW-Authenticate: Basic`). With the `<Location "/v1/">` AuthType-None block placed **after** the catch-all `<Location />` (placing it *before* did NOT work — Apache 2.4 merges overlapping `<Location>` in config order, later wins), `curl https://jarvis.gigaashley.click/v1/chat/completions` returned Shrok's JSON 401 (`{"error":"Unauthorized"}`, `Content-Type: application/json`, no `WWW-Authenticate: Basic`). Reverted byte-identical to backup; post-revert `/v1` is back behind Basic auth with 0 `/v1/` blocks in the live conf (T-43-04 mitigated).

**SC3 — HADOC-01 usability:** Two correctness bugs surfaced and were fixed in `docs/user-guide/home-assistant.md` in-phase: (1) the required **Skip Authentication** checkbox (the integration probes `GET /v1/models`, which Shrok doesn't implement, so setup errors without it); (2) the Apache `/v1/` block placement (**after**, not before, the catch-all). Also corrected the verify-step log-line names and added a stale-conversation-agent warning (a leftover `jarvis_conversation` agent silently shadowed the new one and produced a misleading "could not reach Jarvis" error).

**SC4 — open-question ledger:** `conversation_id` IS sent by HA on real turns (Shrok's `ha-${conversation_id}` stitching works); deadline lapse UX resolved (acceptable); reply-window measured (HA-route overhead ~16s, filed as follow-up); `start_conversation`, `device_id`-in-body, and `continue_conversation` deferred (D-03 observe-only / not triggerable this session). HA version 2026.3.1 and the satellite entity (`assist_satellite.home_assistant_voice_0a1fbc_assist_satellite`, state `idle`) confirmed.

## Production Code Changes

None. This plan changed no production source (per D-06: live test + ledger only). The only file edits are the verification ledger and the HADOC-01 doc corrections.

## Findings filed (see 43-VERIFICATION.md § Findings & Follow-ups)

1. SC3 — HADOC-01 missing "Skip Authentication" step → **fixed in-phase**.
2. SC3 — legacy `jarvis_conversation` silently shadows the new agent → **documented in HADOC-01 in-phase**.
3. `/v1` sends no HTTP body on lapse (by design, D-02) → optional future consideration, contested by D-02.
4. **HIGH-VALUE follow-up:** ~16s HA-route-specific latency overhead (voice ~20s vs text ~4s on the same head; model only ~2s). Lives downstream of the trivial `adapter.dispatchInbound`; prime suspects are cold `ha-${conversation_id}` thread context assembly / memory retrieval / prompt-cache miss. Recommend a dedicated `/gsd:debug` session — out of 43-03 bounded scope.
5. SC2 — Apache `/v1/` placement is "after the catch-all", correcting RESEARCH/HADOC-01 → **fixed in-phase**.

## Threat Flags

None new. T-43-04 (standing public `/v1` surface) mitigated by the blocking revert in Task 3 — verified 0 `/v1/` blocks remain in the live vhost. T-43-05 (token disclosure) honored — no real token value written to 43-VERIFICATION.md.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `.planning/phases/43-end-to-end-smoke-test-setup-docs/43-VERIFICATION.md` (status: complete) | FOUND |
| `docs/user-guide/home-assistant.md` (Skip Auth + after-catch-all corrections) | FOUND |
| SC1 two-leg flow confirmed on hardware | ATTESTED |
| SC2 curl JSON-401 + clean revert | ATTESTED |
| deadline tuning verdict stated (NO → 43-03 no-op) | YES |
