import { describe, it, expect } from 'vitest'
import { applyIdentityEdits } from './identity-edit.js'

describe('applyIdentityEdits', () => {
  it('applies a single edit and returns a diff', () => {
    const { content, diff } = applyIdentityEdits('alpha beta gamma', [{ oldText: 'beta', newText: 'BETA' }])
    expect(content).toBe('alpha BETA gamma')
    expect(diff).toContain('@@ edit 1 @@')
    expect(diff).toContain('- beta')
    expect(diff).toContain('+ BETA')
  })

  it('applies multiple edits sequentially (edit 2 sees edit 1 result)', () => {
    // After edit 1 turns "one" into "two", edit 2 can match "two".
    const { content } = applyIdentityEdits('one and three', [
      { oldText: 'one', newText: 'two' },
      { oldText: 'two and three', newText: 'done' },
    ])
    expect(content).toBe('done')
  })

  it('throws (naming the edit) when oldText is not found', () => {
    expect(() => applyIdentityEdits('hello world', [{ oldText: 'missing', newText: 'x' }]))
      .toThrow(/edit 1.*not found/)
  })

  it('throws when oldText matches more than once (ambiguous)', () => {
    expect(() => applyIdentityEdits('na na na', [{ oldText: 'na', newText: 'NA' }]))
      .toThrow(/matched 3 times|exactly once/)
  })

  it('throws on an empty oldText', () => {
    expect(() => applyIdentityEdits('content', [{ oldText: '', newText: 'x' }]))
      .toThrow(/oldText is empty/)
  })

  it('throws when no edits are provided', () => {
    expect(() => applyIdentityEdits('content', [])).toThrow(/at least one/)
  })

  it('matches a CRLF file against an oldText written with \\n', () => {
    const { content } = applyIdentityEdits('line one\r\nline two\r\n', [{ oldText: 'line one\nline two', newText: 'merged' }])
    expect(content).toBe('merged\n')
  })

  it('allows a no-op edit where newText === oldText', () => {
    const { content } = applyIdentityEdits('keep this', [{ oldText: 'keep this', newText: 'keep this' }])
    expect(content).toBe('keep this')
  })

  it('clears a file when newText is empty and oldText is the whole body', () => {
    const body = '# Bootstrap\n\nrun onboarding then clear this'
    const { content } = applyIdentityEdits(body, [{ oldText: body, newText: '' }])
    expect(content).toBe('')
  })

  it('caps the rendered diff so a huge edit cannot re-wall history', () => {
    const huge = 'x'.repeat(50_000)
    const { content, diff } = applyIdentityEdits('seed', [{ oldText: 'seed', newText: huge }])
    expect(content).toBe(huge)               // the file content is correct/full
    expect(diff.length).toBeLessThan(6_000)  // but the diff string is bounded
    expect(diff).toContain('truncated')
  })
})
