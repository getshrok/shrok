import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { connectSSE } from '../lib/sse'
import { shortAgentId } from '../lib/agentId'
import type { DashboardEvent, Message, StewardRun } from '../types/api'

export function useStream() {
  const qc = useQueryClient()
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const disconnect = connectSSE((event: DashboardEvent) => {
      if (event.type === 'message_added') {
        // Clear typing indicator when a message arrives
        qc.setQueryData(['typing'], false)
        if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null }
        qc.setQueryData(
          ['messages'],
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
        const { agentId, message, trigger } = event.payload as { agentId: string; message: Message; trigger?: string }
        qc.setQueryData(
          ['agent-history', agentId],
          (old: { history: Message[]; status: string; task: string } | undefined) => {
            if (!old) return old
            return { ...old, history: [...old.history, message] }
          },
        )
        // Only accumulate head-spawned agent tool calls/results for xray timeline
        // (skip text messages — agent thinking/responses are noise, head relays the result)
        if ((!trigger || trigger === 'manual') && (message.kind === 'tool_call' || message.kind === 'tool_result')) {
          const shortId = shortAgentId(agentId)
          qc.setQueryData(
            ['xray-messages'],
            (old: Array<{ agentId: string; message: Message }> | undefined) =>
              [...(old ?? []), { agentId: shortId, message }],
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
        void qc.invalidateQueries({ queryKey: ['thresholds'] })
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
        const { text, eventId, tokens } = event.payload as { text: string; eventId?: string; tokens: number }
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
