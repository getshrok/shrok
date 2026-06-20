import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '../../lib/api'
import { SettingTooltip } from './components'

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

type Segment = { key: string; label: string; tokens: number; color: string }

/**
 * Live, global breakdown of how the head's context window is allocated, shown in
 * Settings → Behavior. The measured system-prompt sizes come from
 * /api/context-window (fetched once — they don't change mid-session); the
 * memory/history/output split is recomputed here from the live draft values so
 * the bar reflows as the sliders move.
 */
export default function ContextWindowBar({
  contextWindowTokens,
  llmMaxTokens,
  memoryBudgetPercent,
}: {
  contextWindowTokens: number
  llmMaxTokens: number
  memoryBudgetPercent: number
}) {
  const q = useQuery({ queryKey: ['context-window'], queryFn: api.contextWindow.get, staleTime: Infinity })

  if (q.isLoading || !q.data) {
    return (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
        <div className="text-sm font-semibold text-zinc-300">Context window</div>
        <div className="mt-2 text-xs text-zinc-500">{q.isError ? 'Could not measure context window.' : 'Measuring…'}</div>
      </div>
    )
  }

  const { identityTokens, baseSystemTokens, identityFiles } = q.data

  // Split math mirrors src/head/assembler.ts:161-166 (the head's own budgeting).
  const outputReserve = llmMaxTokens
  const remaining = Math.max(0, contextWindowTokens - baseSystemTokens - outputReserve)
  const memoryBudget = Math.floor(remaining * (memoryBudgetPercent / 100))
  const historyBudget = remaining - memoryBudget
  const identity = identityTokens
  const otherSystem = Math.max(0, baseSystemTokens - identityTokens)

  const overflow = baseSystemTokens + outputReserve >= contextWindowTokens
  // Denominator fills the bar to 100%: the window normally, or the overflowed
  // total when the fixed parts already exceed the ceiling.
  const denom = Math.max(contextWindowTokens, baseSystemTokens + outputReserve)

  const segments: Segment[] = [
    { key: 'identity', label: 'Identity', tokens: identity, color: '#6366f1' },      // indigo-500
    { key: 'system', label: 'Other system', tokens: otherSystem, color: '#0ea5e9' }, // sky-500
    { key: 'memory', label: 'Memory', tokens: memoryBudget, color: '#a855f7' },      // purple-500
    { key: 'history', label: 'History', tokens: historyBudget, color: '#10b981' },   // emerald-500
    { key: 'output', label: 'Output reserve', tokens: outputReserve, color: '#71717a' }, // zinc-500
  ]

  const identityTitle = identityFiles.length
    ? identityFiles.map(f => `${f.name} — ${fmt(f.tokens)}`).join('\n')
    : undefined

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center text-sm font-semibold text-zinc-300">
          Context window
          <SettingTooltip text="How a head's per-turn context window is allocated. The system prompt (identity files + capabilities + skills + environment) is measured live; the remaining room is split between memory and history by the balance below, with an output reserve held back for the reply. Token counts are approximate (cl100k_base). Adjust the controls below to watch the allocation change." />
        </div>
        <div className="text-[11px] text-zinc-500">{fmt(contextWindowTokens)} tok · approx</div>
      </div>

      {/* Segmented bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        {segments.map(s => s.tokens > 0 && (
          <div
            key={s.key}
            title={`${s.label} — ${fmt(s.tokens)} tok`}
            style={{ width: `${(s.tokens / denom) * 100}%`, backgroundColor: s.color }}
            className="h-full first:rounded-l-full last:rounded-r-full"
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map(s => (
          <div
            key={s.key}
            title={s.key === 'identity' ? identityTitle : undefined}
            className="flex items-center gap-1.5 text-[11px] text-zinc-400"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-zinc-300">{s.label}</span>
            <span className="text-zinc-500">{fmt(s.tokens)}</span>
          </div>
        ))}
      </div>

      {overflow && (
        <div className="flex items-start gap-2 text-[11px] text-amber-400">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span>
            The system prompt ({fmt(baseSystemTokens)}) plus the output reserve ({fmt(outputReserve)}) exceed the
            context-window ceiling ({fmt(contextWindowTokens)}) — no room is left for memory or history. Raise the
            ceiling, lower the output reserve, or trim the identity files.
          </span>
        </div>
      )}
    </div>
  )
}
