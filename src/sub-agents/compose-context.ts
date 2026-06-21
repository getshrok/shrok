import { classifyAndCompose } from '../head/classifier.js'
import { adjustToolMessages, buildContextSnapshot } from './context.js'
import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'

/**
 * Verbatim context pass-through (issue #45). Given the real conversation history
 * the server holds and an intent `signal`, select the turns relevant to a delegated
 * task — VERBATIM — using the M1c composer (`classifyAndCompose` + `snapQuote`). The
 * head never transcribes; this is what makes the sub-agent act on the user's actual
 * words instead of the head's paraphrase.
 *
 * Shared by both delegation paths:
 *   - spawn_agent (runner) consumes `messages` (prepends them to the agent history)
 *   - message_agent (head dispatch) consumes `text` (wraps it as one delivered turn)
 */
export interface ComposedContext {
  /** Kept / EXTRACT-replaced messages, chronological — ready to PREPEND to an agent history. */
  messages: Message[]
  /** The same content rendered as a single string — ready to DELIVER as one turn. */
  text: string
  /** True if the composer produced nothing (all-dropped or empty input) — caller decides fallback. */
  empty: boolean
}

export async function composeVerbatimContext(
  history: Message[],
  signal: string,
  router: LLMRouter,
  model: string,
  usageStore: UsageStore | undefined,
  knownTools: Set<string>,
  snapshotBudget: number,
): Promise<ComposedContext> {
  // Strip injected user-role text messages (steward nudges, system triggers) — they
  // are not part of the user's actual conversation.
  const filtered = history.filter(
    m => !(m.kind === 'text' && (m as TextMessage).role === 'user' && m.injected),
  )
  const adjusted = adjustToolMessages(filtered, knownTools)
  const snapshot = buildContextSnapshot(adjusted, undefined, snapshotBudget)

  const { relevantIndices, replacements } = await classifyAndCompose(
    signal, snapshot, router, model, usageStore,
  )

  // Three-way stitch: KEEP → original message; DROP → omitted; EXTRACT → the verified
  // verbatim spans (already snapped to source substrings in classifyAndCompose).
  const messages: Message[] = []
  for (let i = 0; i < snapshot.length; i++) {
    if (!relevantIndices.has(i)) continue
    const msg = snapshot[i]!
    const replacement = replacements.get(i)
    if (replacement) {
      // EXTRACT'd message: replace content, preserve originating role.
      // Tool pairs collapse to role: 'assistant'.
      const role = msg.kind === 'text' ? (msg as TextMessage).role : 'assistant'
      messages.push({
        kind: 'text',
        id: msg.id,
        role,
        content: replacement,
        createdAt: msg.createdAt,
      })
    } else {
      messages.push(msg)
    }
  }

  return { messages, text: renderSnapshotText(messages), empty: messages.length === 0 }
}

/** Render composed messages as a single `[role] content` block for one-turn delivery.
 *  message_agent passes an empty knownTools set, so all tool pairs are already text by
 *  the time we get here; the tool_call branch is defensive (it only occurs on the spawn
 *  path, which consumes `messages`, not `text`). */
function renderSnapshotText(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.kind === 'text') {
      lines.push(`[${(m as TextMessage).role}] ${(m as TextMessage).content}`)
    } else if (m.kind === 'tool_call' && m.content) {
      lines.push(`[assistant] ${m.content}`)
    }
  }
  return lines.join('\n\n')
}
