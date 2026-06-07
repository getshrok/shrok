import { describe, it, expect } from 'vitest'
import { resolveAllowlist } from './tool-access.js'

describe('resolveAllowlist — two-state resolution (D-04, D-05)', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // override = array → wins (per-head subset takes precedence)
  // ──────────────────────────────────────────────────────────────────────────

  it('override=["a","b"], global=undefined → ["a","b"] (per-head subset, no global)', () => {
    expect(resolveAllowlist(['a', 'b'], undefined)).toEqual(['a', 'b'])
  })

  it('override=["a","b"], global=["x"] → ["a","b"] (per-head subset beats global subset)', () => {
    expect(resolveAllowlist(['a', 'b'], ['x'])).toEqual(['a', 'b'])
  })

  it('override=["a","b"], global=null → ["a","b"] (per-head subset; legacy null global falls through)', () => {
    expect(resolveAllowlist(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // override = undefined (key absent) → fall through to global
  // ──────────────────────────────────────────────────────────────────────────

  it('override=undefined, global=["x"] → ["x"] (inherits global subset)', () => {
    expect(resolveAllowlist(undefined, ['x'])).toEqual(['x'])
  })

  it('override=undefined, global=undefined → [] (both absent, no default supplied → empty)', () => {
    expect(resolveAllowlist(undefined, undefined)).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // override = null (legacy tolerance, D-05) → normalized to fall-through
  // ──────────────────────────────────────────────────────────────────────────

  it('override=null (legacy), global=["x"] → ["x"] (null normalized to fall-through, inherits global)', () => {
    expect(resolveAllowlist(null, ['x'])).toEqual(['x'])
  })

  it('override=null (legacy), global=undefined → [] (null normalized to fall-through, both absent)', () => {
    expect(resolveAllowlist(null, undefined)).toEqual([])
  })

  it('override=null (legacy), global=null (legacy) → [] (both legacy-null normalized to absent)', () => {
    expect(resolveAllowlist(null, null)).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Edge case: empty array override — "everything off" is representable and
  // must be DISTINCT from absent (inherit).
  // ──────────────────────────────────────────────────────────────────────────

  it('override=[], global=["x"] → [] (empty subset = no tools, NOT inherit)', () => {
    const result = resolveAllowlist([], ['x'])
    expect(result).toEqual([])
    // Confirm it is not the global — override=[] is a concrete "no tools" choice
    expect(result).not.toContain('x')
  })

  it('override=[], global=undefined → [] (empty subset wins; not affected by absent global)', () => {
    expect(resolveAllowlist([], undefined)).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Return type: always string[], never null (D-04)
  // ──────────────────────────────────────────────────────────────────────────

  it('return type is always string[], never null — even when both args are absent', () => {
    const result = resolveAllowlist(undefined, undefined)
    expect(Array.isArray(result)).toBe(true)
    expect(result).not.toBeNull()
  })
})
