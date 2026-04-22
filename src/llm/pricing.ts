/**
 * Cost estimation for LLM usage.
 *
 * Prices are approximate and will drift over time — the point is a reasonable
 * order-of-magnitude estimate for the circuit breaker, not billing accuracy.
 * Unknown models fall back to the most expensive known price so we always
 * err on the side of caution.
 */

/** USD per 1M tokens */
interface ModelPricing {
  input: number
  output: number
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':           { input: 5.00,  output: 25.00 },
  // OpenAI
  'gpt-5.4-mini':              { input: 0.75,  output: 4.50  },
  'gpt-5.4':                   { input: 2.50,  output: 15.00 },
  'gpt-5.4-pro':               { input: 5.00,  output: 25.00 },
  // Google
  'gemini-3.1-flash-lite-preview': { input: 0.25,  output: 1.50  },
  'gemini-3-flash-preview':        { input: 0.50,  output: 3.00  },
  'gemini-3.1-pro-preview':        { input: 2.00,  output: 12.00 },
}

/** Fallback: most expensive known model, so unknown models are never underestimated */
const FALLBACK: ModelPricing = { input: 5.00, output: 25.00 }

/** Returns estimated cost in USD for a single LLM call.
 *
 * Cache token counts are optional (default 0 for backward compatibility).
 * Anthropic's `input_tokens` is the TOTAL including cached tokens, so we
 * price each bucket separately:
 *   - uncached input at full rate (1x)
 *   - cache reads at 0.1x (10% of full input rate)
 *   - cache creation at 1.25x (25% more than full input rate)
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const pricing = PRICING[model] ?? FALLBACK
  const uncachedInput = inputTokens - cacheReadTokens - cacheCreationTokens
  const inputCost = uncachedInput * pricing.input
    + cacheReadTokens * pricing.input * 0.1
    + cacheCreationTokens * pricing.input * 1.25
  return (inputCost + outputTokens * pricing.output) / 1_000_000
}

/** Returns estimated total cost in USD for a usage summary keyed by model. */
export function estimateCostFromSummary(byModel: Record<string, { input: number; output: number }>): number {
  let total = 0
  for (const [model, tokens] of Object.entries(byModel)) {
    total += estimateCost(model, tokens.input, tokens.output)
  }
  return total
}
