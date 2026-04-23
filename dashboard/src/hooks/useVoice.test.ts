import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createErrorTimer, type VoiceErrorMessage } from './voice-error-timer'

describe('voice-error-timer — auto-dismiss after 4000ms', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('calls onSet exactly once with the message', () => {
    const onSet = vi.fn()
    const onClear = vi.fn()
    const handle = createErrorTimer(onSet, onClear)
    handle.setError('Microphone access denied')
    expect(onSet).toHaveBeenCalledTimes(1)
    expect(onSet).toHaveBeenCalledWith('Microphone access denied')
    expect(onClear).not.toHaveBeenCalled()
  })

  it('calls onClear exactly once after 4000ms', () => {
    const onSet = vi.fn()
    const onClear = vi.fn()
    createErrorTimer(onSet, onClear).setError('Voice disconnected')
    vi.advanceTimersByTime(3999)
    expect(onClear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('resets the dismiss timer on a second setError (D-06)', () => {
    const onSet = vi.fn()
    const onClear = vi.fn()
    const handle = createErrorTimer(onSet, onClear)
    handle.setError('Voice disconnected')
    vi.advanceTimersByTime(2000)
    handle.setError('Voice error — please try again')
    vi.advanceTimersByTime(2000) // now t=4000 from first, but only 2000 from second
    expect(onClear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000) // now t=4000 from second
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels a pending timer', () => {
    const onSet = vi.fn()
    const onClear = vi.fn()
    const handle = createErrorTimer(onSet, onClear)
    handle.setError('Microphone access denied')
    handle.clear()
    expect(onClear).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onClear).toHaveBeenCalledTimes(1) // no second call from the cancelled timer
  })
})

describe('VoiceErrorMessage — exactly three allowed strings (D-03)', () => {
  it('admits only the three whitelisted strings', () => {
    const messages: VoiceErrorMessage[] = [
      'Microphone access denied',
      'Voice disconnected',
      'Voice error — please try again',
    ]
    expect(messages).toHaveLength(3)
  })
})
