import { describe, it, expect, vi, beforeEach } from 'vitest'
import { splitMessage } from './chunker.js'
import { ChannelRouterImpl } from './router.js'
import type { ChannelAdapter, InboundMessage } from '../types/channel.js'

// ─── splitMessage ─────────────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns the original text when it fits in one chunk', () => {
    expect(splitMessage('hello world', 2000)).toEqual(['hello world'])
  })

  it('returns a single-element array for text exactly at the limit', () => {
    const text = 'a'.repeat(2000)
    expect(splitMessage(text)).toEqual([text])
  })

  it('splits at a newline boundary when possible', () => {
    // Build text where the last newline is well past 50% of maxLen
    const maxLen = 100
    const line1 = 'a'.repeat(60)
    const line2 = 'b'.repeat(60)
    const text = line1 + '\n' + line2
    const chunks = splitMessage(text, maxLen)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toBe(line1)
  })

  it('splits at a space boundary when no suitable newline exists', () => {
    const maxLen = 20
    // "aaaaaaaaaa bbbbbbbbbb cccccccccc" — first space at index 10
    const text = 'a'.repeat(10) + ' ' + 'b'.repeat(10) + ' ' + 'c'.repeat(10)
    const chunks = splitMessage(text, maxLen)
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk should not end with a space
    expect(chunks[0]!.endsWith(' ')).toBe(false)
  })

  it('hard-cuts when no suitable boundary exists', () => {
    const maxLen = 10
    const text = 'a'.repeat(25)
    const chunks = splitMessage(text, maxLen)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(maxLen))
  })

  it('reassembles to the original text (modulo trimming)', () => {
    const original = 'word '.repeat(500).trimEnd()
    const chunks = splitMessage(original, 200)
    // All chunks should be within the limit
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(200))
    // Joined content should match original text
    expect(chunks.join(' ')).toBe(original)
  })
})

// ─── ChannelRouterImpl ────────────────────────────────────────────────────────

function makeAdapter(id: string): ChannelAdapter & { sends: string[] } {
  const sends: string[] = []
  return {
    id,
    sends,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (text: string) => { sends.push(text) }),
    onMessage: vi.fn(),
  }
}

describe('ChannelRouterImpl', () => {
  let router: ChannelRouterImpl

  beforeEach(() => {
    router = new ChannelRouterImpl()
  })

  it('routes a message to the correct adapter', async () => {
    const discord = makeAdapter('discord')
    router.register(discord)
    await router.send('discord', 'Hello!')
    expect(discord.sends).toEqual(['Hello!'])
  })

  it('logs a warning and does not throw for unknown channels', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(router.send('unknown', 'hi')).resolves.not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown'))
    warn.mockRestore()
  })

  it('logs an error and does not throw when adapter.send rejects', async () => {
    const errored = makeAdapter('errored')
    errored.send = vi.fn().mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    router.register(errored)
    await expect(router.send('errored', 'hi')).resolves.not.toThrow()
    // After retry failure, log.error is called with the channel name
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('errored'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('getLastActiveChannel returns null before any sends', () => {
    expect(router.getLastActiveChannel()).toBeNull()
  })

  it('getLastActiveChannel returns the last successfully sent channel', async () => {
    const discord = makeAdapter('discord')
    const telegram = makeAdapter('telegram')
    router.register(discord)
    router.register(telegram)
    await router.send('discord', 'hi')
    expect(router.getLastActiveChannel()).toBe('discord')
    await router.send('telegram', 'hello')
    expect(router.getLastActiveChannel()).toBe('telegram')
  })

  it('getLastActiveChannel does not update on failed send', async () => {
    const good = makeAdapter('good')
    const bad = makeAdapter('bad')
    bad.send = vi.fn().mockRejectedValue(new Error('fail'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    router.register(good)
    router.register(bad)
    await router.send('good', 'ok')
    expect(router.getLastActiveChannel()).toBe('good')
    await router.send('bad', 'fail')
    expect(router.getLastActiveChannel()).toBe('good')
    spy.mockRestore()
  })

  it('supports multiple adapters registered at once', async () => {
    const a = makeAdapter('a')
    const b = makeAdapter('b')
    router.register(a)
    router.register(b)
    await router.send('a', 'msg-a')
    await router.send('b', 'msg-b')
    expect(a.sends).toEqual(['msg-a'])
    expect(b.sends).toEqual(['msg-b'])
  })
})

// ─── splitMessage — code fence awareness ──────────────────────────────────────

describe('splitMessage — code fence awareness', () => {
  it('does not split inside a code fence — splits before the opening line (Case A)', () => {
    // maxLen=100; put a short prose prefix then a fence that opens after the midpoint
    const maxLen = 100
    const prose = 'x'.repeat(60) + '\n'         // 61 chars
    const fencedCode = '```\n' + 'y'.repeat(60) + '\n```'
    const text = prose + fencedCode              // >100 chars total
    const chunks = splitMessage(text, maxLen)
    // The fence opening line must not appear in the first chunk mid-block
    expect(chunks[0]).not.toContain('```')
    expect(chunks[0]).toBe('x'.repeat(60))
    // The second chunk must start with the fence
    expect(chunks[1]!.startsWith('```')).toBe(true)
  })

  it('closes and reopens fence when code block starts before midpoint (Case B)', () => {
    const maxLen = 60
    // Fence opens at position 0 (well before midpoint), code is long
    const text = '```\n' + 'a'.repeat(200) + '\n```'
    const chunks = splitMessage(text, maxLen)
    // First chunk must end with closing ```
    expect(chunks[0]!.trimEnd().endsWith('```')).toBe(true)
    // Second chunk must reopen the fence
    expect(chunks[1]!.startsWith('```')).toBe(true)
  })

  it('preserves language tag when closing and reopening fence (Case B)', () => {
    const maxLen = 60
    const text = '```typescript\n' + 'b'.repeat(200) + '\n```'
    const chunks = splitMessage(text, maxLen)
    expect(chunks[0]!.trimEnd().endsWith('```')).toBe(true)
    expect(chunks[1]!.startsWith('```typescript')).toBe(true)
  })

  it('treats inline backticks as plain text (no false fence detection)', () => {
    // Single-backtick inline code should not trigger fence logic
    const maxLen = 30
    const text = 'call `foo()` then `bar()` then `baz()` and more text here okay'
    const chunks = splitMessage(text, maxLen)
    // All chunks should be within limit; no garbled fence markers
    chunks.forEach(c => {
      expect(c.length).toBeLessThanOrEqual(maxLen)
      expect(c).not.toMatch(/^```/)
    })
  })

  it('handles multiple code blocks — each protected independently', () => {
    const maxLen = 80
    // Two separate fenced blocks; total length exceeds maxLen
    const block1 = '```\n' + 'c'.repeat(30) + '\n```\n'
    const middle = 'some prose in between\n'
    const block2 = '```python\n' + 'd'.repeat(30) + '\n```'
    const text = block1 + middle + block2
    const chunks = splitMessage(text, maxLen)
    // Every chunk must be within the limit
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(maxLen))
    // Joined content must not lose data (allowing for trimming)
    const joined = chunks.join('\n')
    expect(joined).toContain('c'.repeat(30))
    expect(joined).toContain('d'.repeat(30))
  })
})

