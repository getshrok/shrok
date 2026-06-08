import type { Message } from '../types/core.js'
import type { LLMRouter, LLMProvider, LLMResponse, ToolDefinition, LLMCallOptions, Tier, TierModels } from '../types/llm.js'
import { LLMApiError } from './util.js'
import { log } from '../logger.js'
import { LEGACY_TIER_ALIAS } from '../config.js'

export interface ProviderEntry {
  provider: LLMProvider
  tierModels: TierModels
}

export class SingleProviderRouter implements LLMRouter {
  constructor(
    private provider: LLMProvider,
    private tierModels: TierModels
  ) {}

  complete(
    model: string,
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMCallOptions
  ): Promise<LLMResponse> {
    // Accept legacy tier names as aliases (e.g. 'capable' → 'smart')
    const normalizedModel = LEGACY_TIER_ALIAS[model] ?? model
    const resolved = (normalizedModel in this.tierModels)
      ? this.tierModels[normalizedModel as Tier]
      : normalizedModel
    return this.provider.complete(messages, tools, { ...options, model: resolved })
  }
}

const TIERS = new Set<string>(['dumb', 'smart', 'genius'])

export class MultiProviderRouter implements LLMRouter {
  constructor(private entries: ProviderEntry[]) {
    if (entries.length === 0) throw new Error('At least one provider required')
  }

  async complete(
    model: string,
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMCallOptions
  ): Promise<LLMResponse> {
    // Accept legacy tier names as aliases (e.g. 'capable' → 'smart')
    const normalizedModel = LEGACY_TIER_ALIAS[model] ?? model

    // Direct model IDs: first provider only, no fallback
    if (!TIERS.has(normalizedModel)) {
      return this.entries[0]!.provider.complete(messages, tools, { ...options, model: normalizedModel })
    }

    // Tier names: try each provider in priority order
    let lastError: unknown
    for (const entry of this.entries) {
      const resolved = entry.tierModels[normalizedModel as Tier]
      try {
        return await entry.provider.complete(messages, tools, { ...options, model: resolved })
      } catch (err) {
        lastError = err
        if (err instanceof LLMApiError) {
          // Fall back on: auth (bad key), rate_limit, server_error, or network failure (no HTTP status)
          if (err.type === 'auth' || err.type === 'rate_limit' || err.type === 'server_error' || err.status === undefined) {
            log.warn(`[llm] ${entry.provider.name} failed (${err.type}${err.status ? `, ${err.status}` : ''}), falling back to next provider`)
            continue
          }
        }
        // Unknown errors WITH a status (e.g., 400 Bad Request): likely our fault, don't fall back
        throw err
      }
    }
    throw lastError  // all providers exhausted
  }
}
