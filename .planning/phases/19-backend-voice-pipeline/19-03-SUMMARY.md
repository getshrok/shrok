---
phase: 19
plan: "03"
subsystem: voice
tags: [websocket, voice-adapter, ws, channel-adapter, tts, stt, openai]
dependency_graph:
  requires:
    - 19-01 (parseWavDuration, transcribeWav, TooShortError, InvalidWavError)
    - 19-02 (streamTts, isAbortError)
  provides:
    - src/channels/voice/adapter.ts (VoiceChannelAdapter, MAX_WAV_BYTES, VOICE_WS_PATH, SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON)
    - src/dashboard/server.ts (getHttpServer() accessor)
    - src/index.ts (VoiceChannelAdapter registered after dashboard.start())
  affects:
    - src/index.ts (startup wiring)
    - src/dashboard/server.ts (getHttpServer method)
    - package.json (ws, @types/ws as direct deps)
tech_stack:
  added:
    - ws@8.19.0 (runtime WebSocket server — was transitive, now direct)
    - "@types/ws@8.18.1" (types — now direct dev dep)
  patterns:
    - noServer WebSocketServer + http.Server 'upgrade' event routing
    - Single-socket invariant (activeSocket guard, code 4001 rejection)
    - AbortController per TTS invocation, cleared in finally block
    - vi.mock factory with require('node:events') to avoid hoisting issues
key_files:
  created:
    - src/channels/voice/adapter.ts
    - src/channels/voice/adapter.test.ts
  modified:
    - src/dashboard/server.ts
    - src/index.ts
    - package.json
    - package-lock.json
decisions:
  - "ws@8.19.0 / @types/ws@8.18.1 pinned as direct deps (were already transitive — pin makes reliance explicit per plan Pitfall 5)"
  - "getHttpServer() returns Server | null — null before .start() and after .stop(); callers must handle"
  - "non-voice upgrade URLs are left untouched (return without destroy) so future WS endpoints can coexist"
  - "vi.mock factory uses require('node:events') synchronously to access EventEmitter before top-level imports are initialized"
  - "exactOptionalPropertyTypes: MockWS.close() uses conditional property assignment instead of { code, reason } spread"
metrics:
  duration: "~9 minutes"
  completed: "2026-04-23T07:53:57Z"
  tasks_completed: 3
  files_created: 2
  files_modified: 4
---

# Phase 19 Plan 03: VoiceChannelAdapter Assembly Summary

**One-liner:** WebSocket transport adapter wiring wav/stt/tts helpers into the `/api/voice/ws` endpoint on the existing dashboard http.Server, with single-socket invariant, TTS abort control, and full unit test coverage.

## What Was Built

### `src/channels/voice/adapter.ts`

`VoiceChannelAdapter` class implementing `ChannelAdapter`:

```typescript
export class VoiceChannelAdapter implements ChannelAdapter {
  readonly id = 'voice'
  constructor(private httpServer: Server, private openai: OpenAI)
  onMessage(handler: (msg: InboundMessage) => void): void
  async start(): Promise<void>   // attaches upgrade listener; registers WSS connection handler
  async stop(): Promise<void>    // removes listener, aborts TTS, closes socket with 1001
  async send(text: string, _attachments?: Attachment[]): Promise<void>  // streamTts with fresh AbortController
}
```

Exported constants:
- `MAX_WAV_BYTES = 10 * 1024 * 1024` — hard ceiling on binary WAV frames; oversized frames logged at warn and dropped without parsing (T-19-12)
- `VOICE_WS_PATH = '/api/voice/ws'` — mount path; upgrade listener returns early for any other URL so future WS endpoints coexist (T-19-17)
- `SESSION_BUSY_CLOSE_CODE = 4001` — second-connection rejection code (T-19-10, D-03)
- `SESSION_BUSY_REASON = 'voice session already active'`

Key implementation details:

**Single-socket invariant (D-03, T-19-10):**
```typescript
private handleConnection(ws: WebSocket): void {
  if (this.activeSocket !== null) {
    ws.close(SESSION_BUSY_CLOSE_CODE, SESSION_BUSY_REASON)
    return  // existing session is NEVER dropped
  }
  this.activeSocket = ws
```

**Non-voice URL passthrough (T-19-17):**
```typescript
if (req.url !== VOICE_WS_PATH) return  // do NOT destroy — leave for future WS endpoints
```

**TTS cancel + client disconnect cleanup (T-19-13, D-07, VOICE-OUT-03):**
```typescript
ws.on('close', () => {
  if (this.activeSocket === ws) this.activeSocket = null
  this.ttsAbortController?.abort()  // cancel leaked OpenAI HTTP request
})
```

**Threat mitigations applied:**
- T-19-10: second connection rejected; first preserved
- T-19-11: TooShortError caught before Whisper call (delegated to stt.ts)
- T-19-12: 10 MB frame size gate before parseWavDuration
- T-19-13: ws.on('close') aborts ttsAbortController
- T-19-14: JSON.parse wrapped in try/catch; malformed frames silently ignored (socket NOT closed)
- T-19-17: upgrade listener only handles VOICE_WS_PATH; others returned without touching socket

### `src/channels/voice/adapter.test.ts`

14 unit tests covering:
1. `id === 'voice'`
2. Upgrade at `/api/voice/ws` sets activeSocket
3. Non-voice upgrade URL ignored (activeSocket stays null)
4. Second connection rejected with 4001; first socket preserved
5. Valid WAV binary frame routes transcript via onMessage handler (VOICE-IN-06)
6. Sub-500ms WAV dropped without calling Whisper (VOICE-IN-05)
7. Oversize (>10 MB) frame dropped without parsing (T-19-12)
8. Whitespace-only transcript dropped (no empty user_message)
9. `cancel_tts` JSON frame aborts in-flight TTS AbortController (VOICE-OUT-03)
10. Malformed JSON control frame ignored; socket not closed (T-19-14)
11. `ws.on('close')` clears activeSocket AND aborts TTS (T-19-13)
12. `send()` is no-op when no active socket
13. `send()` calls streamTts with fresh AbortController; clears on completion
14. `stop()` aborts TTS, closes socket with 1001, removes upgrade listener

**vi.mock hoisting note:** The `vi.mock('ws', ...)` factory runs before top-level imports are initialized. Mock classes are defined inside the factory using `require('node:events')` (synchronous) to get `EventEmitter`. The factory exposes classes via a `vi.hoisted()` shared container (`wsMocks`).

### `src/dashboard/server.ts` — `getHttpServer()` accessor

Added immediately after `revokeAllSessions()` (line 101), before `async start()`:

```typescript
/** Expose the underlying http.Server so channel adapters (e.g. VoiceChannelAdapter)
 *  can attach a WebSocket upgrade listener. Returns null before .start() resolves
 *  or after .stop() runs. (Phase 19 D-01) */
getHttpServer(): Server | null {
  return this.server
}
```

`Server` type was already imported at line 8 — no new imports needed.

### `src/index.ts` — Voice adapter registration

Voice adapter block inserted at lines 427–449 (after `await dashboard.start()` at line 424, before `activationLoop.setRevokeDashboardSessions` at line 451):

```typescript
if (config.openaiApiKey) {
  const httpServer = dashboard.getHttpServer()
  if (httpServer) {
    const voiceOpenai = new OpenAI({ apiKey: config.openaiApiKey })
    const voiceAdapter = new VoiceChannelAdapter(httpServer, voiceOpenai)
    voiceAdapter.onMessage(routeMessage)
    channelRouter.register(voiceAdapter)
    await voiceAdapter.start()
    channelAdapters.push(voiceAdapter)
    log.info('[startup] Voice WebSocket adapter ready at /api/voice/ws')
  } else {
    log.warn('[startup] Voice adapter skipped: dashboard.getHttpServer() returned null')
  }
} else {
  log.debug('[startup] Voice adapter skipped: OPENAI_API_KEY not set')
}
```

Added `import OpenAI from 'openai'` (line 49) and `import { VoiceChannelAdapter }` (line 71) to imports section.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vi.mock hoisting: MockWS/MockWSS classes not accessible in factory**
- **Found during:** Task 2 GREEN phase — first test run
- **Issue:** `vi.mock('ws', ...)` factories are hoisted to the top of the file before class declarations are initialized. Both the original plan's approach (classes defined at module scope above `vi.mock`) and the `vi.hoisted(() => { await import(...) })` approach failed (no async in hoisted callbacks).
- **Fix:** Moved class definitions inside the `vi.mock` factory. Used `require('node:events')` synchronously inside the factory to get `EventEmitter`. Exposed the classes to the test body via a `vi.hoisted(() => ({ MockWS: null, MockWSS: null }))` shared container that the factory populates.
- **Files modified:** `src/channels/voice/adapter.test.ts`
- **Commit:** 5992078

**2. [Rule 1 - Bug] exactOptionalPropertyTypes violation in MockWS.close()**
- **Found during:** Task 2 GREEN phase — tsc after tests passed
- **Issue:** `this.closedWith = { code, reason }` assigns `number | undefined` to `code?: number` which violates `exactOptionalPropertyTypes` (cannot explicitly set optional props to undefined).
- **Fix:** Conditional property assignment: `if (code !== undefined) closed.code = code`
- **Files modified:** `src/channels/voice/adapter.test.ts`
- **Commit:** 5992078 (same commit — both caught in same tsc pass)

## Test Results

```
Test Files  4 passed (4)   [voice suite]
Tests       36 passed      [wav:10, stt:6, tts:6, adapter:14]

Full suite: 72 passed | 3 skipped (75)
            1198 passed | 1 skipped (1199)
```

`npx tsc --noEmit` exits 0.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 6a6a884 | feat(19-03): add ws+@types/ws deps and DashboardServer.getHttpServer() |
| 2 (RED) | 62454b3 | test(19-03): add failing tests for VoiceChannelAdapter |
| 2 (GREEN) | 5992078 | feat(19-03): implement VoiceChannelAdapter with unit tests |
| 3 | d1e9594 | feat(19-03): wire VoiceChannelAdapter into startup after dashboard.start() |

## Follow-ups for Later Phases

- **Session-cookie validation on WS upgrade (T-19-16):** The upgrade listener currently accepts any client on the LAN. Phase 19 explicitly deferred ASVS V2 session-cookie validation; dashboard is localhost-bound. This should be revisited when the dashboard gets public-network exposure.
- **Voice adapter hot-reload sentinel:** Currently the voice adapter restarts only when the process restarts. A `.reload-voice` sentinel (like Discord/Telegram) could be added in a later phase if live key rotation is needed.
- **Safari MSE compatibility with audio/mpeg:** Noted in STATE.md blockers — validate before Phase 21 UI work.

## Self-Check: PASSED
