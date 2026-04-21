import type { Message } from '../types/core.js'
import { priorTool, priorResult, _descriptionForMarker } from '../markers.js'
import { estimateTokens } from '../db/token.js'

/**
 * Adjust tool_call/tool_result pairs in a message list based on what tools the
 * receiving model actually has.
 *
 * - If every tool in a call is in `knownTools` → keep the pair as proper tool
 *   messages (the model understands them natively).
 * - If any tool is unknown → convert the pair to plain text so the model gets
 *   the context without being taught that those tools are callable.
 *
 * Pairs are processed together to keep the call/result structure consistent.
 * Orphaned tool_result messages (no preceding call) are always converted.
 */
export function adjustToolMessages(messages: Message[], knownTools: Set<string>): Message[] {
  const out: Message[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (msg.kind === 'tool_call') {
      const allKnown = msg.toolCalls.every(tc => knownTools.has(tc.name))
      const next = messages[i + 1]
      const pairedResult = next?.kind === 'tool_result' ? next : null
      if (allKnown) {
        out.push(msg)
        if (pairedResult) { out.push(pairedResult); i++ }
      } else {
        // Merge call + result into a single assistant message using a clearly
        // historical/passive format so the model doesn't imitate it as an action.
        const parts: string[] = []
        if (msg.content) parts.push(msg.content)
        if (pairedResult) {
          for (const tc of msg.toolCalls) {
            const result = pairedResult.toolResults.find(tr => tr.toolCallId === tc.id)
            const intent = _descriptionForMarker(tc.input)
            parts.push(result
              ? priorTool({
                  name: tc.name,
                  input: JSON.stringify(tc.input),
                  ...(intent !== null ? { intent } : {}),
                  result: result.content,
                })
              : priorTool({
                  name: tc.name,
                  input: JSON.stringify(tc.input),
                  ...(intent !== null ? { intent } : {}),
                }))
          }
          i++
        } else {
          for (const tc of msg.toolCalls) {
            const intent = _descriptionForMarker(tc.input)
            parts.push(priorTool({
              name: tc.name,
              input: JSON.stringify(tc.input),
              ...(intent !== null ? { intent } : {}),
            }))
          }
        }
        out.push({ kind: 'text', role: 'assistant', id: msg.id, content: parts.join('\n'), createdAt: msg.createdAt })
      }
    } else if (msg.kind === 'tool_result') {
      const parts = msg.toolResults.map(tr => priorResult(tr.name, tr.content))
      out.push({ kind: 'text', role: 'assistant', id: msg.id, content: parts.join('\n'), createdAt: msg.createdAt })
    } else {
      out.push(msg)
    }
    i++
  }
  return out
}

export function buildContextSnapshot(
  headHistory: Message[],
  triggeringMessage: Message | undefined,
  tokenBudget: number,
): Message[] {
  const eligible = headHistory.filter(m => m.id !== triggeringMessage?.id)

  const reservedForTrigger = triggeringMessage ? estimateTokens([triggeringMessage]) : 0
  const pairBudget = tokenBudget - reservedForTrigger
  let used = 0
  const included: Message[] = []

  for (let i = eligible.length - 1; i >= 0; i--) {
    const cost = estimateTokens([eligible[i]!])
    if (used + cost > pairBudget) break
    included.unshift(eligible[i]!)
    used += cost
  }

  if (triggeringMessage) included.unshift(triggeringMessage)
  return included
}
