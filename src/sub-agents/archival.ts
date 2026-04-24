import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'
import type { AgentStore } from '../db/agents.js'
import { estimateTokens } from '../db/token.js'
import { estimateCost } from '../llm/pricing.js'
import { generateId, now } from '../llm/util.js'
import { log } from '../logger.js'

export interface ArchivalDeps {
  llmRouter: LLMRouter
  usageStore: UsageStore
  stewardModel: string
  archivalThreshold: number
  agentStore: AgentStore
  agentId: string
}

/**
 * When `history` exceeds the archival token threshold, compact the oldest 30%
 * into a summary message via the steward model. Mutates `history` in place.
 * On LLM failure, falls back to a silent trim plus a system notice.
 */
export async function maybeArchiveHistory(
  agentId: string,
  history: Message[],
  deps: ArchivalDeps,
): Promise<void> {
  if (estimateTokens(history) <= deps.archivalThreshold) return

  const cutoff = Math.floor(history.length * 0.3)
  if (cutoff < 1) return

  const toCompact = history.slice(0, cutoff)

  const summaryText = toCompact.map((m): string => {
    if (m.kind === 'text' || m.kind === 'summary') return m.content
    if (m.kind === 'tool_call') {
      return `[Tool calls:\n${m.toolCalls.map(tc => `  ${tc.name}(${JSON.stringify(tc.input)})`).join('\n')}]`
    }
    return `[Tool results:\n${m.toolResults.map(tr => `  ${tr.name} → ${tr.content}`).join('\n')}]`
  }).join('\n')

  if (!summaryText) {
    const lastCompactedId = toCompact[cutoff - 1]!.id
    history.splice(0, cutoff)
    deps.agentStore.compactHistory(deps.agentId, lastCompactedId, null)
    return
  }

  try {
    const summaryResp = await deps.llmRouter.complete(deps.stewardModel, [{
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: `Summarize this conversation history concisely:\n\n${summaryText}`,
      createdAt: now(),
    }], [], {
      maxTokens: 2048,
      systemPrompt: 'You are a helpful assistant. Summarize the provided conversation history into a concise paragraph capturing the key events, decisions, and context.',
    })

    deps.usageStore.record({
      model: summaryResp.model,
      inputTokens: summaryResp.inputTokens,
      outputTokens: summaryResp.outputTokens,
      sourceType: 'archival',
      sourceId: agentId,
      costUsd: estimateCost(
        summaryResp.model, summaryResp.inputTokens, summaryResp.outputTokens,
        summaryResp.cacheReadInputTokens, summaryResp.cacheCreationInputTokens,
      ),
      cacheReadTokens: summaryResp.cacheReadInputTokens ?? 0,
      cacheWriteTokens: summaryResp.cacheCreationInputTokens ?? 0,
    })

    const summaryMsg: Message = {
      kind: 'summary',
      id: generateId('sum'),
      content: summaryResp.content,
      summarySpan: [toCompact[0]!.createdAt, toCompact[cutoff - 1]!.createdAt],
      createdAt: now(),
    }

    const lastCompactedId = toCompact[cutoff - 1]!.id
    history.splice(0, cutoff, summaryMsg)
    deps.agentStore.compactHistory(deps.agentId, lastCompactedId, summaryMsg)
    log.info(`[agent:${agentId}] Archived ${cutoff} messages into 1 summary.`)
  } catch (err) {
    log.warn(`[agent:${agentId}] Archival failed, trimming instead:`, (err as Error).message)
    const lastCompactedId = toCompact[cutoff - 1]!.id
    const noticeMsg: TextMessage = {
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: '[System notice: Some earlier context was trimmed due to a memory error. Recent context is intact.]',
      injected: true,
      createdAt: now(),
    }
    history.splice(0, cutoff)
    history.unshift(noticeMsg)
    deps.agentStore.compactHistory(deps.agentId, lastCompactedId, noticeMsg)
  }
}
