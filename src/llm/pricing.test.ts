import { describe, it, expect } from 'vitest'
import { estimateCost } from './pricing.js'

describe('estimateCost', () => {
  it('backward compat: no cache args — prices all input at full rate', () => {
    // (1000 * 3 + 500 * 15) / 1_000_000 = 10500 / 1_000_000 = 0.0105
    expect(estimateCost('claude-sonnet-4-6', 1000, 500)).toBeCloseTo(0.0105, 6)
  })

  it('all cache reads — prices cache reads at 0.1x input rate', () => {
    // cache reads: 1000 * 3 * 0.1 = 300; output: 500 * 15 = 7500
    // (300 + 7500) / 1_000_000 = 0.0078
    expect(estimateCost('claude-sonnet-4-6', 1000, 500, 1000, 0)).toBeCloseTo(0.0078, 6)
  })

  it('all cache creation — prices cache creation at 1.25x input rate', () => {
    // cache creation: 1000 * 3 * 1.25 = 3750; output: 500 * 15 = 7500
    // (3750 + 7500) / 1_000_000 = 0.01125
    expect(estimateCost('claude-sonnet-4-6', 1000, 500, 0, 1000)).toBeCloseTo(0.01125, 6)
  })

  it('mixed: uncached + cache reads + cache creation all priced correctly', () => {
    // 600 read (0.1x), 200 creation (1.25x), 200 uncached (1x)
    // input cost: 200*3 + 600*3*0.1 + 200*3*1.25 = 600 + 180 + 750 = 1530
    // output: 500 * 15 = 7500
    // total: (1530 + 7500) / 1_000_000 = 0.00903
    expect(estimateCost('claude-sonnet-4-6', 1000, 500, 600, 200)).toBeCloseTo(0.00903, 6)
  })

  it('fallback model with cache — unknown model uses FALLBACK pricing with cache discounts', () => {
    // FALLBACK: input=5.00, output=25.00
    // cache reads: 1000 * 5 * 0.1 = 500; output: 500 * 25 = 12500
    // (500 + 12500) / 1_000_000 = 0.013
    expect(estimateCost('unknown-model-xyz', 1000, 500, 1000, 0)).toBeCloseTo(0.013, 6)
  })

  it('fallback model no cache — uses FALLBACK pricing', () => {
    // (1000 * 5 + 500 * 25) / 1_000_000 = (5000 + 12500) / 1_000_000 = 0.0175
    expect(estimateCost('unknown-model-xyz', 1000, 500)).toBeCloseTo(0.0175, 6)
  })
})
