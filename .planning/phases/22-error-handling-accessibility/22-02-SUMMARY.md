---
phase: 22-error-handling-accessibility
plan: "02"
subsystem: dashboard/voice
tags: [voice, error-handling, accessibility, aria, react, manual-e2e]
dependency_graph:
  requires: [errorMessage surface on useVoice (Plan 01)]
  provides: [voice error bar UI, VoiceButton ARIA label override, VOICE-ERR-01 through VOICE-ERR-04 observable]
  affects:
    - dashboard/src/components/VoiceButton.tsx
    - dashboard/src/pages/ConversationsPage.tsx
tech_stack:
  added: []
  patterns: [optional prop with null default, aria-live assertive always-in-DOM pattern, ariaLabelFor third-arg extension]
key_files:
  created: []
  modified:
    - dashboard/src/components/VoiceButton.tsx
    - dashboard/src/pages/ConversationsPage.tsx
decisions:
  - "ariaLabelFor extended with optional third arg (errorMessage) — existing call sites unaffected, backward-compatible"
  - "Error bar always in DOM (min-h-[1rem]) so aria-live assertive announces on content change, not on element insertion"
  - "voiceError alias used in ConversationsPage to avoid shadowing; errorMessage passed as prop (not inline computed)"
  - "VoiceButton OFF-state title stays static string — no per-state variation needed for the inactive mic icon"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-23"
  tasks_completed: 3
  files_changed: 2
requirements_validated: [VOICE-ERR-01, VOICE-ERR-02, VOICE-ERR-03, VOICE-ERR-04]
---

# Phase 22 Plan 02: VoiceButton ARIA Override + ConversationsPage Error Bar Summary

One-liner: ConversationsPage renders an always-present `aria-live="assertive"` error bar showing `⚠️ {message}` in red when voice errors occur, and VoiceButton's aria-label is prepended with the error text via an extended `ariaLabelFor` signature — closing the loop on all four VOICE-ERR-* success criteria.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Extend VoiceButton with errorMessage prop + override ariaLabelFor | 2e3ffd8 | dashboard/src/components/VoiceButton.tsx |
| 2 | Render error bar in ConversationsPage + wire errorMessage into VoiceButton | 9a9ae50 | dashboard/src/pages/ConversationsPage.tsx |
| 3 | Manual browser E2E — verify all four VOICE-ERR-* success criteria | (checkpoint: human-verified, approved) | — |

## VoiceButton Changes

**Props interface delta:**
```typescript
// Added optional field:
errorMessage?: string | null
```

**ariaLabelFor signature delta:**
```typescript
// Before:
function ariaLabelFor(voiceActive: boolean, state: VoiceState): string

// After:
function ariaLabelFor(voiceActive: boolean, state: VoiceState, errorMessage?: string | null): string
// When errorMessage is non-empty: returns `${errorMessage} — ${base}`
// When null/undefined/empty: returns base label unchanged (VOICE-ERR-04 preserved)
```

**Call sites updated:** Three total — two `aria-label={ariaLabelFor(..., errorMessage)}` (OFF state + voice-active state) and one `title={ariaLabelFor(true, state, errorMessage)}`.

## ConversationsPage Changes

**Destructure line (~486):**
```typescript
// Before:
const { state: voiceState, voiceActive, toggleVoice } = useVoice()

// After:
const { state: voiceState, voiceActive, toggleVoice, errorMessage: voiceError } = useVoice()
```

**Error bar markup inserted above `<div className="flex gap-2">` input row:**
```tsx
{/* Voice error bar — always in the DOM so aria-live announcements fire reliably */}
<div
  role="status"
  aria-live="assertive"
  aria-atomic="true"
  className="min-h-[1rem] mb-1 text-red-400 text-xs"
>
  {voiceError ? `⚠️ ${voiceError}` : ''}
</div>
```

**VoiceButton render updated** to pass `errorMessage={voiceError}`.

## Manual Browser E2E Results (Task 3)

User verified all five verification sections and typed "approved":

1. **VOICE-ERR-01 (mic denied):** Error bar appeared reading `⚠️ Microphone access denied` in small red text; mic returned to idle; auto-dismissed after ~4s. PASS.
2. **VOICE-ERR-02 (bad API key / STT failure):** WebSocket closed after server error; bar showed `⚠️ Voice disconnected`; mic returned to idle; auto-dismissed. PASS.
3. **VOICE-ERR-03 (backend kill):** Within ~1s of killing port 8888, bar showed `⚠️ Voice disconnected`; mic returned to off/idle. PASS.
4. **VOICE-ERR-04 (ARIA label):** Focused mic button showed "Voice mode on — waiting for speech" idle; transitioned correctly through listening/processing labels; with error active, label was prefixed (e.g. `"Microphone access denied — Activate voice mode"`); returned to normal label after 4s. PASS.
5. **Regression:** Normal voice round-trip still works; `npx vitest run` exits 0; `npx tsc --noEmit` exits 0. PASS.

## Build Verification

- `cd dashboard && npx tsc --noEmit` — exits 0
- `cd dashboard && npx vitest run` — exits 0 (all Phase 21 + Phase 22 Plan 01 tests pass)
- `cd dashboard && npm run build` — exits 0 (Tailwind purge retains text-red-400)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. The error bar and ARIA override are fully wired end-to-end: `createErrorTimer` → `signalError` → `errorMessage` state → `useVoice` return → `ConversationsPage` destructure → error bar render + `VoiceButton errorMessage` prop → `ariaLabelFor` override.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. All threat mitigations from the plan's threat register are confirmed in place:
- T-22-05: Error strings are three hard-coded constants; no server bodies or stack traces reach the DOM.
- T-22-06: `aria-label` set via React attribute binding (auto-escaped); three-string whitelist from Plan 01 eliminates injection vectors.
- T-22-07: `aria-live` container receives content only from `voiceError` state; no third-party script access.
- T-22-08: Timer-reset in `createErrorTimer` (Plan 01) prevents timer leaks from rapid error fires.

## Self-Check

- [x] `dashboard/src/components/VoiceButton.tsx` — exists and contains `errorMessage`
- [x] `dashboard/src/pages/ConversationsPage.tsx` — exists and contains `aria-live="assertive"`
- [x] Commit 2e3ffd8 — exists (Task 1)
- [x] Commit 9a9ae50 — exists (Task 2)
- [x] Task 3 — human-verified, user approved

## Self-Check: PASSED
