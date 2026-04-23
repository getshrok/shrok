---
phase: 22-error-handling-accessibility
plan: "01"
subsystem: dashboard/voice
tags: [voice, error-handling, react-hooks, vitest, tdd]
dependency_graph:
  requires: []
  provides: [errorMessage surface on useVoice, voice-error-timer pure helper]
  affects: [dashboard/src/hooks/useVoice.ts, dashboard/src/pages/ConversationsPage.tsx (additive only)]
tech_stack:
  added: [dashboard/src/hooks/voice-error-timer.ts]
  patterns: [pure timer-reset helper, VoiceErrorMessage union type, ErrorTimerHandle interface, useCallback dependency array discipline]
key_files:
  created:
    - dashboard/src/hooks/voice-error-timer.ts
    - dashboard/src/hooks/useVoice.test.ts
  modified:
    - dashboard/src/hooks/useVoice.ts
decisions:
  - "voice-error-timer.ts extracted as a pure module (no DOM, no React) to make timer-reset semantics unit-testable in node environment"
  - "signalError useCallback has empty dep array — errorTimerRef is a stable ref, not a reactive value"
  - "setupMSE useCallback dep array extended to include signalError (required — signalError is a closure created inside the hook)"
  - "toggleVoice dep array extended to include signalError"
  - "DOMException branch reads only .name (NotAllowedError / NotFoundError), never .message — prevents raw error message disclosure (T-22-01)"
  - "Unmount useEffect calls errorTimerRef.current?.clear() before teardownAll — prevents stale setErrorMessage on unmounted component (T-22-02)"
metrics:
  duration_minutes: 3
  completed_date: "2026-04-23"
  tasks_completed: 2
  files_changed: 3
requirements_validated: [VOICE-ERR-01, VOICE-ERR-02, VOICE-ERR-03]
---

# Phase 22 Plan 01: useVoice errorMessage Surface Summary

One-liner: `useVoice` now returns `errorMessage: string | null` with three distinct hard-coded error strings, 4 s auto-dismiss via a pure `createErrorTimer` helper, and timer-reset on back-to-back errors — all covered by 5 vitest unit tests.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add errorMessage state + setErrorWithAutoDismiss helper to useVoice | b176c39 | voice-error-timer.ts (new), useVoice.ts (modified) |
| 2 | Vitest coverage for voice-error-timer auto-dismiss + reset semantics | ae9e9d9 | useVoice.test.ts (new) |

## Changes to useVoice.ts (line-range level)

- **Lines 12**: New import — `createErrorTimer, VoiceErrorMessage, ErrorTimerHandle` from `./voice-error-timer`
- **Lines 14-19**: `UseVoiceReturn` interface extended with `errorMessage: string | null`
- **Line 30**: New state: `const [errorMessage, setErrorMessage] = useState<string | null>(null)`
- **Line 42**: New ref: `const errorTimerRef = useRef<ErrorTimerHandle | null>(null)`
- **Lines 47-54**: New mount useEffect — initialises `errorTimerRef.current` via `createErrorTimer`, clears on unmount
- **Lines 56-60**: New `signalError` useCallback — delegates to `errorTimerRef.current?.setError`
- **Line 92**: MSE `addSourceBuffer` catch — added `signalError('Voice error — please try again')` before `dispatch({ type: 'ERROR' })`
- **Line 97**: `setupMSE` useCallback dep array extended with `signalError`
- **Lines 169-170**: WS `close` handler (unexpected branch) — added `signalError('Voice disconnected')` before `dispatch`
- **Lines 176-177**: WS `error` handler — added `signalError('Voice disconnected')` before `dispatch`
- **Lines 221-230**: `toggleVoice` outer catch — signature changed to `catch (err)`, DOMException branch sets `'Microphone access denied'` vs `'Voice error — please try again'`
- **Line 231**: `toggleVoice` dep array extended with `signalError`
- **Line 236**: Unmount useEffect — added `errorTimerRef.current?.clear()` before `teardownAll()`
- **Line 244**: Return statement now includes `errorMessage`

## voice-error-timer.ts Public API

```typescript
export type VoiceErrorMessage =
  | 'Microphone access denied'
  | 'Voice disconnected'
  | 'Voice error — please try again'

export interface ErrorTimerHandle {
  setError(message: VoiceErrorMessage): void  // resets 4000ms timer on each call
  clear(): void                                // cancels timer + calls onClear synchronously
}

export function createErrorTimer(
  onSet: (m: VoiceErrorMessage) => void,
  onClear: () => void,
  setTimeoutFn?: typeof setTimeout,   // injectable for tests
  clearTimeoutFn?: typeof clearTimeout,
  ttlMs?: number,                     // defaults to 4000
): ErrorTimerHandle
```

## Test File Coverage

**5 tests in 2 describe blocks** — all passing:

1. `calls onSet exactly once with the message` — verifies onSet call count and argument
2. `calls onClear exactly once after 4000ms` — verifies 3999ms does NOT trigger, 4000ms does
3. `resets the dismiss timer on a second setError (D-06)` — timer-reset: second error at t=2000 delays clear to t=6000
4. `clear() cancels a pending timer` — synchronous onClear + no second call after 10s advance
5. `admits only the three whitelisted strings` — compile-time + runtime assertion on VoiceErrorMessage union

No vitest-2-specific quirks encountered. `vi.useFakeTimers()` / `vi.advanceTimersByTime()` worked correctly without any global timer injection — `createErrorTimer` uses the default `setTimeout`/`clearTimeout` globals, which vitest's fake timer system replaces.

## ERROR Dispatch Site Audit

`grep -c "dispatch({ type: 'ERROR' })" dashboard/src/hooks/useVoice.ts` returns **4** — unchanged from before this plan:

1. `setupMSE` > `ms.addEventListener('sourceopen')` > `addSourceBuffer` catch (line ~93)
2. `ws.addEventListener('close')` unexpected branch (line ~170)
3. `ws.addEventListener('error')` handler (line ~177)
4. `toggleVoice` outer catch (line ~228)

All four now have a corresponding `signalError(...)` call immediately before `dispatch({ type: 'ERROR' })`.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. `errorMessage` is fully wired: state → hook → return value. Plan 02 consumes it to render the visible error bar and override ARIA label.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. Error strings are hard-coded constants (T-22-01 mitigation in place). Timer ref is cleared on unmount (T-22-02 mitigation in place).

## Self-Check

See section below after running checks.
