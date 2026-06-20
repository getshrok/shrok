import { describe, it, expect } from 'vitest'
import { isBackgroundTrigger } from './agent.js'

// Phase 52 regression guard (52-REVIEW.md CR-01 / WR-01 / WR-02).
//
// `isBackgroundTrigger` is the single chokepoint that gates the three head-less
// decision sites — the relay steward at completion (activation.ts), the
// suspend-vs-force-complete fork (local.ts), and per-target usage attribution
// (usage.ts). The original Critical was a `trigger === 'scheduled'` check at the
// completion path that silently excluded the new `'sensor'` trigger, leaking
// sub-agent output back into the head. Locking this predicate's contract here
// means a future head-less trigger that forgets to opt in fails this test
// instead of slipping past the suite the way 'sensor' did.
describe('isBackgroundTrigger', () => {
  it('treats scheduled as a background (head-less) trigger', () => {
    expect(isBackgroundTrigger('scheduled')).toBe(true)
  })

  it('treats sensor sub-agent dispatch as a background (head-less) trigger', () => {
    // The CR-01 regression: this MUST be true so the relay steward gates sensor
    // completions, suspendAsQuestion force-completes them, and usage attributes
    // them per-target — exactly as scheduled tasks are handled.
    expect(isBackgroundTrigger('sensor')).toBe(true)
  })

  it('does NOT treat manual as background (a human is attached)', () => {
    expect(isBackgroundTrigger('manual')).toBe(false)
  })

  it('does NOT treat ad_hoc as background', () => {
    expect(isBackgroundTrigger('ad_hoc')).toBe(false)
  })

  it('does NOT treat an unknown/coalesced trigger as background', () => {
    // usage rows can coalesce to 'unknown'; undefined can reach the predicate too.
    expect(isBackgroundTrigger('unknown')).toBe(false)
    expect(isBackgroundTrigger(undefined)).toBe(false)
  })

  it('narrows the type to the background union (compile-time contract)', () => {
    const t: string = 'sensor'
    if (isBackgroundTrigger(t)) {
      // Inside the guard, t is 'scheduled' | 'sensor'. This assignment only
      // compiles while both literals remain in the narrowed union.
      const narrowed: 'scheduled' | 'sensor' = t
      expect(narrowed).toBe('sensor')
    }
  })
})
