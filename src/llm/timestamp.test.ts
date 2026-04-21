import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatMessageTimestamp, prefixTimestamp } from './timestamp.js'

describe('formatMessageTimestamp', () => {
  afterEach(() => { vi.useRealTimers() })

  it('formats messages under 60 minutes as relative minutes', () => {
    const now = new Date('2026-04-05T12:00:00Z')
    vi.setSystemTime(now)
    expect(formatMessageTimestamp('2026-04-05T11:48:00Z')).toBe('[12m ago]')
  })

  it('formats messages 1-24 hours old as relative hours', () => {
    const now = new Date('2026-04-05T15:00:00Z')
    vi.setSystemTime(now)
    expect(formatMessageTimestamp('2026-04-05T12:00:00Z')).toBe('[3h ago]')
  })

  it('formats messages over 24 hours old as absolute date/time', () => {
    const now = new Date('2026-04-05T15:00:00Z')
    vi.setSystemTime(now)
    const result = formatMessageTimestamp('2026-04-03T14:15:00Z')
    expect(result).toMatch(/^\[Apr 3, /)
    expect(result).toMatch(/\]$/)
  })

  it('returns empty string for undefined', () => {
    expect(formatMessageTimestamp(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(formatMessageTimestamp('')).toBe('')
  })

  it('returns empty string for invalid date', () => {
    expect(formatMessageTimestamp('not-a-date')).toBe('')
  })

  it('returns [0m ago] for messages created now', () => {
    const now = new Date('2026-04-05T12:00:00Z')
    vi.setSystemTime(now)
    expect(formatMessageTimestamp('2026-04-05T12:00:00Z')).toBe('[0m ago]')
  })

  it('rounds to nearest minute', () => {
    const now = new Date('2026-04-05T12:00:00Z')
    vi.setSystemTime(now)
    // 90 seconds ago → rounds to 2m
    expect(formatMessageTimestamp('2026-04-05T11:58:30Z')).toBe('[2m ago]')
  })
})

describe('prefixTimestamp', () => {
  afterEach(() => { vi.useRealTimers() })

  it('prefixes content with timestamp', () => {
    const now = new Date('2026-04-05T12:00:00Z')
    vi.setSystemTime(now)
    expect(prefixTimestamp('Hello!', '2026-04-05T11:55:00Z')).toBe('[5m ago] Hello!')
  })

  it('returns content unchanged when createdAt is undefined', () => {
    expect(prefixTimestamp('Hello!', undefined)).toBe('Hello!')
  })

  it('returns content unchanged when createdAt is invalid', () => {
    expect(prefixTimestamp('Hello!', 'garbage')).toBe('Hello!')
  })
})
