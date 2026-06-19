---
phase: quick-260524-me4
plan: 01
subsystem: channels/ingestion
tags: [voice, transcription, whisper, openai, tdd]
dependency_graph:
  requires: []
  provides: [transcribeAudio, transcribeInboundAudio, headRouteMessage-transcription]
  affects: [src/index.ts, src/channels/voice/stt.ts, src/head/transcribe-attachments.ts]
tech_stack:
  added: []
  patterns: [tdd-red-green, graceful-degradation, pure-helper]
key_files:
  created:
    - src/head/transcribe-attachments.ts
    - src/head/transcribe-attachments.test.ts
  modified:
    - src/channels/voice/stt.ts
    - src/channels/voice/stt.test.ts
    - src/index.ts
decisions:
  - transcribeAudio propagates SDK errors unchanged — ingestion helper owns try/catch
  - ingestionOpenAI constructed once outside per-head loop; all heads share one client
  - headRouteMessage made async — callers (onMessage) ignore return value so fire-and-forget is safe
  - MAX_AUDIO_BYTES ceiling (25 MB) enforced in transcribeInboundAudio before Whisper call
  - ~-command branch unchanged — runs synchronously before any transcription await
metrics:
  duration: 5min
  completed: "2026-05-24T20:18:40Z"
  tasks: 3
  files: 5
---

# Phase quick-260524-me4 Plan 01: Pre-transcribe Inbound Voice Audio Messages Summary

**One-liner:** Synchronous Whisper transcription of chat-channel audio attachments at the shared `headRouteMessage` ingestion seam, injecting `[voice transcript] ...` text before the `user_message` event is enqueued.

## What Was Built

Three-task TDD implementation that pre-transcribes inbound voice/audio attachments from all chat channels (Discord, Telegram, Slack, WhatsApp, Zoho) at a single shared boundary.

### Task 1 — transcribeAudio() Whisper helper (TDD)
Added `export async function transcribeAudio(buf, nameOrMediaType, openai)` to `src/channels/voice/stt.ts`. Accepts any Whisper-supported format (ogg/mp3/m4a/wav/webm) by resolving a filename or MIME type to a `(name, mimeType)` pair via `resolveAudioFile()`. No RIFF parsing, no 0.5s gate (those stay in `transcribeWav`). Propagates SDK errors unchanged. 6 new test cases added alongside 6 existing `transcribeWav` tests.

### Task 2 — transcribeInboundAudio() ingestion helper (TDD)
Created `src/head/transcribe-attachments.ts` — pure helper (no side effects beyond fs read + logging). Returns a new `InboundMessage` with transcript lines prepended as `[voice transcript] ...`. Never mutates input, never throws. Graceful degradation per attachment: load failure, oversize (>= 25 MB), SDK error, or empty transcript → attachment kept, no transcript line, processing continues to next attachment. 7 test cases covering all behavior contracts.

### Task 3 — Wire into headRouteMessage
In `src/index.ts`:
- Added `import { transcribeInboundAudio }` from `./head/transcribe-attachments.js`
- Added `const ingestionOpenAI = config.openaiApiKey ? new OpenAI({ ... }) : null` outside the per-head loop
- Made `headRouteMessage` async; added `const routed = await transcribeInboundAudio(msg, ingestionOpenAI)` before `headQueue.enqueue`
- Updated `HeadSystem.routeMessage` type to `(msg: InboundMessage) => Promise<void>`
- `~`-command branch is unchanged

## Commits

| Hash | Message |
|------|---------|
| ab6fbba | feat(260524-me4): add general transcribeAudio Whisper helper |
| 3acbb4a | feat(260524-me4): add pure transcribeInboundAudio ingestion helper with graceful fallback |
| ddacc75 | feat(260524-me4): wire transcribeInboundAudio into headRouteMessage ingestion seam |

## Deviations from Plan

None — plan executed exactly as written.

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|-----------|
| T-me4-01 DoS (oversized audio) | MAX_AUDIO_BYTES = 25 MB ceiling in transcribeInboundAudio; oversize → skip+log |
| T-me4-02 Tampering (corrupt/crafted audio) | Per-attachment try/catch; any failure → attachment kept, no transcript, does not abort message |

## Final Gate Results

- `npx tsc --noEmit`: PASS (clean, no errors)
- `npx vitest run`: PASS — 1653 tests passed, 1 skipped (pre-existing), 0 failures
  - New: 6 transcribeAudio tests (stt.test.ts), 7 transcribeInboundAudio tests (transcribe-attachments.test.ts)

## Self-Check: PASSED

- src/channels/voice/stt.ts — FOUND (modified)
- src/channels/voice/stt.test.ts — FOUND (modified)
- src/head/transcribe-attachments.ts — FOUND (created)
- src/head/transcribe-attachments.test.ts — FOUND (created)
- src/index.ts — FOUND (modified)
- Commits ab6fbba, 3acbb4a, ddacc75 — all present in git log
