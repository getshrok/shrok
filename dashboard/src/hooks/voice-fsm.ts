// Pure finite-state machine for the dashboard voice UI.
// No React imports. No browser APIs. Unit-testable in a node environment.
// See 21-RESEARCH.md §Pattern 1 and §State Transition Table for the authoritative spec.

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

export function voiceFSM(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'TOGGLE_OFF':
      return 'idle'
    case 'ERROR':
      return 'idle'
    case 'TOGGLE_ON':
      // FSM stays put; `voiceActive` is tracked separately in the useVoice hook
      // to distinguish "voice off idle" from "voice on idle" (see 21-RESEARCH.md A5).
      return state
    case 'SPEECH_START':
      // idle → listening (normal)
      // speaking → listening (barge-in per D-08, Pitfall 4)
      // listening/processing → unchanged (MUST NOT barge into in-flight STT)
      if (state === 'idle' || state === 'speaking') return 'listening'
      return state
    case 'SPEECH_END':
      return state === 'listening' ? 'processing' : state
    case 'TTS_START':
      return state === 'processing' ? 'speaking' : state
    case 'TTS_DONE':
      return state === 'speaking' ? 'idle' : state
    default: {
      // Exhaustiveness guard — if a new VoiceAction variant is added without a
      // corresponding case, TypeScript will complain here (action: never).
      const _exhaustive: never = action
      void _exhaustive
      return state
    }
  }
}
