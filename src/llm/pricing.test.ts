import { describe, it, expect } from 'vitest'
import { estimateCost } from './pricing.js'

describe('estimateCost', () => {
  it('no cache args — prices all input at full rate', () => {
    // (1000 * 3 + 500 * 15) / 1_000_000 = 10500 / 1_000_000 = 0.0105
    expect(estimateCost('claude-sonnet-4-6', 1000, 500)).toBeCloseTo(0.0105, 6)
  })

  it('cache reads are additive to inputTokens, priced at 0.1x input rate', () => {
    // inputTokens (uncached) = 0, cache reads = 1000
    // cache reads: 1000 * 3 * 0.1 = 300; output: 500 * 15 = 7500
    // (300 + 7500) / 1_000_000 = 0.0078
    expect(estimateCost('claude-sonnet-4-6', 0, 500, 1000, 0)).toBeCloseTo(0.0078, 6)
  })

  it('cache creation is additive to inputTokens, priced at 1.25x input rate', () => {
    // inputTokens (uncached) = 0, cache creation = 1000
    // cache creation: 1000 * 3 * 1.25 = 3750; output: 500 * 15 = 7500
    // (3750 + 7500) / 1_000_000 = 0.01125
    expect(estimateCost('claude-sonnet-4-6', 0, 500, 0, 1000)).toBeCloseTo(0.01125, 6)
  })

  it('mixed: uncached + cache reads + cache creation are independent additive buckets', () => {
    // Anthropic reports inputTokens EXCLUDING cache, so 200 uncached is priced
    // at full rate on TOP of the cache buckets (no subtraction).
    // input cost: 200*3 + 600*3*0.1 + 200*3*1.25 = 600 + 180 + 750 = 1530
    // output: 500 * 15 = 7500
    // total: (1530 + 7500) / 1_000_000 = 0.00903
    expect(estimateCost('claude-sonnet-4-6', 200, 500, 600, 200)).toBeCloseTo(0.00903, 6)
  })

  it('cache-heavy call (tiny uncached input, huge cache reads) stays positive', () => {
    // Regression for the negative-cost bug: a real scheduled-task row that the
    // old `inputTokens - cacheRead - cacheCreate` formula priced at -$0.1332.
    // Correct: 587*3 + 52543*3*0.1 + 4766*3*1.25 + 223*15
    //        = 1761 + 15762.9 + 17872.5 + 3345 = 38741.4  → 0.0387414
    const cost = estimateCost('claude-sonnet-4-6', 587, 223, 52543, 4766)
    expect(cost).toBeCloseTo(0.038741, 6)
    expect(cost).toBeGreaterThan(0)
  })

  it('never returns a negative cost regardless of cache token magnitude', () => {
    expect(estimateCost('claude-haiku-4-5-20251001', 1, 1, 1_000_000, 1_000_000))
      .toBeGreaterThanOrEqual(0)
  })

  it('fallback model with cache — unknown model uses FALLBACK pricing with cache discounts', () => {
    // FALLBACK: input=5.00, output=25.00
    // cache reads: 1000 * 5 * 0.1 = 500; output: 500 * 25 = 12500
    // (500 + 12500) / 1_000_000 = 0.013
    expect(estimateCost('unknown-model-xyz', 0, 500, 1000, 0)).toBeCloseTo(0.013, 6)
  })

  it('fallback model no cache — uses FALLBACK pricing', () => {
    // (1000 * 5 + 500 * 25) / 1_000_000 = (5000 + 12500) / 1_000_000 = 0.0175
    expect(estimateCost('unknown-model-xyz', 1000, 500)).toBeCloseTo(0.0175, 6)
  })
})
