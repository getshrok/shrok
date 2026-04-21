import type { Message, ToolCall } from './core.js'

// ─── Tool primitives ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema
}

// ─── LLM response ─────────────────────────────────────────────────────────────

export interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  model: string   // the model string actually used — read by UsageStore.record()
}

// ─── Options ──────────────────────────────────────────────────────────────────

/** Options passed by callers. No model — the router owns model selection. */
export interface LLMCallOptions {
  maxTokens?: number
  systemPrompt?: string
  /** When set, providers use structured output to guarantee JSON matching this schema. */
  jsonSchema?: {
    name: string
    schema: Record<string, unknown>
  }
}

/** Options passed to the raw provider. Includes model — set by the router, not callers. */
export interface LLMOptions extends LLMCallOptions {
  model: string
}

// ─── Tier ─────────────────────────────────────────────────────────────────────

export type Tier = 'standard' | 'capable' | 'expert'

export interface TierModels {
  standard: string
  capable: string
  expert: string
}

// ─── Router and provider contracts ───────────────────────────────────────────

/** LLMRouter is what every caller in the system uses.
 *  It accepts a tier name or direct model ID, resolves the right provider and model. */
export interface LLMRouter {
  complete(
    model: string,
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMCallOptions
  ): Promise<LLMResponse>
}

/** LLMProvider is the raw per-provider contract. Only the router and tests use it directly. */
export interface LLMProvider {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMOptions    // includes model — set by router
  ): Promise<LLMResponse>

  name: string  // 'anthropic' | 'gemini' | 'openai'
}
