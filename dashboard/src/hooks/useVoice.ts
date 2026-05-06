// dashboard/src/hooks/useVoice.ts
//
// Single owner of voice-mode side effects: FSM, VAD, WebSocket, MSE playback, barge-in.
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
}

function buildWsUrl(): string {
  // /api/voice/ws is proxied in dev by vite.config.ts (ws: true) to localhost:8888
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/voice/ws`
}

// iOS PWA mode (home-screen web app) exposes ManagedMediaSource instead of the
// standard MediaSource. They share the same interface so we treat them identically.
type MediaSourceCtor = typeof MediaSource
function getMediaSourceCtor(): MediaSourceCtor | null {
  if (typeof MediaSource !== 'undefined') return MediaSource
  const w = window as unknown as { ManagedMediaSource?: MediaSourceCtor }
  return w.ManagedMediaSource ?? null
}

export function useVoice(): UseVoiceReturn {
  const [state, dispatch] = useReducer(voiceFSM, INITIAL_VOICE_STATE)
  const [voiceActive, setVoiceActive] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Mutable handles — all accessed from VAD/WS callbacks which capture stale React state
  // (Pitfall 5). stateRef is kept in sync via a useEffect below.
  const vadRef = useRef<MicVAD | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const chunkQueueRef = useRef<ArrayBuffer[]>([])
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
  }, [teardownMSE])

  // --- Toggle ---------------------------------------------------------------

  const toggleVoice = useCallback(async (): Promise<void> => {
    if (voiceActiveRef.current) {
      // --- EXIT voice mode ---
      await teardownAll()
      dispatch({ type: 'TOGGLE_OFF' })
      setVoiceActive(false)
      return
    }

    // --- ENTER voice mode (user-gesture context — D-09, Pattern 2) ---
    // MicVAD.new must be called from a user gesture; we do so synchronously here.
    try {
      // Pre-flight: MediaSource (or ManagedMediaSource on iOS PWA) required for TTS playback.
      if (!getMediaSourceCtor()) {
        signalError('Voice requires iOS 17.1+ or Chrome on Android')
        dispatch({ type: 'ERROR' })
        return
      }

      // 1. Open WS first so we can send audio as soon as speech ends.
      const ws = new WebSocket(buildWsUrl())
      ws.binaryType = 'arraybuffer' // Pitfall 6 — MUST be set before any binary frames arrive.
      wsRef.current = ws

      ws.addEventListener('message', (evt: MessageEvent) => {
        if (evt.data instanceof ArrayBuffer) {
          // Binary = MP3 chunk; queue and flush.
          chunkQueueRef.current.push(evt.data)
          flushChunkQueue()
          return
        }
        if (typeof evt.data === 'string') {
          try {
            const msg = JSON.parse(evt.data) as { type?: string }
            if (msg.type === 'tts_start') dispatch({ type: 'TTS_START' })
            else if (msg.type === 'tts_done') {
              const ms = mediaSourceRef.current
              if (ms && ms.readyState === 'open') { try { ms.endOfStream() } catch { /* noop */ } }
              dispatch({ type: 'TTS_DONE' })
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

      // 2. Set up MSE audio element (does nothing until tts_start arrives).
      const audioEl = setupMSE()
      // Pitfall 3: tie play() to the user gesture. Start a silent play() that
      // resolves once MSE source is ready; rejection is fine here.
      audioEl.play().catch(() => { /* autoplay policy may reject; retry on tts_start */ })

      // 3. Initialise MicVAD with callbacks that use refs (Pitfall 5).
      const vad = await MicVAD.new({
        model: 'legacy',
        baseAssetPath: '/',
        onnxWASMBasePath: '/',
        onSpeechStart: () => {
          if (stateRef.current === 'speaking') {
            // Barge-in (Pitfall 4): stop local playback + tell server to cancel TTS.
            teardownMSE()
            try { wsRef.current?.send(JSON.stringify({ type: 'cancel_tts' })) } catch { /* noop */ }
            // Recreate MSE for the next turn; capture new element and start play.
            const newAudioEl = setupMSE()
            newAudioEl.play().catch(() => { /* autoplay policy may reject; retry on tts_start */ })
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
  }, [flushChunkQueue, setupMSE, signalError, teardownAll, teardownMSE])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void teardownAll()
      dispatch({ type: 'TOGGLE_OFF' })
      setVoiceActive(false)
      voiceActiveRef.current = false
    }
  }, [teardownAll])

  return { state, voiceActive, toggleVoice, errorMessage }
}
