import { GoogleGenerativeAI, type Content, type Part, type Tool as GeminiTool } from '@google/generative-ai'
import type { Message, ToolCall } from '../types/core.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import { withRetry, LLMApiError, classifyLLMStatus } from './util.js'
import { toGeminiAttachments } from './attachment.js'
import { prefixTimestamp } from './timestamp.js'
import { timingMark } from '../timing.js'

// ─── Message translation ─────────────────────────────────────────────────────

function toGeminiContents(messages: Message[]): Content[] {
  const result: Content[] = []

  for (const msg of messages) {
    switch (msg.kind) {
      case 'text': {
        const timestamped = prefixTimestamp(msg.content, msg.createdAt)
        if (!msg.attachments?.length || msg.role === 'assistant') {
          result.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: timestamped }],
          })
        } else {
          const { parts: attParts, stubs, hints } = toGeminiAttachments(msg.attachments)
          const text = [timestamped, hints, stubs].filter(Boolean).join('\n')
          result.push({
            role: 'user' as const,  // only user messages reach here (assistant filtered above)
            parts: [...attParts, { text }],
          })
        }
        break
      }

      case 'tool_call': {
        const parts: Part[] = msg.toolCalls.map(tc => ({
          functionCall: { name: tc.name, args: tc.input },
        }))
        if (msg.content) parts.unshift({ text: msg.content })
        result.push({ role: 'model', parts })
        break
      }

      case 'tool_result': {
        const trParts: Part[] = msg.toolResults.map(tr => ({
          functionResponse: {
            name: tr.name,
            response: { output: tr.content },
          },
        }))
        for (const tr of msg.toolResults) {
          if (tr.attachments?.length) {
            const { parts: imgParts } = toGeminiAttachments(tr.attachments)
            trParts.push(...imgParts)
          }
        }
        result.push({ role: 'user', parts: trParts })
        break
      }

      case 'summary':
        result.push({
          role: 'user',
          parts: [{
            text: `[Summary of conversation from ${msg.summarySpan[0]} to ${msg.summarySpan[1]}]:\n${msg.content}`,
          }],
        })
        break
    }
  }

  // Merge consecutive same-role entries (split text + tool_call).
  const merged: Content[] = []
  for (const entry of result) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === entry.role) {
      prev.parts = [...(prev.parts ?? []), ...(entry.parts ?? [])]
    } else {
      merged.push(entry)
    }
  }
  return merged
}

function toGeminiTools(tools: ToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return []
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as unknown as import('@google/generative-ai').FunctionDeclarationSchema,
    })),
  }]
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'
  private client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async complete(messages: Message[], tools: ToolDefinition[], options: LLMOptions): Promise<LLMResponse> {
    const contents = toGeminiContents(messages)
    const geminiTools = toGeminiTools(tools)
    const maxOutputTokens = options.maxTokens ?? 8192

    const model = this.client.getGenerativeModel({
      model: options.model,
      ...(options.systemPrompt ? { systemInstruction: options.systemPrompt } : {}),
      ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
      generationConfig: {
        maxOutputTokens,
        ...(options.jsonSchema ? { responseMimeType: 'application/json', responseSchema: options.jsonSchema.schema } : {}),
      },
    })

    try {
      timingMark('provider.request_start', { provider: 'gemini', model: options.model })
      const result = await withRetry(
        () => model.generateContent({ contents }),
        [429, 503]
      )
      timingMark('provider.request_end', { provider: 'gemini', model: options.model })

      const response = result.response
      const candidate = response.candidates?.[0]
      const parts = candidate?.content?.parts ?? []

      let content = ''
      const toolCalls: ToolCall[] = []

      let callIdx = 0
      for (const part of parts) {
        if ('text' in part && part.text) {
          content += part.text
        } else if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: `${part.functionCall.name}_${Date.now()}_${callIdx++}`,
            name: part.functionCall.name,
            input: part.functionCall.args as Record<string, unknown>,
          })
        }
      }

      const finishReason = candidate?.finishReason
      const stopReason: LLMResponse['stopReason'] =
        finishReason === 'STOP' ? 'end_turn'
        : finishReason === 'MAX_TOKENS' ? 'max_tokens'
        : toolCalls.length > 0 ? 'tool_use'
        : 'end_turn'

      const usage = response.usageMetadata
      return {
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        stopReason,
        model: options.model,
      }
    } catch (err) {
      if (err instanceof LLMApiError) throw err
      const status = (err as { status?: number }).status
      throw new LLMApiError((err as Error).message, classifyLLMStatus(status), status, 'gemini')
    }
  }
}

export { toGeminiContents, toGeminiTools }
