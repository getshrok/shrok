---
phase: 43-end-to-end-smoke-test-setup-docs
plan: "03"
subsystem: home-assistant-channel
tags: [home-assistant, conditional-tuning, d-01, no-op]
dependency_graph:
  requires: [43-02]
  provides: []
  affects: []
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified: []
decisions:
  - "Task 1 (checkpoint:decision) resolved to NO-OP — operator pre-authorized; justified by 43-02 live verdict (deadline tuning needed: NO)"
  - "Task 2 (apply tuning) SKIPPED entirely per the no-op branch — zero production code shipped"
  - "REPLY_DEADLINE_MS left at export const 3_000 (unchanged, export preserved)"
metrics:
  duration: inline-decision
  completed: "2026-05-24"
  tasks: 1
  files: 0
---

# Phase 43 Plan 03: Conditional D-01 Tuning Summary

**One-liner:** No-op — the live test (43-02) justified none of the three pre-deferred D-01 tunables, so this plan ships **zero production code**.

## Outcome: NO-OP (zero production code)

**Option chosen (Task 1 decision): `no-op`.**

Justified directly by `43-02-SUMMARY.md` / `43-VERIFICATION.md`:

| D-01 candidate | Live-test finding | Decision |
|---|---|---|
| Bump `REPLY_DEADLINE_MS` | The model turn is fast (Sonnet ~2.1s); the ~20s end-to-end is HA-route **pipeline overhead** (text on the same head was ~4s), not the deadline. No value in the 3000–4000ms envelope changes the outcome, and the lapse→announce UX is acceptable. | **Not applied** |
| P6 busy-satellite skip | Satellite was `idle` throughout; no interleaved-audio / stuck / dropped-turn collision observed. | **Not applied** |
| Entity-existence check | Pre-resolved entity ID was correct; no wrong-entity silent failure. | **Not applied** |

Task 2 was skipped entirely (the no-op branch). No production file was touched: `git diff --name-only 41ea146 HEAD -- src/` returns 0 files; `REPLY_DEADLINE_MS` remains `export const REPLY_DEADLINE_MS = 3_000`.

## Deferred to backlog (spin-out criteria — NOT built here)

Per the D-01 spin-out rules (no new interface field / config key / router change beyond the deadline constant / no touching activation.ts, QueueStore, ChannelRouter), the live test's findings are recorded as follow-ups, not implemented:

1. **HIGH-VALUE — ~16s HA-route-specific latency overhead** (voice ~20s vs same-head text ~4s; model only ~2s). Downstream of the trivial `adapter.dispatchInbound`; suspects: cold `ha-${conversation_id}` thread context assembly / memory retrieval / prompt-cache miss. → dedicated `/gsd:debug` session; fix would live in the context/memory layer (spin-out).
2. `/v1` sends no HTTP body on lapse (by design, D-02) — optional future "fast ack on lapse", contested by D-02. New router behavior = spin-out.
3. Optional `GET /v1/models` JSON stub so HACS setup validation passes without "Skip Authentication" — new router route = spin-out.

(SC3 doc bugs found live — Skip Authentication step, Apache /v1 block placement, log-line names — were corrected in `docs/user-guide/home-assistant.md` under plan 43-02, not here.)

## Threat Flags

None. Zero code change → no new surface. T-43-08 / T-43-09 (token disclosure / scope creep on a tuning edit) are vacuously satisfied — no edit was made.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| Decision recorded with live-test citation | YES (no-op) |
| Zero production code (`src/` diff == 0) | VERIFIED |
| `export const REPLY_DEADLINE_MS` preserved (unchanged 3_000) | VERIFIED |
| Spin-out items recorded as backlog, not built | YES |
