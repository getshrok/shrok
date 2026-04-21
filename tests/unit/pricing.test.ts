import { describe, it, expect } from 'vitest'
import { estimateCost, estimateCostFromSummary } from '../../src/llm/pricing.js'

describe('estimateCost', () => {
  it('returns correct USD for claude-sonnet-4-6', () => {
    // $3.00 input + $15.00 output per 1M tokens
    const cost = estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(18.00, 5)
  })

  it('returns correct USD for a cheap model', () => {
    // gemini-2.0-flash: $0.10 in + $0.40 out per 1M
    const cost = estimateCost('gemini-2.0-flash', 500_000, 500_000)
    expect(cost).toBeCloseTo(0.25, 5)
  })

  it('returns correct USD for gpt-4o-mini', () => {
    // $0.15 in + $0.60 out per 1M
    const cost = estimateCost('gpt-4o-mini', 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(0.75, 5)
  })

  it('falls back to most expensive pricing for unknown model', () => {
    // Fallback: $5.00 in + $25.00 out per 1M — same as claude-opus-4-6
    const knownCost = estimateCost('claude-opus-4-6', 100_000, 100_000)
    const unknownCost = estimateCost('gpt-99-ultra', 100_000, 100_000)
    expect(unknownCost).toBe(knownCost)
  })

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBe(0)
  })

  it('handles output-only cost correctly', () => {
    // claude-sonnet-4-6: $15.00 per 1M output tokens
    const cost = estimateCost('claude-sonnet-4-6', 0, 1_000_000)
    expect(cost).toBeCloseTo(15.00, 5)
  })
})

describe('estimateCostFromSummary', () => {
  it('aggregates multiple models correctly', () => {
    // haiku: $1.00 in + $5.00 out per 1M → 100k tokens = $0.60
    // sonnet: $3.00 in + $15.00 out per 1M → 100k tokens = $1.80
    const cost = estimateCostFromSummary({
      'claude-haiku-4-5-20251001': { input: 100_000, output: 100_000 },
      'claude-sonnet-4-6':         { input: 100_000, output: 100_000 },
    })
    const haiku  = estimateCost('claude-haiku-4-5-20251001', 100_000, 100_000)
    const sonnet = estimateCost('claude-sonnet-4-6',          100_000, 100_000)
    expect(cost).toBeCloseTo(haiku + sonnet, 8)
  })

  it('returns 0 for empty summary', () => {
    expect(estimateCostFromSummary({})).toBe(0)
  })

  it('handles single model summary', () => {
    const direct  = estimateCost('gpt-4o', 50_000, 20_000)
    const summary = estimateCostFromSummary({ 'gpt-4o': { input: 50_000, output: 20_000 } })
    expect(summary).toBe(direct)
  })

  it('uses fallback pricing for unknown model in summary', () => {
    const cost = estimateCostFromSummary({ 'mystery-model': { input: 1_000_000, output: 1_000_000 } })
    // Fallback is most expensive: $5.00 in + $25.00 out = $30.00
    expect(cost).toBeCloseTo(30.00, 5)
  })
})
