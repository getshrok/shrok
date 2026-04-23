---
phase: 21
plan: 01
subsystem: dashboard/voice-fsm
tags: [voice, fsm, reducer, vitest, typescript, pure-function]
dependency_graph:
  requires: []
  provides: [dashboard/src/hooks/voice-fsm.ts, dashboard/vitest.config.ts]
  affects: [dashboard/src/hooks/useVoice.ts (Plan 02), dashboard/src/components/VoiceButton.tsx (Plan 02)]
tech_stack:
  added: [vitest (root-hoisted, no new install)]
  patterns: [discriminated-union-FSM, pure-reducer, TDD-red-green]
key_files:
  created:
    - dashboard/vitest.config.ts
    - dashboard/src/hooks/voice-fsm.ts
    - dashboard/src/hooks/voice-fsm.test.ts
  modified:
    - dashboard/package.json
key_decisions:
  - voiceActive boolean NOT in FSM — lives in useVoice hook (Plan 02)
  - SPEECH_START from processing is a no-op (must not barge into in-flight STT)
  - Dashboard vitest config uses node environment — no jsdom needed for pure reducers
  - Root-hoisted vitest reachable via npx from dashboard dir — no new devDependency
metrics:
  duration: ~8 minutes
  completed: 2026-04-23
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 1
---

# Phase 21 Plan 01: Voice FSM Reducer + Dashboard Test Infrastructure Summary

Dashboard-local vitest config and pure voiceFSM reducer with exhaustive transition coverage — 30 assertions, TypeScript clean.

## What Was Built

### Exported FSM Surface

```typescript
// dashboard/src/hooks/voice-fsm.ts

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking'

export type VoiceAction =
  | { type: 'TOGGLE_ON' }
  | { type: 'TOGGLE_OFF' }
  | { type: 'SPEECH_START' }
  | { type: 'SPEECH_END' }
  | { type: 'TTS_START' }
  | { type: 'TTS_DONE' }
  | { type: 'ERROR' }

export const INITIAL_VOICE_STATE: VoiceState = 'idle'
export function voiceFSM(state: VoiceState, action: VoiceAction): VoiceState
```

### Dashboard Vitest Config Shape

```typescript
// dashboard/vitest.config.ts
{
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { minForks: 0, maxForks: 1 } },
    testTimeout: 10_000,
  },
  resolve: { alias: { '@': './src' } },
}
```

Run with: `cd dashboard && npx vitest run`

### Test Coverage

30 assertions covering all 4 states × 7 actions:
- TOGGLE_OFF: any → idle (4 tests)
- ERROR: any → idle (4 tests)
- TOGGLE_ON: any → unchanged/no-op (4 tests)
- SPEECH_START: idle→listening, speaking→listening (barge-in), listening→listening (no-op), processing→processing (no barge into STT) (4 tests)
- SPEECH_END: listening→processing, idle/processing/speaking no-op (4 tests)
- TTS_START: processing→speaking, idle/listening/speaking no-op (4 tests)
- TTS_DONE: speaking→idle, idle/listening/processing no-op (4 tests)
- Exhaustiveness never-guard + unknown action runtime no-op (2 assertions, 1 test)
- INITIAL_VOICE_STATE sanity (1 test)

## Key Decisions

### voiceActive boolean NOT in the FSM

The FSM has no "voice on idle" vs "voice off idle" distinction. Both are represented as `'idle'`. The boolean `voiceActive` flag (whether voice mode is toggled on) lives in the `useVoice` hook (Plan 02). `TOGGLE_ON` is a no-op to the reducer — voiceActive is set in hook state, not FSM state. This matches 21-RESEARCH.md A5 and CONTEXT.md D-03.

### SPEECH_START from `processing` is a hard no-op

If the user speaks while STT is processing the previous utterance, the FSM stays in `processing`. This prevents double-submission and WS message ordering issues. Barge-in is only valid from `speaking` (interrupts TTS playback).

### No deviations from the 21-RESEARCH.md state table

All transitions implemented exactly match the authoritative table in 21-RESEARCH.md §State Transition Table.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this plan delivers a pure reducer with no data binding. No UI, no runtime dependencies.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. Pure in-memory reducer.

## Self-Check: PASSED

- `dashboard/vitest.config.ts` exists: FOUND
- `dashboard/src/hooks/voice-fsm.ts` exists: FOUND
- `dashboard/src/hooks/voice-fsm.test.ts` exists: FOUND
- Commit `614fd89` (Task 1): FOUND
- Commit `f75cf95` (Task 2 RED): FOUND
- Commit `3b449bd` (Task 2 GREEN): FOUND
- `cd dashboard && npx vitest run` exits 0: CONFIRMED (30/30 pass)
- `cd dashboard && npx tsc --noEmit` exits 0: CONFIRMED
