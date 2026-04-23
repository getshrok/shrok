---
gsd_state_version: 1.0
milestone: v0.1.1
milestone_name: Voice Mode
status: executing
stopped_at: Completed 23-01-PLAN.md
last_updated: "2026-04-23T15:23:52.268Z"
last_activity: 2026-04-23
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 15
  completed_plans: 11
  percent: 73
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-22)

**Core value:** Followability of the live event stream — a user should know what shrok is doing and why without parsing tool arguments
**Current focus:** Phase 23 — timezone-aware-scheduling-bootstrap-timezone-collection-via-

## Current Position

Phase: 23 (timezone-aware-scheduling-bootstrap-timezone-collection-via-) — EXECUTING
Plan: 2 of 5
Status: Ready to execute
Last activity: 2026-04-23

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 10 (this milestone)
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19 | 4 | - | - |
| 20 | 1 | - | - |
| 21 | 3 | - | - |
| 22 | 2 | - | - |

**Recent Trend:** No data yet

*Updated after each plan completion*
| Phase 21 P02 | 168 | 3 tasks | 3 files |
| Phase 21 P03 | 15 | 2 tasks | 1 files |
| Phase 22 P01 | 3 | 2 tasks | 3 files |
| Phase 22 P02 | 12 | 3 tasks | 2 files |
| Phase 23 P01 | 3 | 2 tasks | 4 files |

## Accumulated Context

### Decisions

- Voice = transport layer on top of existing text pipeline; queue/activation loop/assembler untouched
- VoiceChannelAdapter implements ChannelAdapter interface; registered with channelRouter
- WebSocket server in noServer:true mode attached to existing Express HTTP server (port 8888)
- Binary WS frames = audio (WAV in, MP3 out); JSON frames = control messages (tts_start, tts_done, cancel_tts)
- TTS playback uses MediaSource Extensions (MSE) — not decodeAudioData (cannot decode partial MP3 chunks)
- VAD (MicVAD.new()) must be gated behind user gesture — not bare useEffect — to avoid suspended AudioContext
- WASM/ONNX files require vite-plugin-static-copy; do Phase 20 before React UI work
- voicePort (8765) in config.ts is defined but unused — leave it alone
- Phase numbering continues from Phase 18
- [Phase 21]: MicVAD.new() in user-gesture context (toggleVoice callback), never in bare useEffect — satisfies AudioContext gesture requirement
- [Phase 21]: Loader2 icon from lucide-react@1.8.0 used for processing spinner (confirmed available)
- [Phase 21]: voiceState alias used in ConversationsPage to avoid shadowing existing identifiers; onToggle voids toggleVoice promise; page owns no async voice logic (D-02)
- [Phase 21]: Safari MSE audio/mpeg incompatibility confirmed out of scope for Phase 21 — Phase 22 follow-up if needed
- [Phase 22]: voice-error-timer.ts extracted as pure module for testability; DOMException .name read prevents error message disclosure (T-22-01); unmount clear() prevents stale setState (T-22-02)
- [Phase 22]: ariaLabelFor extended with optional third arg (errorMessage) — existing call sites unaffected, backward-compatible
- [Phase 22]: Error bar always in DOM (min-h-[1rem]) so aria-live assertive announces on content change not element insertion
- [Phase 23]: weekdays shape checked before weekly branch (1-5 rejected by isIntInRange); everyNDays uses min==='0'+dom-regex as discriminator; ALLOWED_DAY_INTERVALS Set gates N to {1..7}

### Roadmap Evolution

- Phase 23 added: Timezone-aware scheduling — bootstrap onboarding question + spawn_agent config write, cronTimezone field in scheduling tools, CronPicker weekdays cadence + raw fallback, settings API timezone support

### Pending Todos

None yet.

### Blockers/Concerns

- MSE Safari compatibility with audio/mpeg not fully verified — validate in Phase 21 before committing
- @ricky0123/vad-web exact version to pin after install (check changelog for encodeWAV/onSpeechEnd breaking changes)

## Session Continuity

Last session: 2026-04-23T15:23:52.263Z
Stopped at: Completed 23-01-PLAN.md
Resume file: None
