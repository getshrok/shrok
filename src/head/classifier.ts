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

import { generateId } from '../llm/util.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'
import type { Message, TextMessage, ToolCallMessage, ToolResultMessage } from '../types/core.js'

import { log } from '../logger.js'
import { estimateCost } from '../llm/pricing.js'

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

/**
 * Parse a classifier/composer response into the expected top-level JSON ARRAY.
 * The generic `extractJson` greedily matches the first `{`…last `}`, which mangles a
 * bare multi-element array (the shape these prompts return) — so parse the array
 * explicitly: prefer a ```json fence, then the first `[`…last `]`, then the raw body.
 * Throws on unparseable input; callers catch and fail open (keep everything).
 */
function parseComposerArray(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced?.[1] ?? content).trim()
  const bracketed = body.match(/\[[\s\S]*\]/)
  return JSON.parse(bracketed ? bracketed[0] : body)
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
          costUsd: estimateCost(response.model, response.inputTokens, response.outputTokens),
        })
      }

      // Parse the response — expect a JSON array
      const parsed = parseComposerArray(response.content)
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
  /** For action='extract': verbatim spans copied character-for-character from the
   *  source message. The model never writes free text — it only quotes — and each
   *  quote is verified against the source in code (see snapQuote + the stitch in
   *  classifyAndCompose) so the assembled context is verbatim by construction. */
  quotes?: string[]
}

const COMPOSER_SYSTEM = `You assemble the EXACT context a sub-agent needs to carry out ONE delegated task, drawn from a conversation that interleaves several topics. The USER's own messages are the source of truth for intent; assistant turns are confirmations.

For each message choose an action toward the delegated task:
- "keep"  — the message is ENTIRELY about this task; include it unchanged.
- "drop"  — the message is ENTIRELY about other topics, OR it is an assistant turn that merely restates asks already stated by the user (it adds nothing new for this task); exclude it.
- "extract" — the message mixes this task with anything else. Return the on-task parts as "quotes": an array of spans copied EXACTLY, character-for-character, as contiguous substrings of that message. Never paraphrase, fix typos, shorten, or merge.

Choose "extract" (not "keep") whenever a message contains this task's content AND any of:
- another task/topic in the same sentence (e.g. "do X and also do Y"),
- an unrelated aside, sign-off, or second request,
- a tool result whose output mixes on-task hits with unrelated hits ("Unrelated…", other files/matches) — quote only the on-task lines/spans,
- it is an ASSISTANT acknowledgement/confirmation that bundles several of the user's asks together in one sentence (assistant turns VERY OFTEN list this task alongside others — "X to A and Y to B, both after sign-off") — extract ONLY the clause confirming THIS task, or "drop" it if the user's own messages already carry that detail.
Only "keep" when the WHOLE message is on-task.

Fidelity rules (fidelity beats brevity — a dropped item is a serious failure, a stray off-task word is minor):
- Capture EVERY constraint, choice, value, name, ID, link, secret, endpoint, date, number, negative/"DO NOT" instruction, and the go-ahead that pertains to this task. When unsure whether something is relevant, include it.
- LATE CORRECTIONS are critical: later messages often override earlier ones (changed budget/seat/path/snapshot/slot/lifetime/quantity). Keep the corrected value; if it refers back ("not X, use Y"), keep enough to be unambiguous. A correction about ANOTHER task ("hold the budget spreadsheet") must NOT be included.
- COREFERENCE: a decision like "go with option B" / "use the second one" / "that one" is meaningless without its antecedent — you MUST also include the earlier message/span that DEFINES it (e.g. the option list, even far back or inside a tool result).

Respond ONLY with a JSON array. Each element:
{"id":"<id>","action":"keep|drop|extract","quotes":["<verbatim substring>", ...]}
("quotes" only for action="extract".)
Return ONLY the JSON array, no other text.`

/**
 * Three-way classification: KEEP, DROP, or EXTRACT (verbatim-quote extraction).
 * Used by the agent context composer to give agents only task-relevant context,
 * VERBATIM. The model never writes prose — for EXTRACT it returns exact quotes,
 * which are verified/snapped to real source substrings in code (see snapQuote and
 * the stitch below), so the assembled context is verbatim by construction.
 *
 * Returns relevantIndices (which messages to include) and replacements
 * (message index → the joined verified verbatim spans for EXTRACT'd messages).
 */
export async function classifyAndCompose(
  topic: string,
  messages: Message[],
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  // Single-pass by default: late corrections and their antecedents must be judged
  // together (coreference + supersession break when split across batches). Typical
  // head histories are tens of entries — one call. Very long histories still batch.
  batchSize = 200,
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
    const prompt = `Delegated task: ${topic}\n\nConversation messages:\n${numbered}`

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
          costUsd: estimateCost(response.model, response.inputTokens, response.outputTokens),
        })
      }

      const parsed = parseComposerArray(response.content)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.id === 'string' && typeof item.action === 'string') {
            const quotes = Array.isArray(item.quotes)
              ? item.quotes.filter((q: unknown): q is string => typeof q === 'string')
              : undefined
            allClassifications.push({
              id: item.id,
              action: (item.action === 'drop' || item.action === 'extract') ? item.action : 'keep',
              reason: item.reason ?? '',
              ...(item.action === 'extract' ? { quotes: quotes ?? [] } : {}),
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

  const keepWhole = (entry: ClassifierEntry) => {
    for (const idx of entry.originalIndices) relevantIndices.add(idx)
  }

  for (const entry of entries) {
    const c = classMap.get(entry.id)
    // Missing classification or keep → include the whole entry verbatim (fail open).
    if (!c || c.action === 'keep') {
      keepWhole(entry)
      continue
    }
    if (c.action === 'extract') {
      const quotes = (c.quotes ?? []).map(q => q.trim()).filter(Boolean)
      // Model said extract but gave nothing usable → fail open to keep-whole rather
      // than silently dropping content (P1: never drop a relevant span).
      if (quotes.length === 0) { keepWhole(entry); continue }

      // Verification ladder against the EXACT source the model quoted from (entry.summary):
      //   tier-1 exact substring  →  tier-2 whitespace-snap to a real source substring
      //   →  tier-3 fail-safe: keep the WHOLE entry (never trust the model's bytes, never drop).
      const verified: string[] = []
      let failsafe = false
      for (const q of quotes) {
        const span = snapQuote(q, entry.summary)
        if (span) verified.push(span)
        else { failsafe = true; break }
      }
      if (failsafe || verified.length === 0) {
        // tier-3: a quote couldn't be located even up-to-whitespace — keep whole.
        keepWhole(entry)
      } else {
        // Tool pairs collapse to a single replaced message at the first index.
        const firstIdx = entry.originalIndices[0]!
        relevantIndices.add(firstIdx)
        replacements.set(firstIdx, verified.join(' … '))
      }
      continue
    }
    // DROP: skip entirely
  }

  return { relevantIndices, replacements, classifications: allClassifications }
}

/**
 * Locate a model-emitted quote as a VERBATIM span of the source, tolerating only
 * whitespace reflow. Returns the exact source substring (never the model's bytes)
 * or null if it can't be located up-to-whitespace.
 *   tier-1: exact `includes` → return the quote as-is (it IS a source substring).
 *   tier-2: build a regex from the quote with `\s+` for whitespace runs and match it
 *           against the source → return the matched source substring.
 * Port of snapQuote() from the context-passthrough research harness (M1b/M1c).
 */
export function snapQuote(quote: string, source: string): string | null {
  if (source.includes(quote)) return quote
  const esc = quote.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  try {
    const m = source.match(new RegExp(esc))
    if (m) return m[0]
  } catch { /* malformed regex — fall through to null (caller keeps whole) */ }
  return null
}
