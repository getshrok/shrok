---
phase: 19
plan: 01
subsystem: voice
tags: [wav, stt, whisper, openai, audio, duration-gate]
dependency_graph:
  requires: []
  provides:
    - src/channels/voice/wav.ts (parseWavDuration)
    - src/channels/voice/stt.ts (transcribeWav, TooShortError, InvalidWavError, MIN_WAV_DURATION_SECONDS)
  affects: []
tech_stack:
  added: []
  patterns:
    - RIFF chunk scanning (non-fixed-offset, handles LIST/INFO before data)
    - Web API File object boundary (no disk I/O for Whisper upload)
    - Typed error classes (TooShortError, InvalidWavError) for caller discrimination
key_files:
  created:
    - src/channels/voice/wav.ts
    - src/channels/voice/wav.test.ts
    - src/channels/voice/stt.ts
    - src/channels/voice/stt.test.ts
  modified: []
decisions:
  - "500ms gate uses strict less-than (duration < 0.5): exactly 0.5s passes through to Whisper"
  - "parseWavDuration returns null (never throws) for all malformed inputs — safe to call on untrusted binary"
  - "chunkSize > buf.length guard rejects truncated/oversized data chunks before division"
  - "transcribeWav accepts OpenAI client as parameter — caller owns instantiation, no import OpenAI as value"
  - "inlined WAV builder in stt.test.ts (duplicate-by-design, no shared test helper yet)"
metrics:
  duration: ~3 minutes
  completed: "2026-04-23T07:39:11Z"
  tasks_completed: 2
  files_created: 4
---

# Phase 19 Plan 01: WAV Parser and Whisper Wrapper Summary

WAV header parser with chunk-scanning and Whisper transcription wrapper with 500ms duration gate — zero WebSocket dependencies, fully unit-tested.

## What Was Built

### `src/channels/voice/wav.ts`

Exports `parseWavDuration(buf: Buffer): number | null`.

- Validates RIFF/WAVE magic bytes at fixed offsets
- Reads `byte_rate` from the fmt chunk at absolute offset 28 (uint32 LE)
- **Scans chunks** starting after the fmt chunk to locate `data` — handles any chunk ordering (LIST, INFO, etc. before data)
- Guards every `readUInt32LE` call against buffer bounds; returns `null` for truncated/malformed input, never throws
- T-19-01 mitigation: all reads bounds-checked; T-19-02 mitigation: loop exits when `offset + 8 > buf.length`

### `src/channels/voice/wav.test.ts`

10 tests covering:
- Standard 0.5s and 0.25s durations
- Empty / short buffers (< 44 bytes)
- Missing RIFF and WAVE markers
- Zero byte_rate
- LIST chunk before data chunk (non-standard ordering)
- fmt chunk size 18 (non-PCM extension)
- No data chunk present (returns null, not infinite loop)
- Truncated data (no out-of-bounds throw)

### `src/channels/voice/stt.ts`

Exports:
- `TooShortError` — typed error with `.durationSeconds` property, thrown when clip is < 0.5s (T-19-03)
- `InvalidWavError` — thrown when `parseWavDuration` returns null (malformed buffer)
- `MIN_WAV_DURATION_SECONDS = 0.5` — exported constant for callers and tests
- `transcribeWav(buf: Buffer, openai: OpenAI): Promise<string>` — duration-gated Whisper wrapper

Key implementation details:
- `import type OpenAI from 'openai'` — type-only import, no value import
- `new File([buf], 'audio.wav', { type: 'audio/wav' })` — D-04 boundary, no disk I/O
- Gate: `if (duration < MIN_WAV_DURATION_SECONDS)` — strict less-than, so exactly 0.5s passes
- Returns `(result.text ?? '').trim()` — handles Whisper's trailing whitespace
- No `fs.` or `writeFile` — confirmed

### `src/channels/voice/stt.test.ts`

6 tests covering:
- Trimmed text returned for valid >=500ms WAV
- File object name/type/model verified via mock inspection
- TooShortError thrown + SDK not called for 0.25s clip
- Boundary 0.5s passes gate (calls SDK)
- InvalidWavError thrown + SDK not called for malformed buffer
- SDK rejection propagates unchanged

## How Plan 03 Should Consume These

```typescript
import { parseWavDuration } from './wav.js'                     // if needed standalone
import { transcribeWav, TooShortError, InvalidWavError } from './stt.js'

// Construct openai client outside (adapter owns it):
const openai = new OpenAI({ apiKey: config.openaiApiKey })

// In the binary frame handler:
try {
  const text = await transcribeWav(audioBuffer, openai)
  // route text through queue as InboundMessage
} catch (err) {
  if (err instanceof TooShortError) {
    // log and silently discard — not a system error
  } else if (err instanceof InvalidWavError) {
    // close/warn the client
  } else {
    throw err  // SDK/network error — let it propagate
  }
}
```

## Test Results

```
Tests  16 passed (16)
  - wav.test.ts: 10 passed
  - stt.test.ts: 6 passed
```

`npx tsc --noEmit` exits 0.

## Deviations from Plan

None — plan executed exactly as written. Implementation follows the action blocks verbatim.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 3fe8839 | feat(19-01): WAV duration parser with chunk-scanning |
| 2 | 360fc3a | feat(19-01): Whisper transcription wrapper with 500ms duration gate |

## Self-Check: PASSED

- `/home/ubuntu/shrok/src/channels/voice/wav.ts` — exists
- `/home/ubuntu/shrok/src/channels/voice/wav.test.ts` — exists
- `/home/ubuntu/shrok/src/channels/voice/stt.ts` — exists
- `/home/ubuntu/shrok/src/channels/voice/stt.test.ts` — exists
- Commit `3fe8839` — verified in git log
- Commit `360fc3a` — verified in git log
