---
phase: quick-260525-fgc
plan: 01
subsystem: voice
tags: [voice, dashboard, multi-head, websocket, mse, bug-fix]
dependency_graph:
  requires: []
  provides: [per-turn-live-mse, head-aware-voice-ws, query-tolerant-upgrade-guard, head-bound-voice-routing, multi-router-voice-registration]
  affects: [dashboard/src/hooks/useVoice.ts, dashboard/src/pages/ConversationsPage.tsx, src/channels/voice/adapter.ts, src/index.ts]
tech_stack:
  added: []
  patterns: [pure-predicate-export-for-test-seam, per-connection-state-field, opts-object-constructor-back-compat, shared-adapter-multi-router]
key_files:
  created: []
  modified:
    - dashboard/src/hooks/useVoice.ts
    - dashboard/src/hooks/useVoice.test.ts
    - dashboard/src/pages/ConversationsPage.tsx
    - src/channels/voice/adapter.ts
    - src/channels/voice/adapter.test.ts
    - src/index.ts
decisions:
  - "D-PURE-PREDICATE: needsFreshMSE exported as DOM-free predicate (test seam under node env); ensureLiveMSE wraps it as a useCallback"
  - "D-OPTS-BACK-COMPAT: VoiceChannelAdapter constructor changed from positional (id, headId) to optional opts object — all existing callers with no 3rd arg remain valid"
  - "D-PATHNAME-GUARD: URL upgrade guard uses new URL().pathname comparison — exact match, rejects /api/voice/wsX, accepts ?head=…"
  - "D-SHARED-ADAPTER: one VoiceChannelAdapter registered under 'voice' on every head's channelRouter — only the session-bound head enqueues a user_message so only it replies on 'voice'"
  - "D-CONNECTION-ROUTE: per-connection route resolved once at connect time via resolveHeadFromUrl + routeFor, stored as private field, reset on close"
metrics:
  duration: "~6min (334s)"
  completed: "2026-05-25T15:25:15Z"
  tasks_completed: 3
  files_modified: 6
---

# Phase quick-260525-fgc Plan 01: Fix Dashboard Convo-View Voice Mode (Multi-Turn + Multi-Head) Summary

**One-liner:** Per-turn live MediaSource (endOfStream bug fix), head-aware ?head= WS URL, pathname-based upgrade guard, and per-connection head routing via resolveHeadFromUrl + multi-router registration.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 — needsFreshMSE + ensureLiveMSE | 96fc8ec | feat(260525-fgc): per-turn live MSE in useVoice + needsFreshMSE predicate (D2) |
| 2 — buildWsUrl(head) + ConversationsPage | c04a833 | feat(260525-fgc): head-aware buildWsUrl(head) + useVoice(selectedHead) + ConversationsPage wiring (D3/D1) |
| 3 — adapter upgrade guard + routing + index.ts | 29c50de | feat(260525-fgc): query-tolerant upgrade guard + resolveHeadFromUrl + per-connection head routing + multi-router registration (D4/D5) |

## Gate Results

| Gate | Result | Count |
|------|--------|-------|
| `npx tsc --noEmit` (repo root) | PASS | 0 errors |
| `cd dashboard && npx vitest run` | PASS | 73/73 tests |
| `npx vitest run` (repo root) | PASS | 1707/1708 tests (1 pre-existing skip) |

## What Was Built

### Task 1: Per-turn live MSE (Bug A / D2)
- Exported `needsFreshMSE(ms)` pure predicate: `true` for null/undefined/'ended'/'closed', `false` for 'open'
- Added `ensureLiveMSE()` useCallback: calls needsFreshMSE, tears down + recreates + play()s if needed
- Called `ensureLiveMSE()` at `tts_start` BEFORE `TTS_START` dispatch — turn 1 (open) is a no-op; turn 2 (ended) recreates
- `tts_done` `endOfStream()` kept; barge-in recreate path intact and idempotent

### Task 2: Head-aware WS URL (D3/D1)
- `buildWsUrl(head: string)` exported: appends `?head=encodeURIComponent(head)` to `/api/voice/ws`
- `useVoice(selectedHead: string)` — binds the head at toggle-on (WS open), no mid-session re-bind per D1
- `selectedHead` added to `toggleVoice` useCallback deps (latest value captured at click)
- `ConversationsPage` passes its `selectedHead` state to `useVoice`

### Task 3: Query-tolerant upgrade guard + head routing (D4/D5)
- **Blocker fix**: upgrade guard now extracts `new URL(req.url, 'http://x').pathname` and compares to `VOICE_WS_PATH` — accepts `?head=…`, rejects `/api/other` and `/api/voice/wsX`
- Exported `resolveHeadFromUrl(url, knownHeadIds, defaultHeadId)`: validates `?head=` against knownHeadIds set, falls back to defaultHeadId for absent/empty/unknown/malformed input (T-fgc-01 mitigation)
- Constructor changed to `opts?: { id?, defaultHeadId?, knownHeadIds?, routeFor? }` — back-compat (existing no-opts callers unaffected)
- `req` threaded through connection handler; `connectionRoute` set once per connection via `routeFor(headId)`, reset on close
- `handleAudio` routes via `connectionRoute ?? handler` (head-specific when routeFor set)
- `index.ts`: passes `knownHeadIds` + `routeFor` resolver; registers shared `voiceAdapter` on ALL heads' `channelRouter`s via `for (const h of headSystems) h.channelRouter.register(voiceAdapter)`

## Tests Added

| Suite | File | Count |
|-------|------|-------|
| needsFreshMSE (D2) | dashboard/src/hooks/useVoice.test.ts | 5 new |
| buildWsUrl ?head= (D3) | dashboard/src/hooks/useVoice.test.ts | 2 new |
| resolveHeadFromUrl unit | src/channels/voice/adapter.test.ts | 7 new |
| E2E upgrade + routing | src/channels/voice/adapter.test.ts | 6 new |

**Key E2E assertions:**
- Socket UPGRADES/CONNECTS on `?head=<known>` (asserts activeSocket non-null — catches strict-equality guard regression)
- Transcript routes to the head-specific route for `?head=<known>`, NOT default
- Absent/unknown `?head=` falls back to default route
- `/api/other` and `/api/voice/wsX` still rejected (activeSocket stays null)

## #11 / Live Update Scope (D6)

Per the plan's analysis: **no #11 code change was needed for the voice render path.** With Bug B fixed, a non-default-head voice transcript causes that head to persist messages and emit `message_added` with its own `headId`. The existing `shouldDeliverStreamEvent` gate (Phase 33) routes it to `['messages', headId]`; `ConversationsPage.selectedHead` equals the voice-bound head → renders live without any additional work.

Broader #11 gaps that were deliberately scoped out: cross-head `agent_*`/`steward_run_added`/`memory_retrieval` events do not carry `headId` (Phase 33 D-SCOPE-MIN-CORRECT — T-33-09 accepts this leakage). These are out of scope for the voice render path and were not touched.

## Deviations from Plan

None — plan executed exactly as written. The `opts` constructor change (vs the original positional `id, headId` params) is precisely what the plan specified.

## Known Stubs

None.

## Threat Surface

All threats in the plan's threat register were mitigated as specified:
- T-fgc-01: `resolveHeadFromUrl` validates against `knownHeadIds` — unknown `?head=` falls back to default
- T-fgc-02: single `activeSocket` — cross-head TTS bleed structurally impossible; D-03 second-socket rejection intact
- T-fgc-04: pathname guard tested against `/api/other` and `/api/voice/wsX` — no over-matching

## Post-Deployment Requirements

A **shrok service restart** is required to pick up the backend changes (`src/channels/voice/adapter.ts`, `src/index.ts`). A **dashboard dist rebuild** is required for the frontend changes (`dashboard/src/`) — the orchestrator handles this.

## Self-Check: PASSED

- dashboard/src/hooks/useVoice.ts — FOUND
- src/channels/voice/adapter.ts — FOUND
- src/index.ts — FOUND
- commit 96fc8ec — FOUND
- commit c04a833 — FOUND
- commit 29c50de — FOUND
