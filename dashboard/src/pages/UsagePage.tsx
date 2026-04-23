import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import type { UsagePeriodSummary, UsageTrendDay, UsageThreshold, ThresholdWithSpend, ThresholdAction } from '../types/api'

type Period = 'today' | 'week' | 'month' | 'allTime'

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: '7 days',
  month: '30 days',
  allTime: 'All time',
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-5 py-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-xl font-semibold text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function TrendChart({ trend }: { trend: UsageTrendDay[] }) {
  if (trend.length === 0) return <div className="text-xs text-zinc-500 py-4">No data</div>

  const maxCost = Math.max(...trend.map(d => d.costUsd), 0.0001)

  return (
    <div className="flex items-end gap-1 h-20">
      {trend.map(d => {
        const pct = (d.costUsd / maxCost) * 100
        const label = d.day.slice(5) // MM-DD
        const allFree = d.costUsd === 0
        return (
          <div key={d.day} className="flex-1 h-full flex flex-col items-center gap-1 group relative">
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center z-10">
              <div className="bg-zinc-700 text-zinc-100 text-xs px-2 py-1 rounded whitespace-nowrap shadow">
                {d.day}<br />
                ${d.costUsd.toFixed(4)}<br />
                {formatTokens(d.inputTokens + d.outputTokens)} tok
              </div>
            </div>
            <div className="flex-1 w-full flex items-end">
              <div
                className={`w-full rounded-sm ${allFree ? 'bg-zinc-700' : 'bg-indigo-500/70'}`}
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
            <div className="text-zinc-700 text-[9px] leading-none">{label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Spending thresholds ─────────────────────────────────────────────────────

const PERIOD_LABEL_THRESHOLD: Record<UsageThreshold['period'], string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
}

function ThresholdsSection() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['thresholds'],
    queryFn: api.thresholds.list,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.thresholds.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['thresholds'] }),
  })

  const thresholds = data?.thresholds ?? []
  const editing = thresholds.find(t => t.id === editingId) ?? null

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Spending thresholds</div>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300"
          >
            + Add
          </button>
        )}
      </div>

      {isLoading && <div className="text-zinc-500 text-sm">Loading…</div>}
      {error && <div className="text-red-400 text-sm">Failed to load thresholds.</div>}
      {!isLoading && thresholds.length === 0 && !showAdd && (
        <div className="text-zinc-500 text-sm italic">No thresholds configured.</div>
      )}

      <div className="space-y-2">
        {thresholds.map(t => (
          <ThresholdRow
            key={t.id}
            threshold={t}
            onEdit={() => setEditingId(t.id)}
            onDelete={() => {
              if (window.confirm(`Delete this ${PERIOD_LABEL_THRESHOLD[t.period].toLowerCase()} $${t.amountUsd.toFixed(2)} threshold?`)) {
                deleteMutation.mutate(t.id)
              }
            }}
          />
        ))}
      </div>

      {showAdd && <ThresholdForm mode="create" onClose={() => setShowAdd(false)} />}
      {editing && <ThresholdForm mode="edit" threshold={editing} onClose={() => setEditingId(null)} />}
    </div>
  )
}

function ThresholdRow({ threshold, onEdit, onDelete }: {
  threshold: ThresholdWithSpend
  onEdit: () => void
  onDelete: () => void
}) {
  const pct = Math.min(100, Math.round((threshold.currentSpend / threshold.amountUsd) * 100))
  const overBudget = threshold.currentSpend >= threshold.amountUsd

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded">
      <span className="text-xs font-mono text-zinc-500 uppercase w-16 shrink-0">{PERIOD_LABEL_THRESHOLD[threshold.period]}</span>
      {threshold.action === 'block' && (
        <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded uppercase font-medium shrink-0">block</span>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-500">
          <span className={overBudget ? 'text-amber-400 font-medium' : 'text-zinc-300'}>
            ${threshold.currentSpend.toFixed(2)}
          </span>
          {' of '}
          ${threshold.amountUsd.toFixed(2)}
          <span className="ml-2 text-zinc-600">({pct}%)</span>
        </div>
      </div>
      <button onClick={onEdit} className="text-xs text-zinc-500 hover:text-zinc-300 px-2">edit</button>
      <button onClick={onDelete} className="text-xs text-zinc-500 hover:text-red-400 px-2">delete</button>
    </div>
  )
}

function ThresholdForm({ mode, threshold, onClose }: {
  mode: 'create' | 'edit'
  threshold?: UsageThreshold
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [period, setPeriod] = useState<UsageThreshold['period']>(threshold?.period ?? 'day')
  const [amount, setAmount] = useState(threshold?.amountUsd?.toString() ?? '5')
  const [action, setAction] = useState<ThresholdAction>(threshold?.action ?? 'alert')
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: api.thresholds.create,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['thresholds'] }); onClose() },
    onError: (err: Error) => setError(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.thresholds.update>[1] }) =>
      api.thresholds.update(id, patch),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['thresholds'] }); onClose() },
    onError: (err: Error) => setError(err.message),
  })

  const submit = () => {
    setError(null)
    const amountUsd = Number(amount)
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) { setError('Amount must be a positive number'); return }

    if (mode === 'create') {
      createMutation.mutate({ period, amountUsd, action })
    } else if (threshold) {
      updateMutation.mutate({ id: threshold.id, patch: { period, amountUsd, action } })
    }
  }

  const inputClass = 'w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600'
  const selectClass = 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100'
  const isPending = createMutation.isPending || updateMutation.isPending

  return createPortal(
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-96 space-y-4">
        <div className="text-sm font-medium text-zinc-200">{mode === 'create' ? 'New threshold' : 'Edit threshold'}</div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1">Period</label>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as UsageThreshold['period'])}
            className={selectClass}
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1">Action</label>
          <select
            value={action}
            onChange={e => setAction(e.target.value as ThresholdAction)}
            className={selectClass}
          >
            <option value="alert">Notify me (alert)</option>
            <option value="block">Block usage when reached</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-zinc-500 block mb-1">Amount (USD)</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className={inputClass}
          />
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
          <button
            onClick={submit}
            disabled={isPending}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const PERIOD_STORAGE_KEY = 'shrok.usage.period'

function loadSavedPeriod(): Period {
  try {
    const saved = localStorage.getItem(PERIOD_STORAGE_KEY)
    if (saved && saved in PERIOD_LABELS) return saved as Period
  } catch { /* localStorage unavailable */ }
  return 'month'
}

export default function UsagePage() {
  const [period, setPeriod] = useState<Period>(loadSavedPeriod)

  useEffect(() => {
    try { localStorage.setItem(PERIOD_STORAGE_KEY, period) } catch { /* ignore */ }
  }, [period])
  const showDetails = true  // all usage detail visible in both modes

  const { data, isLoading } = useQuery({
    queryKey: ['usage'],
    queryFn: api.usage.get,
  })

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-zinc-500">
        Loading…
      </div>
    )
  }

  const summary: UsagePeriodSummary = data.periods[period]
  const totalTokens = summary.inputTokens + summary.outputTokens
  const periodLabel = PERIOD_LABELS[period]
  const cacheHitPct = summary.cache && summary.cache.totalInputTokens > 0
    ? (summary.cache.readTokens / summary.cache.totalInputTokens * 100).toFixed(0)
    : null

  const modelEntries = Object.entries(summary.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)
  const maxModelCost = Math.max(...modelEntries.map(([, v]) => v.costUsd), 0.0001)
  // Server-sorted (desc) — do not re-sort on client.
  const bySource = summary.bySource
  const maxSourceCost = Math.max(...bySource.map(r => r.costUsd), 0.0001)

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">

        {/* Period tabs */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100">Usage</h1>
          <div className="flex gap-1 bg-zinc-800 rounded-lg p-1">
            {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  period === p
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Stat cards */}
        <div className={`grid gap-3 ${showDetails ? 'grid-cols-2' : 'grid-cols-1 max-w-xs'}`}>
          <StatCard label="Cost" value={`$${summary.costUsd.toFixed(4)}`} />
          {showDetails && (
            <StatCard
              label="Tokens"
              value={formatTokens(totalTokens)}
              sub={`${formatTokens(summary.inputTokens)} in / ${formatTokens(summary.outputTokens)} out`}
            />
          )}
          {showDetails && cacheHitPct !== null && Number(cacheHitPct) > 0 && (
            <StatCard
              label="Cache Hit Rate"
              value={`${cacheHitPct}%`}
              sub={`${formatTokens(summary.cache!.readTokens)} cached reads`}
            />
          )}
        </div>

        {/* Trend chart — bars for the selected period */}
        <div>
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-3">Daily spend · {periodLabel}</div>
          <TrendChart trend={summary.trend} />
        </div>

        {/* By model */}
        {showDetails && modelEntries.length > 0 && (
          <div>
            <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-3">By model · {periodLabel}</div>
            <div className="space-y-2">
              {modelEntries.map(([model, m]) => (
                <div key={model}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-zinc-300 font-mono">{model}</span>
                    <span className="text-zinc-500">${m.costUsd.toFixed(4)} · {formatTokens(m.inputTokens)} in / {formatTokens(m.outputTokens)} out</span>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500/60 rounded-full"
                      style={{ width: `${(m.costUsd / maxModelCost) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* By source · 30 days — ranked list with kind pills on scheduled rows */}
        {showDetails && bySource.length > 0 && (
          <div>
            <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-3">By source · {periodLabel}</div>
            <div className="space-y-2">
              {bySource.map(row => {
                const label =
                  row.bucket === 'head' ? 'Head'
                  : row.bucket === 'curator' ? 'Curator'
                  : row.bucket === 'archival' ? 'Archival'
                  : row.bucket === 'steward' ? 'Stewards'
                  : row.bucket === 'memory' ? 'Memory'
                  : row.bucket === 'manual_agents' ? 'Manual agents'
                  : row.name
                const hasCost = row.costUsd > 0
                return (
                  <div key={`${row.bucket}:${row.name}`}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="flex items-center min-w-0">
                        {row.kind && (
                          <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 mr-2 ${
                            row.kind === 'task'
                              ? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                              : 'bg-zinc-700 text-zinc-300'
                          }`}>{row.kind}</span>
                        )}
                        <span className="text-zinc-300 truncate">{label}</span>
                        {row.bucket === 'scheduled_agent' && (
                          <span className="text-[10px] text-zinc-500 uppercase tracking-wide ml-2">scheduled</span>
                        )}
                      </span>
                      <span className="text-zinc-500 shrink-0 ml-2">
                        {row.maxPerMonthUsd != null
                          ? <><span className={row.costUsd >= row.maxPerMonthUsd ? 'text-amber-400 font-medium' : ''}>${row.costUsd.toFixed(2)}</span>{` / $${row.maxPerMonthUsd.toFixed(2)}`}</>
                          : `$${row.costUsd.toFixed(4)}`
                        }
                        {' · '}{formatTokens(row.inputTokens + row.outputTokens)} tok
                      </span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          row.maxPerMonthUsd != null && row.costUsd >= row.maxPerMonthUsd
                            ? 'bg-amber-500/70'
                            : hasCost ? 'bg-indigo-500/60' : 'bg-zinc-700'
                        }`}
                        style={{
                          width: row.maxPerMonthUsd != null
                            ? `${Math.min(100, (row.costUsd / row.maxPerMonthUsd) * 100)}%`
                            : `${(row.costUsd / maxSourceCost) * 100}%`
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Spending thresholds — always visible (not gated on showDetails). */}
        <ThresholdsSection />

      </div>
    </div>
  )
}
