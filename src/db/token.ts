import { get_encoding } from 'tiktoken'
import type { Message } from '../types/core.js'

// cl100k_base is used by GPT-4 and is a close approximation for Claude and Gemini.
// Initialized once on first call; lives for the process lifetime.
let enc: ReturnType<typeof get_encoding> | null = null
function getEncoder(): ReturnType<typeof get_encoding> {
  if (!enc) enc = get_encoding('cl100k_base')
  return enc
}

// Rough token costs for media attachments (per item, provider-agnostic estimate)
const ATTACHMENT_TOKEN_COST: Record<string, number> = {
  image:    1600,   // Anthropic standard image; roughly correct for all providers
  document:  500,   // conservative estimate for a typical page
  audio:     300,   // stub cost — not actually sent to most models yet
  video:    1600,   // similar to image
}

function messageText(msg: Message): string {
  switch (msg.kind) {
    case 'text':    return msg.content
    case 'summary': return msg.content
    case 'tool_call':   return msg.content + JSON.stringify(msg.toolCalls)
    case 'tool_result': return JSON.stringify(msg.toolResults)
  }
}

function messageMediaTokens(msg: Message): number {
  if (msg.kind !== 'text' || !msg.attachments?.length) return 0
  return msg.attachments.reduce((sum, att) => sum + (ATTACHMENT_TOKEN_COST[att.type] ?? 500), 0)
}

export function estimateTokens(messages: Message[]): number {
  const text = messages.map(messageText).join('\n')
  const textTokens = getEncoder().encode(text).length
  const mediaTokens = messages.reduce((sum, msg) => sum + messageMediaTokens(msg), 0)
  return textTokens + mediaTokens
}

export function estimateStringTokens(text: string): number {
  return getEncoder().encode(text).length
}
