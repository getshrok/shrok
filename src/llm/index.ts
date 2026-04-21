import type { Config } from '../config.js'
import type { LLMRouter } from '../types/llm.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import { OpenAIProvider } from './openai.js'
import { SingleProviderRouter, MultiProviderRouter, type ProviderEntry } from './router.js'

function buildProviderEntry(name: string, config: Config): ProviderEntry | null {
  switch (name) {
    case 'anthropic': {
      if (!config.anthropicApiKey) return null
      return {
        provider: new AnthropicProvider(config.anthropicApiKey),
        tierModels: {
          standard: config.anthropicModelStandard,
          capable: config.anthropicModelCapable,
          expert: config.anthropicModelExpert,
        },
      }
    }
    case 'gemini': {
      if (!config.geminiApiKey) return null
      return {
        provider: new GeminiProvider(config.geminiApiKey),
        tierModels: {
          standard: config.geminiModelStandard,
          capable: config.geminiModelCapable,
          expert: config.geminiModelExpert,
        },
      }
    }
    case 'openai': {
      if (!config.openaiApiKey) return null
      return {
        provider: new OpenAIProvider(config.openaiApiKey),
        tierModels: {
          standard: config.openaiModelStandard,
          capable: config.openaiModelCapable,
          expert: config.openaiModelExpert,
        },
      }
    }
    default:
      return null
  }
}

export function createLLMRouter(config: Config): LLMRouter {
  const entries: ProviderEntry[] = []
  for (const name of config.llmProviderPriority) {
    const entry = buildProviderEntry(name, config)
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) {
    throw new Error('No LLM providers configured. Set at least one API key.')
  }

  // Single provider: no fallback overhead
  if (entries.length === 1) {
    return new SingleProviderRouter(entries[0]!.provider, entries[0]!.tierModels)
  }

  return new MultiProviderRouter(entries)
}
