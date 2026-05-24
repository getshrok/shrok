import { randomUUID } from 'node:crypto'
import type { ChatCompletion } from 'openai/resources/chat/completions/completions.js'

// ─── Request helpers ──────────────────────────────────────────────────────────

/**
 * Extract the last role:'user' message content from a HA ChatLog messages array.
 *
 * HA sends the full conversation history on every turn; only the last user turn
 * matters — Shrok's ContextAssembler owns history keyed to ha-${conversation_id}.
 *
 * Returns null if no user turn is found or the last user turn has null/empty content.
 * The caller is responsible for responding 400 on null (HACV-03).
 *
 * Uses optional chaining (msg?.role) to satisfy noUncheckedIndexedAccess.
 */
export function extractLastUserTurn(
  messages: Array<{ role: string; content: string | null }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.content === 'string' && msg.content.length > 0) {
      return msg.content
    }
  }
  return null
}

// ─── Response helpers ─────────────────────────────────────────────────────────

/**
 * Build a non-streaming OpenAI Chat Completions response for Home Assistant.
 *
 * Fields:
 * - id: 'chatcmpl-' + UUID
 * - object: 'chat.completion'
 * - created: seconds since epoch
 * - model: 'shrok'
 * - choices[0]: index 0, assistant message, finish_reason 'stop', logprobs null
 * - usage: all zeroed (HACV-01)
 * - conversation_id: echoed for HA ChatLog stitching (HACV-05)
 *
 * NEVER call with null/empty content — the caller must guarantee a non-empty string
 * before invoking (PITFALLS P7).
 */
export function buildChatCompletionResponse(
  content: string,
  conversationId: string,
): Record<string, unknown> {
  const response: ChatCompletion & { conversation_id: string } = {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'shrok',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          refusal: null,
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    conversation_id: conversationId,
  }
  return response as unknown as Record<string, unknown>
}
