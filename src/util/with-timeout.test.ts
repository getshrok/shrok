import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout, TimeoutError } from './with-timeout.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'op')
    expect(result).toBe('ok')
  })

  it('propagates a rejection when the promise rejects before the timeout', async () => {
    const boom = new Error('boom')
    await expect(withTimeout(Promise.reject(boom), 1000, 'op')).rejects.toBe(boom)
  })

  it('rejects with a TimeoutError when the promise never settles', async () => {
    vi.useFakeTimers()
    const hang = new Promise<never>(() => {}) // never settles
    const raced = withTimeout(hang, 5000, 'channel discord start')
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('TimeoutError message names the label and the elapsed ms', async () => {
    vi.useFakeTimers()
    const raced = withTimeout(new Promise<never>(() => {}), 5000, 'channel discord start')
    const assertion = expect(raced).rejects.toThrow('channel discord start timed out after 5000ms')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('swallows a late rejection so it does not surface as an unhandled rejection', async () => {
    vi.useFakeTimers()
    let rejectLate!: (e: unknown) => void
    const hang = new Promise<never>((_, reject) => { rejectLate = reject })
    // Attach a handler so the late rejection has somewhere to go if it leaks;
    // withTimeout itself must already swallow it.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    const raced = withTimeout(hang, 5000, 'op')
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    // The underlying promise rejects only AFTER the timeout already won.
    rejectLate(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 0))

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('swallows a late resolution after the timeout already fired', async () => {
    vi.useFakeTimers()
    let resolveLate!: (v: string) => void
    const hang = new Promise<string>((resolve) => { resolveLate = resolve })
    const raced = withTimeout(hang, 5000, 'op')
    const assertion = expect(raced).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    // Late resolution must not throw or double-settle.
    expect(() => resolveLate('too late')).not.toThrow()
  })
})
