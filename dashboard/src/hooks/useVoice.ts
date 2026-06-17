// dashboard/src/hooks/useVoice.ts
//
// Single owner of voice-mode side effects: FSM, VAD, WebSocket, playback, barge-in.
// Playback has two paths chosen by capability: streaming MSE where MP3-in-MSE is
// supported (Chrome), and buffered Web Audio on Safari/iOS where it isn't.
// VoiceButton is purely presentational — it renders the state this hook exposes.
//
// Implements locked decisions D-01, D-03, D-07, D-09, D-10 from 21-CONTEXT.md
// and mitigates Pitfalls 1-6 from 21-RESEARCH.md.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { MicVAD, utils } from '@ricky0123/vad-web'
import { voiceFSM, INITIAL_VOICE_STATE, type VoiceState } from './voice-fsm'
import { createErrorTimer, type VoiceErrorMessage, type ErrorTimerHandle } from './voice-error-timer'

export interface UseVoiceReturn {
  state: VoiceState
  voiceActive: boolean
  toggleVoice: () => Promise<void>
  errorMessage: string | null    // D-04: distinct message per failure class, 4s auto-dismiss
  /** True when the most recent spoken turn was synthesized by the OpenAI (paid)
   *  fallback because the self-hosted TTS endpoint was unreachable. Drives a visible
   *  "via OpenAI fallback" badge so paid usage is never silent. Cleared when a turn
   *  is served by the self-hosted endpoint again, and on voice-mode exit. */
  ttsViaFallback: boolean
}

/** Pure predicate (DOM-free): returns true when the MediaSource needs to be recreated.
 *  - null/undefined → no MSE exists yet → must create
 *  - readyState 'ended' → tts_done called endOfStream(); turn 2 must recreate
 *  - readyState 'closed' → unusable
 *  - readyState 'open' → still usable, no recreate needed */
export function needsFreshMSE(ms: { readyState: string } | null | undefined): boolean {
  if (ms == null) return true
  return ms.readyState !== 'open'
}

export function buildWsUrl(head: string): string {
  // /api/voice/ws is proxied in dev by vite.config.ts (ws: true) to localhost:8888
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/voice/ws?head=${encodeURIComponent(head)}`
}

// iOS PWA mode (home-screen web app) exposes ManagedMediaSource instead of the
// standard MediaSource. They share the same interface so we treat them identically.
type MediaSourceCtor = typeof MediaSource
function getMediaSourceCtor(): MediaSourceCtor | null {
  if (typeof MediaSource !== 'undefined') return MediaSource
  const w = window as unknown as { ManagedMediaSource?: MediaSourceCtor }
  return w.ManagedMediaSource ?? null
}

// Streaming MSE playback only works where MP3 is a supported MSE codec — Chrome
// and friends. Safari/iOS has NEVER supported 'audio/mpeg' in (Managed)MediaSource,
// so feeding it the server's raw MP3 chunks silently fails. We detect that by
// capability (not UA) and fall back to buffered <audio>-element playback there.
function canStreamMp3(): boolean {
  // Only the STANDARD MediaSource (Chrome, Android, most desktop) streams MP3
  // reliably. iOS Safari exposes ManagedMediaSource instead — it reports
  // isTypeSupported('audio/mpeg') === true, but its streaming contract
  // (disableRemotePlayback + startstreaming/endstreaming gating) means our
  // eagerly-appended MP3 chunks never actually play. So ManagedMediaSource is
  // deliberately NOT treated as stream-capable here — it routes to buffered
  // <audio> playback, which plays plain MP3 on iOS without ceremony.
  if (typeof MediaSource === 'undefined') return false
  return typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported('audio/mpeg')
}

// A 1-sample silent WAV as a data URL. Played once inside the user gesture to
// "unlock" an <audio> element on iOS so later programmatic .play() calls work.
// Built lazily (uses btoa) so importing this module stays browser-API-free for
// the node/unit-test environment.
function silentClipDataUrl(): string {
  const sampleRate = 8000
  const dataSize = 2 // one 16-bit sample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE')
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  writeStr(36, 'data'); view.setUint32(40, dataSize, true)
  let bin = ''
  new Uint8Array(buffer).forEach(b => { bin += String.fromCharCode(b) })
  return 'data:audio/wav;base64,' + btoa(bin)
}

export function useVoice(selectedHead: string): UseVoiceReturn {
  const [state, dispatch] = useReducer(voiceFSM, INITIAL_VOICE_STATE)
  const [voiceActive, setVoiceActive] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [ttsViaFallback, setTtsViaFallback] = useState(false)

  // Mutable handles — all accessed from VAD/WS callbacks which capture stale React state
  // (Pitfall 5). stateRef is kept in sync via a useEffect below.
  const vadRef = useRef<MicVAD | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const chunkQueueRef = useRef<ArrayBuffer[]>([])
  // Buffered (Safari/iOS) playback handles — unused on the streaming MSE path.
  const bufAudioRef = useRef<HTMLAudioElement | null>(null)
  const bufUrlRef = useRef<string | null>(null)   // current blob object URL (revoked per turn)
  const streamMp3Ref = useRef(false)   // playback mode for this voice session
  const stateRef = useRef<VoiceState>(INITIAL_VOICE_STATE)
  const voiceActiveRef = useRef(false)
  const errorTimerRef = useRef<ErrorTimerHandle | null>(null)

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { voiceActiveRef.current = voiceActive }, [voiceActive])

  // Initialise the error timer once on mount; clear on unmount (T-22-02).
  useEffect(() => {
    errorTimerRef.current = createErrorTimer(
      (m) => setErrorMessage(m),
      () => setErrorMessage(null),
    )
    return () => { errorTimerRef.current?.clear() }
  }, [])

  // --- Error signalling -----------------------------------------------------

  const signalError = useCallback((message: VoiceErrorMessage) => {
    errorTimerRef.current?.setError(message)
  }, [])

  // --- MSE plumbing ---------------------------------------------------------

  const flushChunkQueue = useCallback(() => {
    const sb = sourceBufferRef.current
    if (!sb || sb.updating) return
    const next = chunkQueueRef.current.shift()
    if (!next) return
    try {
      sb.appendBuffer(new Uint8Array(next))
    } catch {
      // Pitfall 2: if appendBuffer throws (rare race), drop this chunk; the next
      // updateend will pull the next one.
    }
  }, [])

  const setupMSE = useCallback((): HTMLAudioElement => {
    const MS = getMediaSourceCtor()!  // null-checked in toggleVoice before this is called
    const audioEl = new Audio()
    const ms = new MS()
    audioEl.src = URL.createObjectURL(ms)
    audioElRef.current = audioEl
    mediaSourceRef.current = ms
    ms.addEventListener('sourceopen', () => {
      // Pitfall 1: Safari does not support 'audio/mpeg' in MSE. Runtime gate:
      const mime = MS.isTypeSupported('audio/mpeg') ? 'audio/mpeg' : 'audio/mp4'
      try {
        const sb = ms.addSourceBuffer(mime)
        sourceBufferRef.current = sb
        sb.addEventListener('updateend', flushChunkQueue)
      } catch {
        // MSE not supported at all — signal error; caller will tear down.
        signalError('Voice error — please try again')
        dispatch({ type: 'ERROR' })
      }
    })
    return audioEl
  }, [flushChunkQueue, signalError])

  const teardownMSE = useCallback(() => {
    const ms = mediaSourceRef.current
    const audioEl = audioElRef.current
    try { audioEl?.pause() } catch { /* noop */ }
    if (ms && ms.readyState === 'open') { try { ms.endOfStream() } catch { /* noop */ } }
    if (audioEl?.src) { try { URL.revokeObjectURL(audioEl.src) } catch { /* noop */ }; audioEl.src = '' }
    chunkQueueRef.current = []
    sourceBufferRef.current = null
    mediaSourceRef.current = null
    audioElRef.current = null
  }, [])

  // --- Teardown (shared by explicit toggle-off, ERROR, and unmount) ---------

  // Ensures the MediaSource is in 'open' state before a new TTS turn begins.
  // If the MS is 'ended' (from the prior tts_done endOfStream) or missing, tears down
  // and recreates a fresh one. No-op when the MS is already 'open' (turn 1 path).
  const ensureLiveMSE = useCallback((): void => {
    if (needsFreshMSE(mediaSourceRef.current)) {
      teardownMSE()
      const audioEl = setupMSE()
      audioEl.play().catch(() => { /* autoplay policy may reject */ })
    }
  }, [teardownMSE, setupMSE])

  // --- Buffered playback (Safari/iOS — MP3-in-MSE unsupported) --------------
  // Collect a turn's MP3 chunks and play the whole clip through a single
  // <audio> element. Chosen over Web Audio deliberately: HTMLMediaElement audio
  // plays through the iPhone's hardware mute switch, whereas the Web Audio API
  // is silenced by it. The element is unlocked once inside the user gesture
  // (see toggleVoice) so later programmatic .play() calls are allowed on iOS.
  // Tradeoff vs MSE: playback starts after the full reply arrives (no streaming).

  const stopBufferedPlayback = useCallback((): void => {
    const el = bufAudioRef.current
    if (el) {
      el.onended = null   // null first so pause() can't fire our TTS_DONE
      try { el.pause() } catch { /* noop */ }
    }
  }, [])

  // Assemble the accumulated chunks into one MP3 blob and play it. Dispatches
  // TTS_DONE when the clip ends (or immediately on an empty/failed turn) so the
  // FSM leaves 'speaking' — which keeps barge-in live for the whole reply.
  const playBufferedTurn = useCallback((): void => {
    const el = bufAudioRef.current
    const chunks = chunkQueueRef.current
    chunkQueueRef.current = []
    if (!el || chunks.length === 0) { dispatch({ type: 'TTS_DONE' }); return }
    const blob = new Blob(chunks, { type: 'audio/mpeg' })
    if (bufUrlRef.current) { try { URL.revokeObjectURL(bufUrlRef.current) } catch { /* noop */ } }
    const url = URL.createObjectURL(blob)
    bufUrlRef.current = url
    el.onended = () => {
      try { void vadRef.current?.start() } catch { /* noop */ }   // resume mic after the reply
      dispatch({ type: 'TTS_DONE' })
    }
    el.src = url
    // Half-duplex on the buffered (phone) path: pause the mic while the reply
    // plays so the speaker output isn't picked up as "speech" and used to
    // barge-in — which was truncating the reply after a few words. The mic
    // resumes in onended (and in the catch below if playback never starts).
    try { void vadRef.current?.pause() } catch { /* noop */ }
    el.play().catch(() => {
      try { void vadRef.current?.start() } catch { /* noop */ }
      dispatch({ type: 'TTS_DONE' })
    })
  }, [])

  const teardownBuffered = useCallback((): void => {
    stopBufferedPlayback()
    const el = bufAudioRef.current
    bufAudioRef.current = null
    if (bufUrlRef.current) { try { URL.revokeObjectURL(bufUrlRef.current) } catch { /* noop */ }; bufUrlRef.current = null }
    if (el) { try { el.removeAttribute('src'); el.load() } catch { /* noop */ } }
    chunkQueueRef.current = []
  }, [stopBufferedPlayback])

  const teardownAll = useCallback(async () => {
    if (vadRef.current) {
      try { await vadRef.current.destroy() } catch { /* noop */ }
      vadRef.current = null
    }
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null   // null first — close handler checks wsRef, not the event
      try { ws.close() } catch { /* noop */ }
    }
    teardownMSE()
    teardownBuffered()
  }, [teardownMSE, teardownBuffered])

  // --- Toggle ---------------------------------------------------------------

  const toggleVoice = useCallback(async (): Promise<void> => {
    if (voiceActiveRef.current) {
      // --- EXIT voice mode ---
      await teardownAll()
      dispatch({ type: 'TOGGLE_OFF' })
      setVoiceActive(false)
      setTtsViaFallback(false)
      return
    }

    // --- ENTER voice mode (user-gesture context — D-09, Pattern 2) ---
    // MicVAD.new must be called from a user gesture; we do so synchronously here.
    try {
      // Pre-flight: need either streaming MSE (MP3-capable) or an <audio> element.
      if (!canStreamMp3() && typeof Audio === 'undefined') {
        signalError('Voice requires iOS 17.1+ or Chrome on Android')
        dispatch({ type: 'ERROR' })
        return
      }
      // Pick the playback path once per session. Chrome → streaming MSE;
      // Safari/iOS (no MP3-in-MSE) → buffered <audio>-element playback.
      const streamMp3 = canStreamMp3()
      streamMp3Ref.current = streamMp3

      // 1. Open WS first so we can send audio as soon as speech ends.
      const ws = new WebSocket(buildWsUrl(selectedHead))
      ws.binaryType = 'arraybuffer' // Pitfall 6 — MUST be set before any binary frames arrive.
      wsRef.current = ws

      ws.addEventListener('message', (evt: MessageEvent) => {
        if (evt.data instanceof ArrayBuffer) {
          // Binary = MP3 chunk. Always accumulate; streaming mode also flushes to MSE.
          chunkQueueRef.current.push(evt.data)
          if (streamMp3Ref.current) flushChunkQueue()
          return
        }
        if (typeof evt.data === 'string') {
          try {
            const msg = JSON.parse(evt.data) as { type?: string; fallback?: boolean }
            if (msg.type === 'tts_start') {
              // Visible-fallback badge: server flags fallback:true when the OpenAI
              // (paid) path served this turn because the self-hosted box was down.
              // Reflect the latest turn so the badge clears once self-hosted returns.
              setTtsViaFallback(msg.fallback === true)
              if (streamMp3Ref.current) ensureLiveMSE()
              else chunkQueueRef.current = []   // start fresh capture for this turn
              dispatch({ type: 'TTS_START' })
            }
            else if (msg.type === 'tts_done') {
              if (streamMp3Ref.current) {
                const ms = mediaSourceRef.current
                if (ms && ms.readyState === 'open') { try { ms.endOfStream() } catch { /* noop */ } }
                dispatch({ type: 'TTS_DONE' })
              } else {
                // Buffered: decode + play the whole clip now. TTS_DONE is
                // dispatched by playBufferedTurn when the clip actually ends,
                // keeping the FSM in 'speaking' (and barge-in live) during playback.
                void playBufferedTurn()
              }
            }
          } catch { /* malformed JSON — ignore */ }
        }
      })

      ws.addEventListener('close', () => {
        // wsRef.current is null if WE closed it intentionally — skip spurious ERROR.
        if (wsRef.current !== null && voiceActiveRef.current) {
          // Unexpected disconnect during active voice mode — D-10.
          signalError('Voice disconnected')
          dispatch({ type: 'ERROR' })
          void teardownAll()
          setVoiceActive(false)
        }
      })
      ws.addEventListener('error', () => {
        // wsRef is nulled by teardownAll before ws.close() — guard mirrors the close handler.
        if (wsRef.current === null || !voiceActiveRef.current) return
        signalError('Voice disconnected')
        dispatch({ type: 'ERROR' })
        void teardownAll()
        setVoiceActive(false)
      })

      // 2. Set up playback, primed inside this user gesture (autoplay policy).
      if (streamMp3) {
        // Streaming MSE (Chrome): element does nothing until tts_start arrives.
        const audioEl = setupMSE()
        // Pitfall 3: tie play() to the user gesture so later chunks play.
        audioEl.play().catch(() => { /* autoplay policy may reject; retry on tts_start */ })
      } else {
        // Buffered <audio> (Safari/iOS): create the element and unlock it NOW,
        // inside the gesture, by playing a silent clip — so later programmatic
        // .play() calls (one per reply) are allowed by iOS autoplay policy.
        const el = new Audio()
        el.preload = 'auto'
        bufAudioRef.current = el
        el.src = silentClipDataUrl()
        el.play().catch(() => { /* best-effort unlock; per-turn play retries */ })
      }

      // 3. Initialise MicVAD with callbacks that use refs (Pitfall 5).
      const vad = await MicVAD.new({
        model: 'legacy',
        baseAssetPath: '/',
        onnxWASMBasePath: '/',
        // How long to wait after you stop talking before deciding you're
        // finished and sending the clip. Library default is 1400ms; bumped
        // to 3000ms so it doesn't cut off mid-sentence pauses.
        redemptionMs: 3000,
        onSpeechStart: () => {
          if (stateRef.current === 'speaking') {
            // Barge-in (Pitfall 4): stop local playback + tell server to cancel TTS.
            if (streamMp3Ref.current) {
              teardownMSE()
              try { wsRef.current?.send(JSON.stringify({ type: 'cancel_tts' })) } catch { /* noop */ }
              // Recreate MSE for the next turn; capture new element and start play.
              const newAudioEl = setupMSE()
              newAudioEl.play().catch(() => { /* autoplay policy may reject; retry on tts_start */ })
            } else {
              // Buffered: stop the current clip and drop any partial capture.
              stopBufferedPlayback()
              chunkQueueRef.current = []
              try { wsRef.current?.send(JSON.stringify({ type: 'cancel_tts' })) } catch { /* noop */ }
            }
          }
          dispatch({ type: 'SPEECH_START' })
        },
        onSpeechEnd: (audio: Float32Array) => {
          try {
            const wav = utils.encodeWAV(audio)
            wsRef.current?.send(wav)
          } catch { /* noop — if WS dropped, the close handler already dispatched ERROR */ }
          dispatch({ type: 'SPEECH_END' })
        },
        onVADMisfire: () => {
          // Speech too short — no audio sent. FSM stays in 'listening'; the next
          // speech turn will re-trigger SPEECH_START (idempotent no-op per voiceFSM).
        },
      })
      vadRef.current = vad
      await vad.start()

      dispatch({ type: 'TOGGLE_ON' })
      setVoiceActive(true)
    } catch (err) {
      // Any failure during setup → full teardown + ERROR (FSM returns to idle).
      const isPermissionDenial =
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
      signalError(isPermissionDenial ? 'Microphone access denied' : 'Voice error — please try again')
      dispatch({ type: 'ERROR' })
      await teardownAll()
      setVoiceActive(false)
    }
  }, [ensureLiveMSE, flushChunkQueue, playBufferedTurn, selectedHead, setupMSE, signalError, stopBufferedPlayback, teardownAll, teardownMSE])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void teardownAll()
      dispatch({ type: 'TOGGLE_OFF' })
      setVoiceActive(false)
      voiceActiveRef.current = false
    }
  }, [teardownAll])

  return { state, voiceActive, toggleVoice, errorMessage, ttsViaFallback }
}
