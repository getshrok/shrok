import type { Topic } from '../memory/index.js'
import type { LLMRouter } from '../types/llm.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComposerMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  tokenCost: number
  content: string
}

export interface ComposerInput {
  topics: Topic[]
  messages: ComposerMessage[]   // newest-to-oldest
  totalBudget: number
  identityContext: string
}

export interface ComposerResult {
  topics: Array<{ topicId: string; budgetTokens: number }>
  historyTokenBudget: number
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const COMPOSER_SYSTEM = `You are a context manager for a personal AI assistant. Each turn, decide which topic memories and how much conversation history to include in the assistant's context window.

Your response must be valid JSON matching this schema:
{"topics": [{"topicId": string, "budgetTokens": integer}], "historyTokenBudget": integer}

**Default to maximizing conversation history.** Only allocate budget to memories when they are directly relevant to the current conversation — a topic the user is actively asking about or that clearly applies to what's happening now. Irrelevant memories waste context; omit them.

**Topic fidelity:** Topics can be loaded at any fidelity between summaries-only and full raw. Allocating less than a topic's full size is fine — the most recent content comes through raw first, older content falls back to summaries. This lets you include multiple topics at reduced fidelity rather than omitting them entirely.

**Budget constraint:** sum of all topicBudgetTokens + historyTokenBudget must be ≤ totalBudget.

Respond with only the JSON object, no markdown, no explanation.`

function buildUserPrompt(input: ComposerInput): string {
  const topicLines = input.topics.map(t => {
    const summaryOnlyTokens = t.chunkCount * 100
    return `- ${t.topicId}: "${t.label}"
    summary: ${t.summary}
    full: ~${t.estimatedTokens} tokens | summaries-only: ~${summaryOnlyTokens} tokens | chunks: ${t.chunkCount} | updated: ${t.lastUpdatedAt}`
  }).join('\n')

  const msgLines = input.messages.map(m =>
    `[${m.tokenCost} tokens] ${m.createdAt} ${m.role}: ${m.content}`
  ).join('\n')

  return `## Budget
Total: ${input.totalBudget} tokens (memories + history combined)

## Available Topic Memories
Each topic shows two sizes:
- full: complete raw conversation (~estimatedTokens tokens)
- summaries: chunk-level summaries only (~chunkCount × 100 tokens)
Allocating anywhere between summaries-only and full gives a proportional mix
(most-recent chunks raw, older chunks as summaries). The topic-level summary
is always included regardless of budget.

${topicLines}

## Recent Conversation (newest first, with token costs)
${msgLines || '(no conversation history yet)'}

## User Identity
${input.identityContext}`
}

// ─── runComposer ──────────────────────────────────────────────────────────────

export async function runComposer(
  router: LLMRouter,
  model: string,
  input: ComposerInput,
): Promise<ComposerResult> {
  const fallback: ComposerResult = {
    topics: [],
    historyTokenBudget: input.totalBudget,
  }

  if (input.topics.length === 0) return fallback

  const userPrompt = buildUserPrompt(input)

  let raw: string
  try {
    const response = await router.complete(
      model,
      [{ kind: 'text', role: 'user', id: 'composer-req', content: userPrompt, createdAt: new Date().toISOString() }],
      [],
      { systemPrompt: COMPOSER_SYSTEM, maxTokens: 4000, jsonSchema: { name: 'composer', schema: { type: 'object', properties: { topics: { type: 'array', items: { type: 'object', properties: { topicId: { type: 'string' }, budgetTokens: { type: 'number' } }, required: ['topicId', 'budgetTokens'], additionalProperties: false } }, historyTokenBudget: { type: 'number' } }, required: ['topics', 'historyTokenBudget'], additionalProperties: false } } },
    )
    raw = response.content
  } catch {
    return fallback
  }

  let parsed: ComposerResult
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    parsed = JSON.parse(cleaned) as ComposerResult
    if (!Array.isArray(parsed.topics) || typeof parsed.historyTokenBudget !== 'number') {
      return fallback
    }
  } catch {
    return fallback
  }

  // Enforce history floor: historyTokenBudget ≥ totalBudget / 5
  const floor = Math.floor(input.totalBudget / 5)
  if (parsed.historyTokenBudget < floor) {
    const deficit = floor - parsed.historyTokenBudget
    parsed.historyTokenBudget = floor
    // Scale down topic budgets proportionally to absorb the deficit
    const topicTotal = parsed.topics.reduce((s, t) => s + t.budgetTokens, 0)
    if (topicTotal > 0) {
      const scale = Math.max(0, topicTotal - deficit) / topicTotal
      parsed.topics = parsed.topics.map(t => ({
        ...t,
        budgetTokens: Math.floor(t.budgetTokens * scale),
      }))
    }
  }

  // Clamp total to budget
  const topicTotal = parsed.topics.reduce((s, t) => s + t.budgetTokens, 0)
  const total = topicTotal + parsed.historyTokenBudget
  if (total > input.totalBudget) {
    // Scale down topic budgets to fit
    const maxTopics = Math.max(0, input.totalBudget - parsed.historyTokenBudget)
    if (topicTotal > 0) {
      const scale = maxTopics / topicTotal
      parsed.topics = parsed.topics.map(t => ({
        ...t,
        budgetTokens: Math.floor(t.budgetTokens * scale),
      }))
    }
  }

  return parsed
}
