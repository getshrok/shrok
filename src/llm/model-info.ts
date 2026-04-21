import Anthropic from '@anthropic-ai/sdk'
import { log } from '../logger.js'

const CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  // Gemini
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'o3': 200_000,
  'o4-mini': 200_000,
  // OpenAI Codex (ChatGPT subscription via chatgpt.com/backend-api/codex/responses)
  // codex-1: 192K per OpenAI intro blog ("tested at a maximum context length of 192k tokens")
  // gpt-5.x-codex family: 400K per platform.openai.com/docs/models
  'codex-1': 192_000,
  'gpt-5-codex': 400_000,
  'gpt-5.1-codex': 400_000,
  'gpt-5.1-codex-mini': 400_000,
  'gpt-5.3-codex': 400_000,
}

const DEFAULT_FALLBACK = 200_000

function fallback(modelId: string, reason: string): number {
  const tokens = CONTEXT_WINDOW_FALLBACKS[modelId] ?? DEFAULT_FALLBACK
  log.warn(`[startup] context window fallback for ${modelId} (${reason}): ${tokens}`)
  return tokens
}

async function resolveAnthropicContextWindow(modelId: string, apiKey: string): Promise<number> {
  try {
    const client = new Anthropic({ apiKey })
    const model = await client.models.retrieve(modelId)
    const tokens = (model as unknown as Record<string, unknown>)['max_input_tokens'] as number | undefined
    if (typeof tokens === 'number' && tokens > 0) {
      log.info(`[startup] context window resolved: ${tokens} (anthropic/${modelId})`)
      return tokens
    }
    return fallback(modelId, 'max_input_tokens missing from response')
  } catch (err) {
    return fallback(modelId, String(err))
  }
}

async function resolveGeminiContextWindow(modelId: string, apiKey: string): Promise<number> {
  try {
    const normalizedId = modelId.startsWith('models/') ? modelId : `models/${modelId}`
    const url = `https://generativelanguage.googleapis.com/v1beta/${normalizedId}?key=${apiKey}`
    const res = await fetch(url)
    if (!res.ok) {
      return fallback(modelId, `HTTP ${res.status}`)
    }
    const data = await res.json() as Record<string, unknown>
    const tokens = data['inputTokenLimit'] as number | undefined
    if (typeof tokens === 'number' && tokens > 0) {
      log.info(`[startup] context window resolved: ${tokens} (gemini/${modelId})`)
      return tokens
    }
    return fallback(modelId, 'inputTokenLimit missing from response')
  } catch (err) {
    return fallback(modelId, String(err))
  }
}

export async function resolveContextWindow(
  provider: 'anthropic' | 'openai' | 'gemini',
  modelId: string,
  apiKey: string,
): Promise<number> {
  switch (provider) {
    case 'anthropic':
      return resolveAnthropicContextWindow(modelId, apiKey)
    case 'gemini':
      return resolveGeminiContextWindow(modelId, apiKey)
    case 'openai': {
      // OpenAI doesn't expose context window via API — use static table
      const tokens = CONTEXT_WINDOW_FALLBACKS[modelId] ?? DEFAULT_FALLBACK
      log.info(`[startup] context window resolved: ${tokens} (openai/${modelId}, table)`)
      return tokens
    }
  }
}
