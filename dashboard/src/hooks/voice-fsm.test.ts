import { describe, it, expect } from 'vitest'
import { voiceFSM, INITIAL_VOICE_STATE, type VoiceState, type VoiceAction } from './voice-fsm'

const STATES: VoiceState[] = ['idle', 'listening', 'processing', 'speaking']

describe('voiceFSM — initial state', () => {
  it('starts in idle', () => {
    expect(INITIAL_VOICE_STATE).toBe('idle')
  })
})

describe('voiceFSM — TOGGLE_OFF: any → idle', () => {
  for (const from of STATES) {
    it(`${from} + TOGGLE_OFF → idle`, () => {
      expect(voiceFSM(from, { type: 'TOGGLE_OFF' })).toBe('idle')
    })
  }
})

describe('voiceFSM — ERROR: any → idle', () => {
  for (const from of STATES) {
    it(`${from} + ERROR → idle`, () => {
      expect(voiceFSM(from, { type: 'ERROR' })).toBe('idle')
    })
  }
})

describe('voiceFSM — TOGGLE_ON: no-op (FSM unchanged)', () => {
  for (const from of STATES) {
    it(`${from} + TOGGLE_ON → ${from}`, () => {
      expect(voiceFSM(from, { type: 'TOGGLE_ON' })).toBe(from)
    })
  }
})

describe('voiceFSM — SPEECH_START', () => {
  it('idle → listening', () => {
    expect(voiceFSM('idle', { type: 'SPEECH_START' })).toBe('listening')
  })
  it('speaking → listening (barge-in)', () => {
    expect(voiceFSM('speaking', { type: 'SPEECH_START' })).toBe('listening')
  })
  it('listening → listening (no-op)', () => {
    expect(voiceFSM('listening', { type: 'SPEECH_START' })).toBe('listening')
  })
  it('processing → processing (NEVER barge into STT)', () => {
    expect(voiceFSM('processing', { type: 'SPEECH_START' })).toBe('processing')
  })
})

describe('voiceFSM — SPEECH_END: only listening → processing', () => {
  it('listening → processing', () => {
    expect(voiceFSM('listening', { type: 'SPEECH_END' })).toBe('processing')
  })
  for (const from of ['idle', 'processing', 'speaking'] as VoiceState[]) {
    it(`${from} + SPEECH_END → ${from} (no-op)`, () => {
      expect(voiceFSM(from, { type: 'SPEECH_END' })).toBe(from)
    })
  }
})

describe('voiceFSM — TTS_START: only processing → speaking', () => {
  it('processing → speaking', () => {
    expect(voiceFSM('processing', { type: 'TTS_START' })).toBe('speaking')
  })
  for (const from of ['idle', 'listening', 'speaking'] as VoiceState[]) {
    it(`${from} + TTS_START → ${from} (no-op)`, () => {
      expect(voiceFSM(from, { type: 'TTS_START' })).toBe(from)
    })
  }
})

describe('voiceFSM — TTS_DONE: only speaking → idle', () => {
  it('speaking → idle', () => {
    expect(voiceFSM('speaking', { type: 'TTS_DONE' })).toBe('idle')
  })
  for (const from of ['idle', 'listening', 'processing'] as VoiceState[]) {
    it(`${from} + TTS_DONE → ${from} (no-op)`, () => {
      expect(voiceFSM(from, { type: 'TTS_DONE' })).toBe(from)
    })
  }
})

describe('voiceFSM — exhaustive action switch has no default leak', () => {
  it('compiles with never-check for exhaustive VoiceAction switch', () => {
    // Compile-time proof: if a new VoiceAction variant is added later without
    // updating voiceFSM, this test re-compile will fail in the reducer's default arm.
    // Runtime check: unknown action string falls through to state unchanged.
    const unknown = { type: '__UNKNOWN__' } as unknown as VoiceAction
    expect(voiceFSM('idle', unknown)).toBe('idle')
    expect(voiceFSM('listening', unknown)).toBe('listening')
  })
})

describe('voiceFSM — full happy-path sequence (idle → listening → processing → speaking → idle)', () => {
  it('drives a complete conversation turn', () => {
    let s: VoiceState = INITIAL_VOICE_STATE
    expect(s).toBe('idle')
    s = voiceFSM(s, { type: 'SPEECH_START' })
    expect(s).toBe('listening')
    s = voiceFSM(s, { type: 'SPEECH_END' })
    expect(s).toBe('processing')
    s = voiceFSM(s, { type: 'TTS_START' })
    expect(s).toBe('speaking')
    s = voiceFSM(s, { type: 'TTS_DONE' })
    expect(s).toBe('idle')
  })

  it('handles barge-in: speaking → listening → processing (second user turn)', () => {
    let s: VoiceState = 'speaking'
    s = voiceFSM(s, { type: 'SPEECH_START' }) // barge-in
    expect(s).toBe('listening')
    s = voiceFSM(s, { type: 'SPEECH_END' })
    expect(s).toBe('processing')
  })

  it('WS disconnect (ERROR) from any state returns to idle', () => {
    const fromSpeaking = voiceFSM('speaking', { type: 'ERROR' })
    const fromProcessing = voiceFSM('processing', { type: 'ERROR' })
    const fromListening = voiceFSM('listening', { type: 'ERROR' })
    expect(fromSpeaking).toBe('idle')
    expect(fromProcessing).toBe('idle')
    expect(fromListening).toBe('idle')
  })
})
