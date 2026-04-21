/**
 * Message relevance classifier.
 *
 * Used by both the head composer and agent composer to filter conversation
 * history to only messages relevant to a given topic. The LLM classifies
 * each message; your code filters — the LLM never touches the messages themselves.
 *
 * Tool_call/tool_result pairs are classified as a single unit and kept or
 * dropped together to maintain history coherence.
 */

import { generateId, extractJson } from '../llm/util.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'
import type { Message, TextMessage, ToolCallMessage, ToolResultMessage } from '../types/core.js'

import { log } from '../logger.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClassifiedEntry {
  id: string           // classifier entry ID (maps back to original messages)
  relevant: boolean
  reason: string
}

/** A classifier entry — either a single text message or a tool_call/result pair. */
interface ClassifierEntry {
  id: string
  summary: string       // what the classifier sees
  originalIndices: number[]  // indices into the original message array
}

// ─── Entry preparation ───────────────────────────────────────────────────────

/**
 * Walk the message array and produce classifier entries.
 * - Text messages → one entry each
 * - tool_call + tool_result pairs → one entry per pair (matched by toolCallId)
 * - Orphaned tool_results → one entry each
 */
export function prepareEntries(messages: Message[]): ClassifierEntry[] {
  const entries: ClassifierEntry[] = []
  const consumed = new Set<number>()

  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue
    const msg = messages[i]!

    if (msg.kind === 'tool_call') {
      // Look for the paired tool_result immediately after
      const next = messages[i + 1]
      if (next?.kind === 'tool_result') {
        const callMsg = msg as ToolCallMessage
        const resultMsg = next as ToolResultMessage
        const parts = callMsg.toolCalls.map(tc => {
          const result = resultMsg.toolResults.find(tr => tr.toolCallId === tc.id)
          const inputSnippet = JSON.stringify(tc.input)
          const resultSnippet = result ? result.content : '(no result)'
          return `[tool] ${tc.name}(${inputSnippet}) → ${resultSnippet}`
        })
        entries.push({
          id: `pair_${i}`,
          summary: parts.join('\n'),
          originalIndices: [i, i + 1],
        })
        consumed.add(i)
        consumed.add(i + 1)
      } else {
        // Orphaned tool_call — summarize it standalone
        const callMsg = msg as ToolCallMessage
        const parts = callMsg.toolCalls.map(tc =>
          `[tool_call] ${tc.name}(${JSON.stringify(tc.input)})`
        )
        entries.push({
          id: `call_${i}`,
          summary: (callMsg.content ? callMsg.content + '\n' : '') + parts.join('\n'),
          originalIndices: [i],
        })
        consumed.add(i)
      }
    } else if (msg.kind === 'tool_result') {
      // Orphaned tool_result (no preceding call in window)
      const resultMsg = msg as ToolResultMessage
      const parts = resultMsg.toolResults.map(tr =>
        `[tool_result] ${tr.name}: ${tr.content}`
      )
      entries.push({
        id: `result_${i}`,
        summary: parts.join('\n'),
        originalIndices: [i],
      })
      consumed.add(i)
    } else {
      // Text message
      const textMsg = msg as TextMessage
      entries.push({
        id: `msg_${i}`,
        summary: `[${textMsg.role}] ${textMsg.content}`,
        originalIndices: [i],
      })
      consumed.add(i)
    }
  }

  return entries
}

// ─── Classification ──────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a context relevance classifier. For each message, decide if it is relevant to the given topic.

Rules:
- A message is relevant if it contains information the recipient needs to understand or respond to the topic
- User identity, preferences, and personal context are ALWAYS relevant
- Messages about unrelated tasks, other agent spawns, or other agents' results are NOT relevant
- When uncertain, mark as relevant (false negatives are worse than false positives)

Respond with a JSON array. Each element: {"id": "<message_id>", "relevant": true/false, "reason": "<brief reason>"}
Return ONLY the JSON array, no other text.`

/**
 * Classify messages by relevance to a topic. Returns classification for every entry.
 * Batches entries to stay within reasonable context sizes.
 */
export async function classifyMessages(
  topic: string,
  messages: Message[],
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  batchSize = 15,
): Promise<{ relevantIndices: Set<number>; classifications: ClassifiedEntry[] }> {
  const entries = prepareEntries(messages)

  // If very few entries, skip classification — include everything
  if (entries.length <= 3) {
    const allIndices = new Set<number>()
    for (const e of entries) for (const idx of e.originalIndices) allIndices.add(idx)
    return {
      relevantIndices: allIndices,
      classifications: entries.map(e => ({ id: e.id, relevant: true, reason: 'too few messages to filter' })),
    }
  }

  const allClassifications: ClassifiedEntry[] = []

  // Process in batches
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize)
    const numbered = batch.map((e, i) => `${e.id}: ${e.summary}`).join('\n\n')

    const prompt = `Topic: ${topic}\n\nMessages to classify:\n${numbered}`

    try {
      const response = await router.complete(
        model,
        [{ kind: 'text' as const, id: generateId('msg'), role: 'user' as const, content: prompt, createdAt: new Date().toISOString() }],
        [],
        { systemPrompt: CLASSIFIER_SYSTEM, maxTokens: 2048 },
      )

      if (usageStore) {
        usageStore.record({
          sourceType: 'head',
          sourceId: null,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: 0,
        })
      }

      // Parse the response — expect a JSON array
      const parsed = extractJson(response.content)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string' && typeof item.relevant === 'boolean') {
            allClassifications.push({
              id: item.id,
              relevant: item.relevant,
              reason: item.reason ?? '',
            })
          }
        }
      }
    } catch (err) {
      log.warn('classification batch failed, including all:', (err as Error).message)
      // On failure, include everything from this batch
      for (const e of batch) {
        allClassifications.push({ id: e.id, relevant: true, reason: 'classification failed — included by default' })
      }
    }
  }

  // Build the set of original message indices to keep
  const relevantIndices = new Set<number>()
  const classificationMap = new Map(allClassifications.map(c => [c.id, c]))

  for (const entry of entries) {
    const classification = classificationMap.get(entry.id)
    // Default to relevant if classification missing (fail open)
    if (!classification || classification.relevant) {
      for (const idx of entry.originalIndices) {
        relevantIndices.add(idx)
      }
    }
  }

  return { relevantIndices, classifications: allClassifications }
}

// ─── Advanced composer (three-way: keep / drop / extract) ───────────────────

export type ComposerAction = 'keep' | 'drop' | 'extract'

export interface ComposedEntry {
  id: string
  action: ComposerAction
  reason: string
  extracted?: string
}

const COMPOSER_SYSTEM = `You are a context relevance composer. For each message, decide how it relates to the given task.

Actions:
- "keep" — message is fully relevant to this task, include as-is
- "drop" — message is not relevant to this task at all
- "extract" — message is PARTIALLY relevant. Extract ONLY the portion relevant to this task. The extracted text should be brief — just the relevant facts, not a full rewrite.

Rules:
- User identity, preferences, and personal context → keep
- Messages entirely about unrelated tasks or other agents → drop
- Messages that mention this task AND other unrelated tasks → extract (pull only this task's portion)
- When uncertain between keep and extract, prefer keep
- When uncertain between drop and keep, prefer keep

Respond with a JSON array. Each element:
{"id": "<id>", "action": "keep|drop|extract", "reason": "<brief>", "extracted": "<relevant portion, only if action is extract>"}
Return ONLY the JSON array, no other text.`

/**
 * Three-way classification: KEEP, DROP, or EXTRACT (partial rewrite).
 * Used by the agent context composer to give agents only task-relevant context.
 *
 * Returns relevantIndices (which messages to include) and replacements
 * (message index → extracted text for EXTRACT'd messages).
 */
export async function classifyAndCompose(
  topic: string,
  messages: Message[],
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  batchSize = 15,
): Promise<{
  relevantIndices: Set<number>
  replacements: Map<number, string>
  classifications: ComposedEntry[]
}> {
  const entries = prepareEntries(messages)
  const allClassifications: ComposedEntry[] = []

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize)
    const numbered = batch.map(e => `${e.id}: ${e.summary}`).join('\n\n')
    const prompt = `Task: ${topic}\n\nMessages to classify:\n${numbered}`

    try {
      const response = await router.complete(
        model,
        [{ kind: 'text' as const, id: generateId('msg'), role: 'user' as const, content: prompt, createdAt: new Date().toISOString() }],
        [],
        { systemPrompt: COMPOSER_SYSTEM, maxTokens: 16_000 },
      )

      if (usageStore) {
        usageStore.record({
          sourceType: 'head',
          sourceId: null,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: 0,
        })
      }

      const parsed = extractJson(response.content)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string' && typeof item.action === 'string') {
            allClassifications.push({
              id: item.id,
              action: (item.action === 'drop' || item.action === 'extract') ? item.action : 'keep',
              reason: item.reason ?? '',
              extracted: item.action === 'extract' ? (item.extracted ?? '') : undefined,
            })
          }
        }
      }
    } catch (err) {
      log.warn('composer batch failed, including all:', (err as Error).message)
      for (const e of batch) {
        allClassifications.push({ id: e.id, action: 'keep', reason: 'classification failed — included by default' })
      }
    }
  }

  // Build relevantIndices and replacements from classifications
  const relevantIndices = new Set<number>()
  const replacements = new Map<number, string>()
  const classMap = new Map(allClassifications.map(c => [c.id, c]))

  for (const entry of entries) {
    const c = classMap.get(entry.id)
    if (!c || c.action === 'keep') {
      // Keep all original indices
      for (const idx of entry.originalIndices) relevantIndices.add(idx)
    } else if (c.action === 'extract' && c.extracted) {
      // For EXTRACT: include only the first index and add to replacements.
      // Tool pairs collapse to a single replaced message.
      const firstIdx = entry.originalIndices[0]!
      relevantIndices.add(firstIdx)
      replacements.set(firstIdx, c.extracted)
    }
    // DROP: skip entirely
  }

  return { relevantIndices, replacements, classifications: allClassifications }
}
