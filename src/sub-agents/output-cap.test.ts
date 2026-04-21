import { describe, it, expect } from 'vitest'
import { truncateToolOutput, DEFAULT_TRUNCATION_HINT } from './output-cap.js'
import { buildScopedBashTools } from './registry.js'

function markerLen(n: number, hint = DEFAULT_TRUNCATION_HINT): number {
  return `…[truncated ${n} chars — ${hint}]…`.length
}

describe('truncateToolOutput', () => {
  it('passes short output through unchanged (reference-equal)', () => {
    const raw = 'hello world'
    const out = truncateToolOutput(raw, 30_000)
    expect(out).toBe(raw)
  })

  it('passes output at exactly maxChars unchanged', () => {
    const raw = 'x'.repeat(100)
    const out = truncateToolOutput(raw, 100)
    expect(out).toBe(raw)
  })

  it('middle-truncates oversized output with correct length', () => {
    const raw = 'a'.repeat(100_000)
    const out = truncateToolOutput(raw, 30_000)
    expect(out.length).toBe(30_000)
    expect(out).toMatch(/\[truncated \d+ chars — /)
  })

  it('preserves verbatim head and tail of the original', () => {
    const raw = 'HEADSTART' + 'x'.repeat(50_000) + 'TAILEND'
    const out = truncateToolOutput(raw, 1_000)
    expect(out.startsWith('HEADSTART')).toBe(true)
    expect(out.endsWith('TAILEND')).toBe(true)
  })

  it('elided count in marker equals the actual chars elided', () => {
    const raw = 'a'.repeat(100_000)
    const maxChars = 30_000
    const out = truncateToolOutput(raw, maxChars)
    const match = out.match(/\[truncated (\d+) chars — /)
    expect(match).not.toBeNull()
    const n = Number(match![1])
    const keep = maxChars - `…[truncated ${n} chars — ${DEFAULT_TRUNCATION_HINT}]…`.length
    expect(n).toBe(raw.length - keep)
  })

  it('cap = 0 disables truncation', () => {
    const raw = 'a'.repeat(100_000)
    expect(truncateToolOutput(raw, 0)).toBe(raw)
  })

  it('cap = -1 disables truncation', () => {
    const raw = 'a'.repeat(100_000)
    expect(truncateToolOutput(raw, -1)).toBe(raw)
  })

  it('when cap < marker length, returns only marker text', () => {
    const raw = 'a'.repeat(10_000)
    const out = truncateToolOutput(raw, 10)
    expect(out.startsWith('…[truncated')).toBe(true)
  })

  it('honors custom hint', () => {
    const raw = 'a'.repeat(10_000)
    const out = truncateToolOutput(raw, 500, 'bash output')
    expect(out).toMatch(/\[truncated \d+ chars — bash output\]/)
  })

  it('property: random-length inputs never exceed maxChars', () => {
    const cap = 30_000
    for (let i = 0; i < 20; i++) {
      const len = 25_000 + Math.floor(Math.random() * 200_000)
      const raw = 'z'.repeat(len)
      const out = truncateToolOutput(raw, cap)
      expect(out.length).toBeLessThanOrEqual(cap)
    }
  })

  describe('digit-boundary convergence (9999 ↔ 10000)', () => {
    it('Case A: provisional 4-digit guess must grow to 5 digits', () => {
      const maxChars = 10_000
      // Make raw.length so that elided first guess = raw.length - maxChars
      // is near the 9999/10000 boundary and forces growth across it.
      const raw = 'a'.repeat(10_000 + markerLen(9999) + 1)
      const out = truncateToolOutput(raw, maxChars)
      expect(out.length).toBe(maxChars)
      const match = out.match(/\[truncated (\d+) chars — /)
      expect(match).not.toBeNull()
      const n = Number(match![1])
      const keep = maxChars - `…[truncated ${n} chars — ${DEFAULT_TRUNCATION_HINT}]…`.length
      expect(n).toBe(raw.length - keep)
    })

    it('Case B: 5-digit starting guess, no oscillation', () => {
      const maxChars = 10_000
      const raw = 'a'.repeat(10_000 + markerLen(10_000))
      const out = truncateToolOutput(raw, maxChars)
      expect(out.length).toBe(maxChars)
      const match = out.match(/\[truncated (\d+) chars — /)
      expect(match).not.toBeNull()
      const n = Number(match![1])
      const keep = maxChars - `…[truncated ${n} chars — ${DEFAULT_TRUNCATION_HINT}]…`.length
      expect(n).toBe(raw.length - keep)
    })
  })
})

describe('bash dispatch cap (integration)', () => {
  const itBash = process.platform === 'win32' ? it.skip : it

  itBash('caps >30k bash output at the dispatch layer with the unique marker', async () => {
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } as Record<string, string>
    const [bash] = buildScopedBashTools(env, 30_000)
    const result = await bash!.execute({ command: `printf 'x%.0s' {1..50000}` }, {} as never)
    expect(typeof result).toBe('string')
    const str = result as string
    expect(str.length).toBeLessThanOrEqual(30_000)
    expect(str).toContain('[truncated ')
    expect(str).toContain(' chars — ')
    // Verbatim head prefix — bash tool prepends "Exit code: 0\nStdout:\n" which
    // will sit at the very start, followed by 'x'×many before the marker.
    expect(str.startsWith('Exit code: 0\nStdout:\n')).toBe(true)
  })
})
