import { Memory } from '../icw/index.js'
import type { LLMFunction } from '../icw/index.js'
import type { Message as ShrokMessage } from '../types/core.js'

export { Memory }
export type { Topic, RetrieveResult } from '../icw/index.js'

export function createTopicMemory(
  storagePath: string,
  llm: LLMFunction,
  retrievalTokenBudget?: number,
  archivalLlm?: LLMFunction,
  retrievalLlm?: LLMFunction,
  chunkingLlm?: LLMFunction,
): Memory {
  return new Memory({
    storagePath, llm, graph: true,
    ...(chunkingLlm ? { chunkingLlm } : {}),
    ...(archivalLlm ? { archivalLlm } : {}),
    ...(retrievalLlm ? { retrievalLlm } : {}),
    ...(retrievalTokenBudget !== undefined ? { config: { retrievalTokenBudget } } : {}),
  })
}

/** Filter messages down to what infinitecontextwindow expects.
 *  Attachment metadata is appended to the message content so it survives archival
 *  even after the raw files have been cleaned up. */
export function toMemoryMessages(msgs: ShrokMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return msgs
    .filter((m): m is Extract<ShrokMessage, { kind: 'text' }> => m.kind === 'text')
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      let content = m.content
      if (m.attachments?.length) {
        const summary = m.attachments
          .map(a => `${a.filename ?? a.type} (${a.mediaType})`)
          .join(', ')
        content = content ? `${content}\n[Attachments: ${summary}]` : `[Attachments: ${summary}]`
      }
      return { role: m.role, content }
    })
}
