import OpenAI from 'openai'
import type { Message, ToolCall } from '../types/core.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import { withRetry, LLMApiError, classifyLLMStatus, parseRetryAfter } from './util.js'
import { toOpenAIAttachments } from './attachment.js'
import { prefixTimestamp } from './timestamp.js'
import { timingMark } from '../timing.js'

// ─── Message translation ─────────────────────────────────────────────────────

function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    switch (msg.kind) {
      case 'text': {
        const timestamped = prefixTimestamp(msg.content, msg.createdAt)
        if (!msg.attachments?.length || msg.role === 'assistant') {
          result.push({ role: msg.role, content: timestamped })
        } else {
          const { parts, stubs, hints } = toOpenAIAttachments(msg.attachments)
          const text = [timestamped, hints, stubs].filter(Boolean).join('\n')
          const content: OpenAI.ChatCompletionContentPart[] = [
            ...parts,
            { type: 'text', text },
          ]
          // OpenAI only supports content arrays on user messages, not assistant
          if (msg.role === 'user') {
            result.push({ role: 'user', content })
          } else {
            result.push({ role: 'assistant', content: text })
          }
        }
        break
      }

      case 'tool_call':
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        })
        break

      case 'tool_result':
        // OpenAI expects one message per tool result; tool messages are text-only
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content,
          })
        }
        // OpenAI tool messages don't support images — inject as a follow-up user message
        for (const tr of msg.toolResults) {
          if (tr.attachments?.length) {
            const { parts } = toOpenAIAttachments(tr.attachments)
            if (parts.length > 0) {
              result.push({
                role: 'user',
                content: [
                  { type: 'text' as const, text: `[Image from ${tr.name}]` },
                  ...parts,
                ],
              })
            }
          }
        }
        break

      case 'summary':
        result.push({
          role: 'user',
          content: `[Summary of conversation from ${msg.summarySpan[0]} to ${msg.summarySpan[1]}]:\n${msg.content}`,
        })
        break
    }
  }

  // Merge consecutive assistant messages (split text + tool_call).
  const merged: OpenAI.ChatCompletionMessageParam[] = []
  for (const msg of result) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      const p = prev as OpenAI.ChatCompletionAssistantMessageParam
      const c = msg as OpenAI.ChatCompletionAssistantMessageParam
      // Merge: take text from whichever has it, tool_calls from whichever has them
      if (c.content && !p.content) p.content = c.content
      else if (c.content && p.content) p.content = `${p.content}\n${c.content}`
      if (c.tool_calls) p.tool_calls = [...(p.tool_calls ?? []), ...c.tool_calls]
    } else {
      merged.push(msg)
    }
  }
  return merged
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async complete(messages: Message[], tools: ToolDefinition[], options: LLMOptions): Promise<LLMResponse> {
    const openaiMessages = toOpenAIMessages(messages)
    const openaiTools = toOpenAITools(tools)
    const maxTokens = options.maxTokens ?? 8192

    try {
      timingMark('provider.request_start', { provider: 'openai', model: options.model })
      const response = await withRetry(
        () => this.client.chat.completions.create({
          model: options.model,
          max_tokens: maxTokens,
          messages: openaiMessages,
          ...(options.systemPrompt ? {
            messages: [{ role: 'system' as const, content: options.systemPrompt }, ...openaiMessages],
          } : {}),
          ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
          ...(options.jsonSchema ? { response_format: { type: 'json_schema' as const, json_schema: { name: options.jsonSchema.name, schema: options.jsonSchema.schema, strict: true } } } : {}),
        }),
        [429, 503]
      )
      timingMark('provider.request_end', { provider: 'openai', model: options.model })

      const choice = response.choices[0]
      const msg = choice?.message
      const content = msg?.content ?? ''
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }))

      const finishReason = choice?.finish_reason
      const stopReason: LLMResponse['stopReason'] =
        finishReason === 'tool_calls' ? 'tool_use'
        : finishReason === 'length' ? 'max_tokens'
        : 'end_turn'

      return {
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        stopReason,
        model: response.model,
      }
    } catch (err) {
      if (err instanceof LLMApiError) throw err
      const status = (err as { status?: number }).status
      const retryAfterMs = status === 429
        ? parseRetryAfter((err as { headers?: { get?: (k: string) => string | null } }).headers?.get?.('retry-after'))
        : undefined
      throw new LLMApiError((err as Error).message, classifyLLMStatus(status), status, 'openai', retryAfterMs)
    }
  }
}

export { toOpenAIMessages, toOpenAITools }
