---
phase: 21
plan: 02
subsystem: dashboard/voice-hook+component
tags: [voice, react, hook, vad, websocket, mse, tailwind, lucide-react, typescript]
dependency_graph:
  requires: [dashboard/src/hooks/voice-fsm.ts (Plan 01)]
  provides:
    - dashboard/src/hooks/useVoice.ts
    - dashboard/src/components/VoiceButton.tsx
  affects:
    - dashboard/src/pages/ConversationsPage.tsx (Plan 03 — wires these two)
tech_stack:
  added: []
  patterns:
    - useReducer FSM with stateRef for stale-closure safety
    - MicVAD behind user gesture (no bare useEffect)
    - MediaSource Extensions chunk queue + updateend flush
    - Pure presentational component (no hooks, no browser APIs)
key_files:
  created:
    - dashboard/src/hooks/useVoice.ts
    - dashboard/src/components/VoiceButton.tsx
  modified:
    - dashboard/src/hooks/voice-fsm.test.ts
key_decisions:
  - MicVAD.new() called inside toggleVoice (user-gesture context), never in useEffect
  - ws.binaryType set to 'arraybuffer' immediately after new WebSocket (Pitfall 6)
  - stateRef + voiceActiveRef kept in sync with React state for callback safety (Pitfall 5)
  - Loader2 icon used for processing spinner (confirmed available in lucide-react@1.8.0)
  - Safari MSE fallback: MediaSource.isTypeSupported('audio/mpeg') gate present; falls back to audio/mp4 (which fails silently until backend wraps fMP4 — deferred per Phase 21 scope)
metrics:
  duration: ~3 minutes
  completed: 2026-04-23
  tasks_completed: 3
  tasks_total: 3
  files_created: 2
  files_modified: 1
---

# Phase 21 Plan 02: useVoice Hook + VoiceButton Component Summary

useVoice hook (FSM + VAD + WS + MSE + barge-in) and VoiceButton pure component with four mutually exclusive visual states — TypeScript clean, 33 FSM tests passing.

## What Was Built

### useVoice Return Signature

```typescript
// dashboard/src/hooks/useVoice.ts
export interface UseVoiceReturn {
  state: VoiceState           // from voice-fsm: 'idle' | 'listening' | 'processing' | 'speaking'
  voiceActive: boolean        // true when mic is on (voice mode active)
  toggleVoice: () => Promise<void>
}

export function useVoice(): UseVoiceReturn
```

### VoiceButton Props

```typescript
// dashboard/src/components/VoiceButton.tsx
export interface VoiceButtonProps {
  state: VoiceState
  voiceActive: boolean
  onToggle: () => void
  disabled?: boolean
}

export function VoiceButton(props: VoiceButtonProps): JSX.Element
```

### Pitfall Mitigations (all 6 from 21-RESEARCH.md)

| Pitfall | Description | Location in useVoice.ts | Greppable Marker |
|---------|-------------|------------------------|------------------|
| 1 | Safari MSE audio/mpeg | `setupMSE()` | `MediaSource.isTypeSupported('audio/mpeg')` |
| 2 | SourceBuffer concurrent append | `flushChunkQueue()` + `chunkQueueRef` | `sb.updating` guard |
| 3 | AudioContext autoplay policy | `audioEl.play().catch(...)` in toggleVoice | `autoplay policy may reject` |
| 4 | VAD onSpeechStart during speaking (barge-in) | `onSpeechStart` callback | `stateRef.current === 'speaking'` |
| 5 | Stale closure in VAD callbacks | `stateRef` + `voiceActiveRef` + `wsRef` | `stateRef.current` |
| 6 | WS binaryType default is Blob | Immediately after `new WebSocket(url)` | `binaryType = 'arraybuffer'` |

### Visual States in VoiceButton

| (voiceActive, state) | Visual | Classes |
|----------------------|--------|---------|
| (false, any) | Grey Mic icon | Exact Paperclip off-state classes |
| (true, 'idle') | Mic + pulsing accent ring | `ring-2 ring-[var(--accent)] animate-pulse` |
| (true, 'listening') | Scaled Mic, accent color | `scale-110 animate-pulse text-[var(--accent)]` |
| (true, 'processing') | Mic + Loader2 spinner overlay | `animate-spin text-[var(--accent)]` |
| (true, 'speaking') | Volume2 + 4 waveform bars | `animate-pulse` staggered bars |

### New Test Coverage

3 sequence tests appended to `voice-fsm.test.ts` (33 total, all passing):
- Full happy-path: `idle → listening → processing → speaking → idle`
- Barge-in sequence: `speaking → SPEECH_START → listening → processing`
- ERROR recovery: `speaking/processing/listening + ERROR → idle`

## Deviations from Plan

None — plan executed exactly as written. The authoritative implementation code in the plan was used verbatim for both files. Loader2 was confirmed available in lucide-react@1.8.0 (`node_modules/lucide-react/dist/esm/icons/loader-2.js` exists), so no fallback was needed.

## Known Stubs

None — this plan delivers the hook and component. No data is hardcoded or mocked. The WS URL is dynamically built from `window.location` and the Phase 19 endpoint is live.

## Threat Surface Scan

No new network endpoints introduced. The `buildWsUrl()` function constructs a same-origin WebSocket URL from `window.location.host` — not user-controllable. All STRIDE mitigations from the plan's threat register are present:

- T-21-02-01 (WS URL spoofing): URL built from `window.location.host` only
- T-21-02-02 (JSON frame tampering): `JSON.parse` in try/catch; only `tts_start`/`tts_done` dispatch actions
- T-21-02-05 (MSE DoS): chunk queue + `cancel_tts` barge-in + server-controlled `tts_done`
- T-21-02-07 (MicVAD gesture gating): `MicVAD.new()` inside `toggleVoice`, grep-verified not in useEffect
- T-21-02-08 (binaryType tampering): `ws.binaryType = 'arraybuffer'` set before any frames

## Self-Check: PASSED

- `dashboard/src/hooks/useVoice.ts` exists: FOUND
- `dashboard/src/components/VoiceButton.tsx` exists: FOUND
- `dashboard/src/hooks/voice-fsm.test.ts` modified: FOUND
- Commit `ea254cf` (Task 1 — useVoice): FOUND
- Commit `a3afec7` (Task 2 — VoiceButton): FOUND
- Commit `1006360` (Task 3 — sequence tests): FOUND
- `cd dashboard && npx vitest run` exits 0: CONFIRMED (33/33 pass)
- `cd dashboard && npx tsc --noEmit` exits 0: CONFIRMED
- MicVAD.new NOT inside useEffect: CONFIRMED (grep check passed)
- No unexpected files modified: CONFIRMED (git status --porcelain showed only voice-fsm.test.ts)
