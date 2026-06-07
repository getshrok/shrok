import { describe, it, expect } from 'vitest'
import { resolveAllowlist } from './tool-access.js'

describe('resolveAllowlist — tri-state resolution (all 9 + 1 edge cases)', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // override = undefined (inherit): result determined by globalDefault
  // ──────────────────────────────────────────────────────────────────────────

  it('override=undefined, default=undefined → null (all tools, both absent)', () => {
    expect(resolveAllowlist(undefined, undefined)).toBeNull()
  })

  it('override=undefined, default=null → null (global says all tools)', () => {
    expect(resolveAllowlist(undefined, null)).toBeNull()
  })

  it('override=undefined, default=["x"] → ["x"] (inherits global subset)', () => {
    expect(resolveAllowlist(undefined, ['x'])).toEqual(['x'])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // override = null (explicit "all tools"): always wins over globalDefault
  // ──────────────────────────────────────────────────────────────────────────

  it('override=null, default=undefined → null (per-head says all, beats absent global)', () => {
    expect(resolveAllowlist(null, undefined)).toBeNull()
  })

  it('override=null, default=null → null (per-head says all, global also says all)', () => {
    expect(resolveAllowlist(null, null)).toBeNull()
  })

  it('override=null, default=["x"] → null (per-head "all" beats global subset)', () => {
    expect(resolveAllowlist(null, ['x'])).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // override = string[] (explicit subset): always wins over globalDefault
  // ──────────────────────────────────────────────────────────────────────────

  it('override=["a","b"], default=undefined → ["a","b"] (per-head subset, no global)', () => {
    expect(resolveAllowlist(['a', 'b'], undefined)).toEqual(['a', 'b'])
  })

  it('override=["a","b"], default=null → ["a","b"] (per-head subset beats global "all")', () => {
    expect(resolveAllowlist(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  it('override=["a","b"], default=["x"] → ["a","b"] (per-head subset beats global subset)', () => {
    expect(resolveAllowlist(['a', 'b'], ['x'])).toEqual(['a', 'b'])
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Edge case: empty array override — "everything off" is representable and
  // must be DISTINCT from null (inherit/all) and from absent (inherit).
  // ──────────────────────────────────────────────────────────────────────────

  it('override=[], default=["x"] → [] (empty subset, NOT null — "everything off")', () => {
    const result = resolveAllowlist([], ['x'])
    expect(result).not.toBeNull()
    expect(result).toEqual([])
  })
})
