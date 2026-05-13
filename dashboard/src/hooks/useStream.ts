import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { connectSSE } from '../lib/sse'
import { shouldDeliverStreamEvent } from './streamFilter'
import type { DashboardEvent, Message, StewardRun } from '../types/api'

/**
 * Subscribe to the dashboard SSE stream and route events into React Query caches.
 *
 * Phase 32 (D-06): `currentHeadId` is captured in a ref so we can route incoming
 * `message_added` events to the correct head-scoped cache key (`['messages', headId]`)
 * WITHOUT tearing down and re-establishing the EventSource every time the user
 * switches heads. The ref is updated on every render via a tracking useEffect.
 */
export function useStream(currentHeadId: string) {
  const qc = useQueryClient()
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentHeadIdRef = useRef<string>(currentHeadId)
  // Phase 33 (WR-03): debounce ['thresholds'] invalidation on usage_updated.
  // Every LLM call emits usage_updated; without throttling, a busy session
  // would refetch the threshold list (which walks usage rows in getCostSince)
  // dozens of times per minute. 5s window keeps the UI responsive while
  // avoiding redundant SQLite aggregator hits.
  const lastThreshInvalidateRef = useRef<number>(0)

  // Keep the ref in sync with the latest prop on every render.
  // The SSE callback below closes over this ref, so reads are always current.
  useEffect(() => {
    currentHeadIdRef.current = currentHeadId
  }, [currentHeadId])

  useEffect(() => {
    const disconnect = connectSSE((event: DashboardEvent) => {
      // Phase 33 D-11 (RESEARCH § A4 minimum-correct scope): drop
      // message_added / typing events destined for a different head.
      // Every other event type is delivered as-is.
      if (!shouldDeliverStreamEvent(event, currentHeadIdRef.current)) return

      if (event.type === 'message_added') {
        // Clear typing indicator when a message arrives
        qc.setQueryData(['typing'], false)
        if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null }
        // Phase 33 (D-11): SSE payload now carries headId; route to its
        // head-scoped cache entry. The filter above guarantees
        // event.headId === currentHeadIdRef.current here, so we use the
        // event's own headId rather than re-reading the ref.
        const headId = event.headId
        qc.setQueryData(
          ['messages', headId],
          (old: { messages: Message[] } | undefined) => ({
            messages: [...(old?.messages ?? []), event.payload],
          }),
        )
        void qc.invalidateQueries({ queryKey: ['activity'] })
      }
      if (event.type === 'agent_status_changed') {
        void qc.invalidateQueries({ queryKey: ['agents'] })
        void qc.invalidateQueries({ queryKey: ['activity'] })
      }
      if (event.type === 'agent_message_added') {
        const { agentId, message, trigger } = event.payload
        qc.setQueryData(
          ['agent-history', agentId],
          (old: { history: Message[]; status: string; task: string } | undefined) => {
            if (!old) return old
            return { ...old, history: [...old.history, message] }
          },
        )
        // Only accumulate head-spawned agent tool calls/results for xray timeline
        // (skip text messages — agent thinking/responses are noise, head relays the result)
        if (trigger === 'manual' && (message.kind === 'tool_call' || message.kind === 'tool_result')) {
          qc.setQueryData(
            ['xray-messages'],
            (old: Array<{ agentId: string; message: Message }> | undefined) =>
              [...(old ?? []), { agentId, message }],
          )
        }
      }
      if (event.type === 'steward_run_added') {
        qc.setQueryData(
          ['stewardRuns'],
          (old: { stewardRuns: StewardRun[] } | undefined) => ({
            stewardRuns: [...(old?.stewardRuns ?? []), event.payload],
          }),
        )
        void qc.invalidateQueries({ queryKey: ['activity'] })
      }
      if (event.type === 'usage_updated') {
        void qc.invalidateQueries({ queryKey: ['usage'] })
        void qc.invalidateQueries({ queryKey: ['status'] })
        // Threshold rows show currentSpend per period, which is a function of
        // usage. Every LLM call advances spend, so refresh the list whenever
        // usage updates — not just on add/edit/delete (thresholds_changed).
        // Phase 33 (WR-03): debounce to at most once per 5s. ['thresholds']
        // requires walking usage rows in getCostSince, which can be expensive
        // under sustained LLM call rates. ['usage']/['status'] are O(1) and
        // remain unthrottled. thresholds_changed (add/edit/delete) bypasses
        // this debounce so user-initiated changes are still immediate.
        const now = Date.now()
        if (now - lastThreshInvalidateRef.current > 5_000) {
          lastThreshInvalidateRef.current = now
          void qc.invalidateQueries({ queryKey: ['thresholds'] })
        }
      }
      if (event.type === 'assistant_name_changed') {
        qc.setQueryData(['settings'], (old: Record<string, unknown> | undefined) =>
          old ? { ...old, assistantName: event.payload.name } : old
        )
      }
      if (event.type === 'theme_changed') {
        qc.setQueryData(['settings'], (old: Record<string, unknown> | undefined) =>
          old ? { ...old, accentColor: event.payload.accentColor, logoPath: event.payload.logoUrl } : old
        )
      }
      if (event.type === 'thresholds_changed') {
        void qc.invalidateQueries({ queryKey: ['thresholds'] })
      }
      if (event.type === 'memory_retrieval') {
        const { text, eventId, tokens } = event.payload
        qc.setQueryData(
          ['memory-retrievals'],
          (old: Array<{ text: string; eventId?: string; tokens: number }> | undefined) =>
            [...(old ?? []), { text, eventId, tokens }],
        )
      }
      if (event.type === 'typing') {
        qc.setQueryData(['typing'], true)
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = setTimeout(() => { qc.setQueryData(['typing'], false); typingTimeoutRef.current = null }, 10_000)
      }
    })

    return disconnect
  }, [qc])
}
