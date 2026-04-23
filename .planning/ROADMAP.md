# Roadmap: shrok

## Milestones

- ✅ **v1.0 Tool-call Legibility** - Phases 1-4 (shipped 2026-04-11)
- ✅ **v1.1 Jobs Awareness** - Phase 10 (shipped 2026-04-20)
- ✅ **v0.1.1 Color Slots** - Phase 18 (shipped 2026-04-22)
- 🚧 **v0.1.1 Voice Mode** - Phases 19-22 (in progress)

## Phases

<details>
<summary>✅ Previous Milestones (Phases 1-18) - SHIPPED</summary>

Phases 1-4: v1.0 Tool-call Legibility (shipped 2026-04-11)
Phase 10: v1.1 Jobs Awareness (shipped 2026-04-20)
Phases 11-18: Various hardening and features (shipped through 2026-04-22)

</details>

### 🚧 v0.1.1 Voice Mode (In Progress)

**Milestone Goal:** Add hands-free voice conversation to the dashboard using OpenAI Whisper (STT) and OpenAI TTS, keeping voice as a transport layer on top of the existing text message pipeline.

- [x] **Phase 19: Backend Voice Pipeline** - WebSocket audio endpoint, STT, TTS streaming, VoiceChannelAdapter wired into the existing queue and router (completed 2026-04-23)
- [x] **Phase 20: Vite Build Configuration** - VAD WASM/ONNX files in production build output, Vite dev proxy for WebSocket upgrades (completed 2026-04-23)
- [x] **Phase 21: React Voice UI & State Machine** - Mic toggle, four-state useReducer FSM, VAD on user gesture, MSE playback, barge-in (completed 2026-04-23)
- [ ] **Phase 22: Error Handling & Accessibility** - All error paths return to idle with visible feedback, ARIA labels, disconnect recovery

## Phase Details

### Phase 19: Backend Voice Pipeline
**Goal**: A working `/api/voice/ws` WebSocket endpoint accepts WAV audio, transcribes via Whisper, synthesizes responses via TTS streaming, and routes messages through the existing queue as normal user messages
**Depends on**: Phase 18
**Requirements**: VOICE-IN-03, VOICE-IN-04, VOICE-IN-05, VOICE-IN-06, VOICE-OUT-01, VOICE-OUT-02, VOICE-OUT-03, VOICE-OUT-04
**Success Criteria** (what must be TRUE):
  1. Sending a WAV binary frame to `/api/voice/ws` produces a transcript that appears in the conversation view as a normal user message bubble
  2. The server streams MP3 chunks back to the connected WebSocket client with `tts_start` and `tts_done` sentinel JSON frames framing the audio
  3. Sending a `cancel_tts` JSON frame while TTS is streaming causes the server to abort the in-flight OpenAI TTS call and stop sending audio chunks within 200ms
  4. Audio clips shorter than 500ms are silently rejected by the server without triggering a Whisper API call
  5. A test client connecting via `wscat` can complete a full round-trip (WAV in, transcript message visible, MP3 chunks received) with no additional configuration beyond `OPENAI_API_KEY`
**Plans**: 3 plans
Plans:
- [x] 19-01-PLAN.md — WAV duration parser + Whisper transcription wrapper (pure helpers + unit tests)
- [x] 19-02-PLAN.md — OpenAI TTS streaming helper with AbortController cancellation (helper + unit tests)
- [x] 19-03-PLAN.md — VoiceChannelAdapter, DashboardServer.getHttpServer(), index.ts wiring, ws direct dep
**UI hint**: no

### Phase 20: Vite Build Configuration
**Goal**: The `@ricky0123/vad-web` WASM and ONNX model files are present in the production build output and the Vite dev server proxies WebSocket upgrades to `/api/voice` so end-to-end development testing works
**Depends on**: Phase 19
**Requirements**: VOICE-UI-04, VOICE-UI-05
**Success Criteria** (what must be TRUE):
  1. Running `npm run build` in the dashboard directory produces a `dist/` folder containing the VAD WASM and ONNX model files alongside the JS assets
  2. Serving the production `dist/` statically and opening the dashboard causes VAD to initialize without any 404 errors in the browser console
  3. In `npm run dev` mode, opening `/api/voice` in a WebSocket client via the Vite dev server successfully upgrades and connects to the backend without a proxy error
**Plans**: 1 plan
Plans:
- [x] 20-01-PLAN.md — Install @ricky0123/vad-web + vite-plugin-static-copy (exact pins) and wire viteStaticCopy for 5 VAD assets + /api/voice ws:true proxy in dashboard/vite.config.ts
**UI hint**: yes

### Phase 21: React Voice UI & State Machine
**Goal**: Users can activate voice mode in the dashboard conversation view, speak hands-free with VAD detecting their speech automatically, and hear the assistant's response played back before the next turn begins
**Depends on**: Phase 20
**Requirements**: VOICE-IN-01, VOICE-IN-02, VOICE-UI-01, VOICE-UI-02, VOICE-UI-03
**Success Criteria** (what must be TRUE):
  1. A mic icon button is visible in the conversation input area and clicking it activates voice mode without any prompts or configuration beyond granting mic permission
  2. The button cycles through exactly four visually distinct states — idle, listening, processing, and speaking — and never shows two states simultaneously
  3. Speaking into the mic while in idle state causes the UI to transition to listening without the user pressing any button, and transitions to processing automatically when the user stops speaking
  4. The assistant's text response is played back as audio in the browser with the button in speaking state, and playback begins before the full synthesis is complete
  5. Saying something while the assistant is speaking (barge-in) stops audio playback immediately and transitions to listening state
**Plans**: 3 plans
Plans:
- [x] 21-01-PLAN.md — Dashboard vitest config + pure voiceFSM reducer + exhaustive transition tests
- [x] 21-02-PLAN.md — useVoice hook (FSM + VAD + WebSocket + MSE + barge-in) and pure VoiceButton component
- [x] 21-03-PLAN.md — Mount VoiceButton in ConversationsPage input row + manual E2E browser verification checkpoint
**UI hint**: yes

### Phase 22: Error Handling & Accessibility
**Goal**: Every failure path returns voice mode to idle with visible feedback, and the mic toggle is fully usable by keyboard and screen-reader users
**Depends on**: Phase 21
**Requirements**: VOICE-ERR-01, VOICE-ERR-02, VOICE-ERR-03, VOICE-ERR-04
**Success Criteria** (what must be TRUE):
  1. Denying mic permission when prompted causes voice mode to immediately return to idle with a visible error message in the UI
  2. A simulated STT API failure (e.g., bad API key during processing) causes voice mode to return to idle with a visible error message rather than hanging in processing state
  3. Closing the WebSocket connection from the server side while in any active voice state causes the UI to return to idle with a visible disconnection notice
  4. A screen reader announces the current voice state when the mic button is focused or its state changes, via an updated ARIA label
**Plans**: 2 plans
Plans:
- [x] 22-01-PLAN.md — useVoice hook error surface (errorMessage field, distinct messages per failure path, 4s auto-dismiss timer + unit tests)
- [ ] 22-02-PLAN.md — VoiceButton ARIA override + ConversationsPage error bar render + manual browser E2E checkpoint
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 19. Backend Voice Pipeline | v0.1.1 Voice Mode | 4/4 | Complete    | 2026-04-23 |
| 20. Vite Build Configuration | v0.1.1 Voice Mode | 1/1 | Complete    | 2026-04-23 |
| 21. React Voice UI & State Machine | v0.1.1 Voice Mode | 3/3 | Complete    | 2026-04-23 |
| 22. Error Handling & Accessibility | v0.1.1 Voice Mode | 1/2 | In Progress|  |

### Phase 23: Timezone-aware scheduling: bootstrap timezone collection via onboarding question + spawn_agent config write; add timezone to CONFIG_JSON_FIELDS and settings UI; add cronTimezone field (before cron in schema) to create_reminder and create_schedule tools with dynamic descriptions showing configured timezone; expand CronPicker with weekdays cadence and raw-text fallback for unrecognized patterns instead of silent DEFAULT_STATE; expand create_schedule grammar to allow 1-5 day ranges

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 22
**Plans:** 1/2 plans executed

Plans:
- [ ] TBD (run /gsd-plan-phase 23 to break down)
