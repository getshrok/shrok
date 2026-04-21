import type { AttachmentType } from '../types/core.js'

/**
 * Which attachment input types each provider supports natively.
 * If a type is not listed, the LLM adapter will substitute a text stub instead.
 * Update this as providers gain capabilities — no other code changes needed.
 */
export const PROVIDER_INPUT_CAPABILITIES: Record<string, Set<AttachmentType>> = {
  anthropic:    new Set(['image', 'document']),
  openai:       new Set(['image']),
  gemini:       new Set(['image', 'audio', 'document', 'video']),
}
