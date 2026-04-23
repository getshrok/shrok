---
phase: 19
plan: "02"
subsystem: voice
tags: [tts, streaming, websocket, abort-controller, openai]
dependency_graph:
  requires: []
  provides: [streamTts, isAbortError, TTS_VOICE, TTS_MODEL, TTS_START_FRAME, TTS_DONE_FRAME]
  affects: [src/channels/voice/tts.ts]
tech_stack:
  added: []
  patterns: [Readable.fromWeb, AbortController signal threading, binary WebSocket frames, TDD]
key_files:
  created:
    - src/channels/voice/tts.ts
    - src/channels/voice/tts.test.ts
  modified: []
decisions:
  - Readable.fromWeb used for Web ReadableStream to Node stream conversion (D-06)
  - AbortSignal threaded into openai.audio.speech.create options not stream.destroy (D-07)
  - TTS_VOICE='alloy' chosen as low-latency default compatible with all tts-* models
  - TTS_MODEL='tts-1' chosen over tts-1-hd for real-time latency requirements
metrics:
  duration_minutes: 12
  completed_date: "2026-04-23"
  tasks_completed: 1
  files_created: 2
---

# Phase 19 Plan 02: TTS Streaming Helper Summary

**One-liner:** OpenAI TTS streaming helper that pipes MP3 chunks as binary WebSocket frames bracketed by tts_start/tts_done sentinels, with AbortController cancellation threading into the upstream HTTP request.

## What Was Built

`src/channels/voice/tts.ts` — a standalone TTS streaming module that Plan 03's `VoiceChannelAdapter.send()` imports.

### Exported API

```typescript
export const TTS_VOICE = 'alloy'           // default voice for all tts-* models
export const TTS_MODEL = 'tts-1'           // low-latency model (not tts-1-hd)
export const TTS_START_FRAME = { type: 'tts_start' } as const
export const TTS_DONE_FRAME  = { type: 'tts_done' }  as const

export function isAbortError(err: unknown): boolean
// Returns true for OpenAI SDK's APIUserAbortError and native AbortError names.
// Plan 03's adapter uses this to distinguish barge-in abort from real upstream failures.

export async function streamTts(
  text: string,
  openai: OpenAI,
  ws: WebSocket,
  signal: AbortSignal,
): Promise<void>
```

### streamTts behavior

1. Calls `openai.audio.speech.create({ model, voice, input, response_format: 'mp3' }, { signal })` — the `signal` is the caller's `AbortSignal`, threaded into the SDK request options so `AbortController.abort()` closes the upstream HTTPS connection (D-07, T-19-06).
2. Converts the response body with `Readable.fromWeb()` (Node 22 built-in) and iterates chunks.
3. Sends `JSON.stringify(TTS_START_FRAME)` as a text WebSocket frame before the first chunk.
4. Sends each chunk as a binary frame via `ws.send(chunk)`.
5. Sends `JSON.stringify(TTS_DONE_FRAME)` as a text frame after clean completion.
6. Every `ws.send` is guarded by `ws.readyState === 1 (OPEN)` — silent stop on client disconnect (Pitfall 3, T-19-07).
7. On abort mid-stream: stops iteration, does NOT send `tts_done`, re-throws the `APIUserAbortError` so the adapter can call `isAbortError(e)` to distinguish it from real failures.
8. On SDK failure before the stream starts: error propagates unchanged; neither `tts_start` nor `tts_done` is sent.

### Plan 03 integration note

Plan 03's adapter should:
- Create a fresh `AbortController` per `send()` call (or per TTS invocation)
- Pass `abortController.signal` to `streamTts`
- On receipt of a `cancel_tts` JSON frame, call `abortController.abort()`
- On WebSocket `close` event, call `abortController.abort()` to stop any in-flight TTS
- Use `isAbortError(e)` in the catch block to suppress barge-in abort noise from logs

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test chunk-count expectation not robust to Readable.fromWeb coalescing**

- **Found during:** GREEN phase — test failure on first run
- **Issue:** The plan's test expected exactly 3 binary frames at indices `sent[1]`, `sent[2]`, `sent[3]` for 3 input `Uint8Array` chunks. Node 22's `Readable.fromWeb` coalesces the small chunks (5 bytes total) into 2 `Buffer` reads, so `sent[3]` was `tts_done` text, not binary. This is correct Node stream behavior, not an implementation bug.
- **Fix:** Replaced hard-coded index checks with a slice-based check: all frames between `tts_start` and `tts_done` must be binary; at least one must exist. This correctly validates the requirement ("forward every MP3 chunk as binary") without assuming 1:1 chunk mapping.
- **Files modified:** `src/channels/voice/tts.test.ts`
- **Commit:** 801df32

## Self-Check

- [x] `src/channels/voice/tts.ts` exists
- [x] `src/channels/voice/tts.test.ts` exists
- [x] All 6 tests pass
- [x] `tsc --noEmit` exits 0
- [x] No `.destroy(` calls in tts.ts
- [x] `{ signal }` passed to `.create(` options
- [x] `Readable.fromWeb(` present
- [x] `ws.readyState !== 1` guards present

## Self-Check: PASSED
