import Anthropic from '@anthropic-ai/sdk'
import type { Message, ToolCall } from '../types/core.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import { withRetry, LLMApiError, classifyLLMStatus, parseRetryAfter } from './util.js'
import { toAnthropicAttachments } from './attachment.js'
import { prefixTimestamp } from './timestamp.js'
import { timingMark } from '../timing.js'

// ─── Message translation ─────────────────────────────────────────────────────

function sanitizeMessages(messages: Message[]): Message[] {
  // Build set of tool_call ids that are present in this context window
  const presentCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.kind === 'tool_call') {
      for (const tc of msg.toolCalls) presentCallIds.add(tc.id)
    }
  }
  // Build set of tool_call ids that have a matching tool_result
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.kind === 'tool_result') {
      for (const tr of msg.toolResults) resolvedIds.add(tr.toolCallId)
    }
  }
  // Strip tool_call messages whose tool_use ids are not all resolved,
  // and strip orphaned tool_result messages (paired call absent or unresolved).
  const orphanCallIds = new Set<string>()
  const kept: Message[] = []
  for (const msg of messages) {
    if (msg.kind === 'tool_call') {
      const allResolved = msg.toolCalls.every(tc => resolvedIds.has(tc.id))
      if (!allResolved) {
        for (const tc of msg.toolCalls) orphanCallIds.add(tc.id)
        continue
      }
    }
    if (msg.kind === 'tool_result') {
      // Drop if any paired tool_call is absent from context or was itself orphaned
      const allCallsPresent = msg.toolResults.every(
        tr => presentCallIds.has(tr.toolCallId) && !orphanCallIds.has(tr.toolCallId)
      )
      if (!allCallsPresent) continue
    }
    kept.push(msg)
  }
  return kept
}

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of sanitizeMessages(messages)) {
    switch (msg.kind) {
      case 'text': {
        const timestamped = prefixTimestamp(msg.content, msg.createdAt)
        // Attachments on assistant messages are display-only (e.g. send_file) —
        // image blocks are only allowed in user/tool_result turns.
        if (!msg.attachments?.length || msg.role === 'assistant') {
          result.push({ role: msg.role, content: timestamped })
        } else {
          const { blocks, stubs, hints } = toAnthropicAttachments(msg.attachments)
          const text = [timestamped, hints, stubs].filter(Boolean).join('\n')
          const content: Anthropic.ContentBlockParam[] = [
            ...blocks,
            { type: 'text', text },
          ]
          result.push({ role: msg.role, content })
        }
        break
      }

      case 'tool_call': {
        const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []
        if (msg.content) {
          content.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })
        }
        result.push({ role: 'assistant', content })
        break
      }

      case 'tool_result':
        result.push({
          role: 'user',
          content: msg.toolResults.map(tr => {
            if (tr.attachments?.length) {
              const { blocks } = toAnthropicAttachments(tr.attachments)
              return {
                type: 'tool_result' as const,
                tool_use_id: tr.toolCallId,
                content: [
                  { type: 'text' as const, text: tr.content },
                  ...blocks,
                ] as Anthropic.ToolResultBlockParam['content'],
              }
            }
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.toolCallId,
              content: tr.content,
            }
          }) as Anthropic.ToolResultBlockParam[],
        })
        break

      case 'summary':
        result.push({
          role: 'user',
          content: `[Summary of conversation from ${msg.summarySpan[0]} to ${msg.summarySpan[1]}]:\n${msg.content}`,
        })
        break
    }
  }

  // Merge consecutive same-role messages into one (required by Anthropic's alternating turn rule).
  // This handles split text+tool_call messages and any other consecutive same-role edge cases.
  const merged: Anthropic.MessageParam[] = []
  for (const msg of result) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      // Merge content arrays
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text' as const, text: prev.content }]
      const curContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: msg.content }]
      prev.content = [...prevContent, ...curContent] as Anthropic.ContentBlockParam[]
    } else {
      merged.push(msg)
    }
  }
  return merged
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  const result: Anthropic.Tool[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }))
  // Cache the tools list — it's static between calls. Mark the last tool.
  if (result.length > 0) {
    result[result.length - 1] = {
      ...result[result.length - 1]!,
      cache_control: { type: 'ephemeral' },
    }
  }
  return result
}

/**
 * Split a system prompt into a cached static block and an optional dynamic block.
 * The static portion is everything before "\n\nCurrent time:" — it changes rarely
 * and is safe to cache. The dynamic tail (timestamp etc.) is sent uncached so it
 * never busts the cache for the stable prefix.
 */
function toAnthropicSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
  const DYNAMIC_MARKER = '\n\nCurrent time:'
  const idx = systemPrompt.indexOf(DYNAMIC_MARKER)
  if (idx === -1) {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
  }
  return [
    { type: 'text', text: systemPrompt.slice(0, idx), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemPrompt.slice(idx + 2) },  // +2 to drop the leading \n\n
  ]
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async complete(messages: Message[], tools: ToolDefinition[], options: LLMOptions): Promise<LLMResponse> {
    const anthropicMessages = toAnthropicMessages(messages)
    const anthropicTools = toAnthropicTools(tools)
    const maxTokens = options.maxTokens ?? 8192

    try {
      timingMark('provider.request_start', { provider: 'anthropic', model: options.model })
      const response = await withRetry(
        () => this.client.messages.create({
          model: options.model,
          max_tokens: maxTokens,
          ...(options.systemPrompt !== undefined ? { system: toAnthropicSystem(options.systemPrompt) } : {}),
          messages: anthropicMessages,
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          ...(options.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: options.jsonSchema.schema } } } : {}),
        }),
        [429, 529]
      )
      timingMark('provider.request_end', { provider: 'anthropic', model: options.model })

      let content = ''
      const toolCalls: ToolCall[] = []

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          })
        }
      }

      const stopReason = response.stop_reason === 'tool_use'
        ? 'tool_use'
        : response.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : 'end_turn'

      return {
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: ((response.usage as unknown) as Record<string, number>).cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: ((response.usage as unknown) as Record<string, number>).cache_creation_input_tokens ?? 0,
        stopReason,
        model: response.model,
      }
    } catch (err) {
      if (err instanceof LLMApiError) throw err
      const status = (err as { status?: number }).status
      const retryAfterMs = status === 429
        ? parseRetryAfter((err as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('retry-after'))
        : undefined
      throw new LLMApiError((err as Error).message, classifyLLMStatus(status), status, 'anthropic', retryAfterMs)
    }
  }
}

export { toAnthropicMessages, toAnthropicTools }
