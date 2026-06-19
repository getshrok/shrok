import cronstrue from 'cronstrue'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import type { Schedule } from '../types/api'
import { formatInTz, useConfigTimezone, toDatetimeLocalInTz, datetimeLocalToUtc } from '../lib/formatTime'
import CronPicker from '../components/CronPicker'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatCron(cron: string): string {
  try {
    return cronstrue.toString(cron)
  } catch {
    return cron
  }
}

// ─── Head color palette (Phase 35 D-15) ───────────────────────────────────────
//
// Hex+alpha codes follow Phase 33 D-VENDOR-INLINE-STYLE precedent — Tailwind
// purge does not keep arbitrary `bg-[#hex]/5` classes unless they're in the
// safelist, so we expose inline `style` objects using hex-with-alpha codes
// (`#5865F20d` ≈ 5% alpha) so Tailwind never sees these strings.
//
// Each head id hashes deterministically to one of these palette entries so the
// same head always gets the same color band across page reloads. Palette
// colors are lifted from the vendor brand colors (Discord, Telegram, Slack,
// WhatsApp, Zoho) but the mapping is by hash, not by vendor.
const HEAD_COLORS: Array<{ bg: string; border: string }> = [
  { bg: '#5865F20d', border: '#5865F2' },  // discord-blue alpha
  { bg: '#26A5E40d', border: '#26A5E4' },  // telegram-blue alpha
  { bg: '#4A154B0d', border: '#4A154B' },  // slack-purple alpha
  { bg: '#25D3660d', border: '#25D366' },  // whatsapp-green alpha
  { bg: '#E423180d', border: '#E42318' },  // zoho-red alpha
]

function hashHeadId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

function headColor(id: string): string {
  return HEAD_COLORS[hashHeadId(id) % HEAD_COLORS.length]!.bg
}

function headColorBorder(id: string): string {
  return HEAD_COLORS[hashHeadId(id) % HEAD_COLORS.length]!.border
}

// ─── Currently-active head (D-14 seed source) ─────────────────────────────────
//
// ConversationsPage stores the active head id under the 'active-head'
// localStorage key (Phase 32 DASH-01 / D-04). No shared hook exists yet — the
// SchedulesPage forms read this key directly so the head picker pre-selects
// whatever the user is currently looking at on the Conversations page. Falls
// back to heads[0].id if the stored id is no longer in the resolved heads
// list (mirror Phase 32 D-04's stale-id fallback).
function readActiveHeadFromStorage(): string | null {
  try {
    return localStorage.getItem('active-head')
  } catch {
    return null
  }
}

function formatRelTime(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  const past = diff < 0
  if (abs < 60_000) return past ? 'just now' : 'in <1 min'
  const mins = Math.round(abs / 60_000)
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return past ? `${days}d ago` : `in ${days}d`
}

function formatNagInterval(minutes: number | null): string {
  if (!minutes) return '?'
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  return parts.join(' ') || '?'
}

// ─── Row ───────────────────────────────────────────────────────────────────────

function ScheduleRow({ schedule, tz }: { schedule: Schedule; tz: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [editConditions, setEditConditions] = useState('')
  const [editAgentContext, setEditAgentContext] = useState('')
  const [editRelayGuidance, setEditRelayGuidance] = useState('')
  const [editDeliverToHeadIds, setEditDeliverToHeadIds] = useState<string[]>([])

  const headsQuery = useQuery({
    queryKey: ['heads'],
    queryFn: api.heads.list,
  })

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.schedules.delete(schedule.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const updateMutation = useMutation({
    mutationFn: (update: { cron?: string; runAt?: string; conditions?: string; agentContext?: string; relayGuidance?: string; deliverToHeadIds?: string[] }) => api.schedules.update(schedule.id, update),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
  })

  function startEdit() {
    setEditValue(schedule.cron !== null ? schedule.cron : (schedule.runAt ? toDatetimeLocalInTz(schedule.runAt, tz) : ''))
    setEditConditions(schedule.conditions ?? '')
    setEditAgentContext(schedule.agentContext ?? '')
    setEditRelayGuidance(schedule.relayGuidance ?? '')
    setEditDeliverToHeadIds(schedule.deliverToHeadIds ?? [])
    setEditing(true)
  }

  function commitEdit() {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditing(false); return }
    const conditionsUnchanged = editConditions === (schedule.conditions ?? '')
    const agentContextUnchanged = editAgentContext === (schedule.agentContext ?? '')
    const relayGuidanceUnchanged = editRelayGuidance === (schedule.relayGuidance ?? '')
    // A delivery-set-only edit must still PATCH — otherwise the modal closes and the
    // change is silently lost (#CR-02; ReminderRow guards the same way for ack/nag).
    const deliverUnchanged =
      JSON.stringify([...editDeliverToHeadIds].sort()) ===
      JSON.stringify([...(schedule.deliverToHeadIds ?? [])].sort())
    if (schedule.cron !== null) {
      if (trimmed === schedule.cron && conditionsUnchanged && agentContextUnchanged && relayGuidanceUnchanged && deliverUnchanged) { setEditing(false); return }
      updateMutation.mutate({ cron: trimmed, conditions: editConditions, agentContext: editAgentContext, relayGuidance: editRelayGuidance, deliverToHeadIds: editDeliverToHeadIds })
      return
    }
    const runAtUtc = datetimeLocalToUtc(trimmed, tz)
    if (!runAtUtc) return
    const runAtUnchanged = runAtUtc === schedule.runAt
    if (runAtUnchanged && conditionsUnchanged && agentContextUnchanged && relayGuidanceUnchanged && deliverUnchanged) { setEditing(false); return }
    updateMutation.mutate({ runAt: runAtUtc, conditions: editConditions, agentContext: editAgentContext, relayGuidance: editRelayGuidance, deliverToHeadIds: editDeliverToHeadIds })
  }

  const scheduleLabel = schedule.cron
    ? formatCron(schedule.cron)
    : schedule.runAt
      ? `Once at ${formatInTz(schedule.runAt, tz, { style: 'full' })}`
      : '—'

  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100 truncate">
          {schedule.taskName ?? '—'}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">{scheduleLabel}</div>
        {schedule.conditions && (
          <div className="text-xs text-zinc-600 mt-0.5 truncate">if: {schedule.conditions}</div>
        )}
      </div>
      <div className="min-w-24 shrink-0 text-xs flex flex-wrap gap-1">
        {[schedule.headId, ...(schedule.deliverToHeadIds ?? [])].filter((v, i, a) => a.indexOf(v) === i).map(hid => (
          <span key={hid}
            className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-full"
            style={{ backgroundColor: headColor(hid), borderLeft: `2px solid ${headColorBorder(hid)}` }}
            title={`Head: ${hid}`}
          >
            {hid}
          </span>
        ))}
      </div>
      <div className="text-right text-xs text-zinc-500 w-28 shrink-0">
        <div>Next: <span className="text-zinc-400">{formatRelTime(schedule.nextRun)}</span></div>
        <div>Last: <span className="text-zinc-400">{formatRelTime(schedule.lastRun)}</span></div>
      </div>
      <button
        onClick={() => toggleMutation.mutate(!schedule.enabled)}
        disabled={toggleMutation.isPending}
        title={schedule.enabled ? 'Disable' : 'Enable'}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          schedule.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
        } disabled:opacity-50`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          schedule.enabled ? 'translate-x-[18px]' : 'translate-x-0'
        }`} />
      </button>
      <button
        onClick={startEdit}
        title="Edit schedule"
        className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
      >
        <Pencil size={13} />
      </button>
      <button
        onClick={() => { if (window.confirm(`Delete schedule "${schedule.taskName ?? schedule.id}"?`)) deleteMutation.mutate() }}
        disabled={deleteMutation.isPending}
        title="Delete"
        className="text-zinc-500 hover:text-red-400 transition-colors shrink-0 disabled:opacity-50"
      >
        <Trash2 size={13} />
      </button>

      {editing && createPortal(
        <>
          <div className="fixed inset-0 z-50 bg-black/70" onClick={() => setEditing(false)} />
          <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-100 mb-3">Edit schedule</h3>
              <div className="space-y-3">
                <div>
                  {schedule.cron !== null ? (
                    <CronPicker value={editValue} onChange={setEditValue} />
                  ) : (
                    <>
                      <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
                      <input
                        autoFocus
                        type="datetime-local"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                      />
                    </>
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
                  <textarea
                    rows={2}
                    value={editConditions}
                    onChange={e => setEditConditions(e.target.value)}
                    placeholder="e.g. Only run between 9am and 5pm"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Task prompt addition</label>
                  <textarea
                    rows={2}
                    value={editAgentContext}
                    onChange={e => setEditAgentContext(e.target.value)}
                    placeholder="Anything you want added to the task prompt for this schedule only"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">When to notify me</label>
                  <textarea
                    rows={2}
                    value={editRelayGuidance}
                    onChange={e => setEditRelayGuidance(e.target.value)}
                    placeholder="e.g. Always send me this result, or: only notify me if something failed"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Also deliver to</label>
                  <select
                    multiple
                    value={editDeliverToHeadIds}
                    onChange={e => setEditDeliverToHeadIds(Array.from(e.target.selectedOptions, o => o.value))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                    size={Math.min(4, Math.max(2, (headsQuery.data?.heads ?? []).filter(h => h.id !== schedule.headId).length))}
                  >
                    {(headsQuery.data?.heads ?? []).filter(h => h.id !== schedule.headId).map(h => (
                      <option key={h.id} value={h.id}>{h.id}</option>
                    ))}
                  </select>
                  <div className="text-[11px] text-zinc-500 mt-0.5">Hold Ctrl/Cmd to select multiple. Owner head always included.</div>
                </div>
                {updateMutation.isError && (
                  <div className="text-xs text-red-400">{(updateMutation.error as Error).message}</div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditing(false)}
                    className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    disabled={updateMutation.isPending}
                    className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {updateMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ─── Add form ─────────────────────────────────────────────────────────────────

function AddScheduleForm({
  tasks,
  loading,
  onDone,
  tz,
}: {
  tasks: Array<{ name: string }>
  loading: boolean
  onDone: () => void
  tz: string
}) {
  const qc = useQueryClient()
  const [target, setTarget] = useState<string>('')
  const [headId, setHeadId] = useState<string>('')
  const [deliverToHeadIds, setDeliverToHeadIds] = useState<string[]>([])
  const [type, setType] = useState<'repeating' | 'once'>('repeating')
  const [cron, setCron] = useState('*/30 * * * *')
  const [runAt, setRunAt] = useState('')
  const [startAt, setStartAt] = useState('')
  const [conditions, setConditions] = useState('')
  const [agentContext, setAgentContext] = useState('')
  const [relayGuidance, setRelayGuidance] = useState('')
  const [error, setError] = useState('')

  const headsQuery = useQuery({
    queryKey: ['heads'],
    queryFn: api.heads.list,
  })

  // Seed target once data arrives (Pitfall 5 — don't seed with empty string)
  useEffect(() => {
    if (target) return
    if (tasks.length > 0) setTarget(tasks[0]!.name)
  }, [tasks, target])

  // Seed headId from localStorage 'active-head' (set by ConversationsPage)
  // when valid, otherwise fall back to heads[0]. Phase 35 D-14.
  useEffect(() => {
    if (headId) return
    const heads = headsQuery.data?.heads ?? []
    if (heads.length === 0) return
    const stored = readActiveHeadFromStorage()
    if (stored && heads.some(h => h.id === stored)) {
      setHeadId(stored)
    } else {
      setHeadId(heads[0]!.id)
    }
  }, [headsQuery.data, headId])

  const createMutation = useMutation({
    mutationFn: () => {
      if (!headId) throw new Error('Pick a head')
      if (!target) throw new Error('Pick a task')
      if (type === 'once' && !runAt) throw new Error('Pick a date and time for the schedule')
      return api.schedules.create({
        headId,
        taskName: target,
        kind: 'task',
        ...(type === 'repeating' ? { cron } : { runAt: datetimeLocalToUtc(runAt, tz) }),
        ...(conditions ? { conditions } : {}),
        ...(agentContext ? { agentContext } : {}),
        ...(relayGuidance ? { relayGuidance } : {}),
        ...(type === 'repeating' && startAt ? { startAt: datetimeLocalToUtc(startAt, tz) } : {}),
        ...(deliverToHeadIds.length ? { deliverToHeadIds } : {}),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
      setStartAt('')
      onDone()
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <form
      onSubmit={e => { e.preventDefault(); setError(''); createMutation.mutate() }}
      className="p-4 border-t border-zinc-700 space-y-3"
    >
      <div className="flex gap-3 flex-wrap">
        <div className="flex-1 min-w-40">
          <label className="text-xs text-zinc-500 mb-1 block">Head</label>
          <select
            value={headId}
            onChange={e => setHeadId(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
            required
          >
            {(headsQuery.data?.heads ?? []).length === 0
              ? <option disabled value="">No heads configured</option>
              : (headsQuery.data?.heads ?? []).map(h => (
                  <option key={h.id} value={h.id}>{h.id}</option>
                ))}
          </select>
        </div>
        {(headsQuery.data?.heads ?? []).filter(h => h.id !== headId).length > 0 && (
          <div className="flex-1 min-w-40">
            <label className="text-xs text-zinc-500 mb-1 block">Also deliver to</label>
            <select
              multiple
              value={deliverToHeadIds}
              onChange={e => setDeliverToHeadIds(Array.from(e.target.selectedOptions, o => o.value))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
              size={Math.min(4, Math.max(2, (headsQuery.data?.heads ?? []).filter(h => h.id !== headId).length))}
            >
              {(headsQuery.data?.heads ?? []).filter(h => h.id !== headId).map(h => (
                <option key={h.id} value={h.id}>{h.id}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex-1 min-w-40">
          <label className="text-xs text-zinc-500 mb-1 block">Target</label>
          <select
            value={target}
            onChange={e => setTarget(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
            required
          >
            {tasks.length === 0
              ? <option disabled value="">No tasks yet — create one on the Tasks page</option>
              : tasks.map(j => (
                  <option key={j.name} value={j.name}>{j.name}</option>
                ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Type</label>
          <div className="flex gap-1">
            {(['repeating', 'once'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  type === t ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'repeating' ? 'Repeating' : 'One-time'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {type === 'repeating' ? (
        <CronPicker value={cron} onChange={setCron} />
      ) : (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={e => setRunAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">Times are in the workspace timezone ({tz})</div>
        </div>
      )}

      {type === 'repeating' && (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Start date (optional)</label>
          <input
            type="datetime-local"
            value={startAt}
            onChange={e => setStartAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">
            First fire at this time, then repeating. Times are in the workspace timezone ({tz}).
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
        <textarea
          rows={2}
          value={conditions}
          onChange={e => setConditions(e.target.value)}
          placeholder="e.g. Only run between 9am and 5pm"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Task prompt addition</label>
        <textarea
          rows={2}
          value={agentContext}
          onChange={e => setAgentContext(e.target.value)}
          placeholder="Anything you want added to the task prompt for this schedule only"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">When to notify me</label>
        <textarea
          rows={2}
          value={relayGuidance}
          onChange={e => setRelayGuidance(e.target.value)}
          placeholder="e.g. Always send me this result, or: only notify me if something failed"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      {startAt && new Date(startAt) <= new Date() && (
        <div className="text-xs text-red-400">Start date must be in the future.</div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            createMutation.isPending
            || loading
            || !headId
            || !target
            || (type === 'once' && !runAt)
            || (startAt !== '' && new Date(startAt) <= new Date())
          }
          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
        >
          {createMutation.isPending ? 'Adding…' : 'Add schedule'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── Reminder row ─────────────────────────────────────────────────────────────

function ReminderRow({ schedule, tz }: { schedule: Schedule; tz: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editMessage, setEditMessage] = useState('')
  const [editValue, setEditValue] = useState('')      // holds cron OR runAt string
  const [editConditions, setEditConditions] = useState('')
  const [editRequiresAck, setEditRequiresAck] = useState(false)
  const [editNagMinutes, setEditNagMinutes] = useState(0)
  const [editNagHours, setEditNagHours] = useState(0)
  const [editNagDays, setEditNagDays] = useState(0)

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.schedules.delete(schedule.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const updateMutation = useMutation({
    mutationFn: (update: { cron?: string; runAt?: string; conditions?: string; agentContext?: string; requiresAck?: boolean; nagIntervalMinutes?: number | null }) =>
      api.schedules.update(schedule.id, update),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
  })

  function startEdit() {
    setEditMessage(schedule.agentContext ?? '')
    setEditValue(schedule.cron !== null ? schedule.cron : (schedule.runAt ? toDatetimeLocalInTz(schedule.runAt, tz) : ''))
    setEditConditions(schedule.conditions ?? '')
    setEditRequiresAck(schedule.requiresAck)
    const totalMins = schedule.nagIntervalMinutes ?? 0
    setEditNagDays(Math.floor(totalMins / 1440))
    setEditNagHours(Math.floor((totalMins % 1440) / 60))
    setEditNagMinutes(totalMins % 60)
    setEditing(true)
  }

  const editNagSum = editNagMinutes + editNagHours * 60 + editNagDays * 1440
  const nagValidationError = editRequiresAck && editNagSum === 0
    ? 'Set a nag interval when "Requires acknowledgment" is on.'
    : editNagSum > 43200
      ? 'Nag interval must be at most 30 days (43200 minutes).'
      : null

  function commitEdit() {
    const trimmedValue = editValue.trim()
    const trimmedMessage = editMessage.trim()
    if (!trimmedValue || !trimmedMessage) { setEditing(false); return }
    if (nagValidationError) return
    const conditionsUnchanged = editConditions === (schedule.conditions ?? '')
    const messageUnchanged = trimmedMessage === (schedule.agentContext ?? '')
    const editNag = editRequiresAck && editNagSum > 0 ? editNagSum : null
    const ackFields = {
      requiresAck: editRequiresAck,
      nagIntervalMinutes: editNag,
    }
    // Include ack/nag dirtiness in the early-return guards — otherwise an
    // ack-only or nag-only edit (message/cron/conditions untouched) closes the
    // modal without sending a PATCH and the change is lost.
    const ackUnchanged = editRequiresAck === schedule.requiresAck && editNag === schedule.nagIntervalMinutes
    if (schedule.cron !== null) {
      if (trimmedValue === schedule.cron && conditionsUnchanged && messageUnchanged && ackUnchanged) { setEditing(false); return }
      updateMutation.mutate({ cron: trimmedValue, conditions: editConditions, agentContext: trimmedMessage, ...ackFields })
      return
    }
    // one-time: editValue is a datetime-local string (workspace tz)
    const runAtUtc = datetimeLocalToUtc(trimmedValue, tz)
    if (!runAtUtc) return
    const runAtUnchanged = runAtUtc === schedule.runAt
    if (runAtUnchanged && conditionsUnchanged && messageUnchanged && ackUnchanged) { setEditing(false); return }
    updateMutation.mutate({ runAt: runAtUtc, conditions: editConditions, agentContext: trimmedMessage, ...ackFields })
  }

  const scheduleLabel = schedule.cron
    ? formatCron(schedule.cron)
    : schedule.runAt
      ? `Once at ${formatInTz(schedule.runAt, tz, { style: 'full' })}`
      : '—'

  // agentContext stores the reminder message
  const message = schedule.agentContext ?? schedule.id

  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-100 truncate">{message}</div>
        <div className="text-xs text-zinc-500 mt-0.5">
          {scheduleLabel}
          {schedule.requiresAck && schedule.nagIntervalMinutes
            ? ` · nags every ${formatNagInterval(schedule.nagIntervalMinutes)}`
            : null}
        </div>
        {schedule.conditions && (
          <div className="text-xs text-zinc-600 mt-0.5 truncate">if: {schedule.conditions}</div>
        )}
      </div>
      <div className="shrink-0 text-xs flex flex-col gap-1 items-start">
        <span
          className="inline-block px-2 py-0.5 rounded font-medium text-zinc-100 truncate max-w-[6rem]"
          style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}
          title={`Head: ${schedule.headId}`}
        >
          {schedule.headId}
        </span>
        {schedule.requiresAck && (
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold text-zinc-100 shrink-0"
            style={{ backgroundColor: '#92400e', borderLeft: '2px solid #f59e0b' }}
            title={`Nags every ${formatNagInterval(schedule.nagIntervalMinutes)} until acknowledged`}
          >
            NAGS
          </span>
        )}
      </div>
      <div className="text-right text-xs text-zinc-500 w-28 shrink-0">
        <div>Next: <span className="text-zinc-400">{formatRelTime(schedule.nextRun)}</span></div>
        <div>Last: <span className="text-zinc-400">{formatRelTime(schedule.lastRun)}</span></div>
      </div>
      <button
        onClick={() => toggleMutation.mutate(!schedule.enabled)}
        disabled={toggleMutation.isPending}
        title={schedule.enabled ? 'Disable' : 'Enable'}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          schedule.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
        } disabled:opacity-50`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          schedule.enabled ? 'translate-x-[18px]' : 'translate-x-0'
        }`} />
      </button>
      <button
        onClick={startEdit}
        title="Edit reminder"
        className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
      >
        <Pencil size={13} />
      </button>
      <button
        onClick={() => { if (window.confirm(`Delete reminder "${message}"?`)) deleteMutation.mutate() }}
        disabled={deleteMutation.isPending}
        title="Delete"
        className="text-zinc-500 hover:text-red-400 transition-colors shrink-0 disabled:opacity-50"
      >
        <Trash2 size={13} />
      </button>

      {editing && createPortal(
        <>
          <div className="fixed inset-0 z-50 bg-black/70" onClick={() => setEditing(false)} />
          <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-100 mb-3">Edit reminder</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Message</label>
                  <textarea
                    autoFocus
                    rows={2}
                    value={editMessage}
                    onChange={e => setEditMessage(e.target.value)}
                    placeholder="The reminder text"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                <div>
                  {schedule.cron !== null ? (
                    <CronPicker value={editValue} onChange={setEditValue} />
                  ) : (
                    <>
                      <label className="text-xs text-zinc-500 mb-1 block">Remind at</label>
                      <input
                        type="datetime-local"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                      />
                    </>
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
                  <textarea
                    rows={2}
                    value={editConditions}
                    onChange={e => setEditConditions(e.target.value)}
                    placeholder="e.g. Only remind me between 9am and 5pm"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Requires acknowledgment</label>
                  <button
                    type="button"
                    onClick={() => setEditRequiresAck(v => !v)}
                    title={editRequiresAck ? 'Acknowledgment required' : 'No acknowledgment required'}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                      editRequiresAck ? 'bg-emerald-600' : 'bg-zinc-700'
                    }`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      editRequiresAck ? 'translate-x-[18px]' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
                {editRequiresAck && (
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">Nag every</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number"
                        min={0}
                        value={editNagDays}
                        onChange={e => setEditNagDays(Number(e.target.value))}
                        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
                      />
                      <span className="text-xs text-zinc-500">d</span>
                      <input
                        type="number"
                        min={0}
                        value={editNagHours}
                        onChange={e => setEditNagHours(Number(e.target.value))}
                        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
                      />
                      <span className="text-xs text-zinc-500">h</span>
                      <input
                        type="number"
                        min={0}
                        value={editNagMinutes}
                        onChange={e => setEditNagMinutes(Number(e.target.value))}
                        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
                      />
                      <span className="text-xs text-zinc-500">m</span>
                    </div>
                  </div>
                )}
                {nagValidationError && (
                  <div className="text-xs text-red-400">{nagValidationError}</div>
                )}
                {updateMutation.isError && (
                  <div className="text-xs text-red-400">{(updateMutation.error as Error).message}</div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditing(false)}
                    className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    disabled={updateMutation.isPending || !!nagValidationError}
                    className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {updateMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ─── Add reminder form ────────────────────────────────────────────────────────

function AddReminderForm({ onDone, tz }: { onDone: () => void; tz: string }) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')
  const [headId, setHeadId] = useState<string>('')
  const [type, setType] = useState<'once' | 'repeating'>('once')
  const [runAt, setRunAt] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [conditions, setConditions] = useState('')
  const [requiresAck, setRequiresAck] = useState(false)
  const [nagMinutes, setNagMinutes] = useState(0)
  const [nagHours, setNagHours] = useState(0)
  const [nagDays, setNagDays] = useState(0)
  const [startAt, setStartAt] = useState('')
  const [error, setError] = useState('')

  const nagSum = nagMinutes + nagHours * 60 + nagDays * 1440

  const headsQuery = useQuery({
    queryKey: ['heads'],
    queryFn: api.heads.list,
  })

  // Seed headId from localStorage 'active-head' when valid, otherwise fall back
  // to heads[0]. Phase 35 D-14 — mirrors AddScheduleForm.
  useEffect(() => {
    if (headId) return
    const heads = headsQuery.data?.heads ?? []
    if (heads.length === 0) return
    const stored = readActiveHeadFromStorage()
    if (stored && heads.some(h => h.id === stored)) {
      setHeadId(stored)
    } else {
      setHeadId(heads[0]!.id)
    }
  }, [headsQuery.data, headId])

  const createMutation = useMutation({
    mutationFn: () => {
      if (!headId) throw new Error('Pick a head')
      if (!message.trim()) throw new Error('Enter a reminder message')
      if (type === 'once' && !runAt) throw new Error('Pick a date and time for the reminder')
      return api.schedules.create({
        headId,
        kind: 'reminder',
        agentContext: message.trim(),
        ...(type === 'repeating' ? { cron } : { runAt: datetimeLocalToUtc(runAt, tz) }),
        ...(conditions ? { conditions } : {}),
        ...(requiresAck ? { requiresAck, nagIntervalMinutes: nagSum } : {}),
        ...(type === 'repeating' && startAt ? { startAt: datetimeLocalToUtc(startAt, tz) } : {}),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
      setRequiresAck(false)
      setNagMinutes(0)
      setNagHours(0)
      setNagDays(0)
      setStartAt('')
      onDone()
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <form
      onSubmit={e => { e.preventDefault(); setError(''); createMutation.mutate() }}
      className="p-4 border-t border-zinc-700 space-y-3"
    >
      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Head</label>
        <select
          value={headId}
          onChange={e => setHeadId(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          required
        >
          {(headsQuery.data?.heads ?? []).length === 0
            ? <option disabled value="">No heads configured</option>
            : (headsQuery.data?.heads ?? []).map(h => (
                <option key={h.id} value={h.id}>{h.id}</option>
              ))}
        </select>
      </div>

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Message</label>
        <textarea
          autoFocus
          rows={2}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="e.g. Review weekly goals"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Type</label>
        <div className="flex gap-1">
          {(['once', 'repeating'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                type === t ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t === 'once' ? 'One-time' : 'Repeating'}
            </button>
          ))}
        </div>
      </div>

      {type === 'once' ? (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Remind at</label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={e => setRunAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">Times are in the workspace timezone ({tz})</div>
        </div>
      ) : (
        <CronPicker value={cron} onChange={setCron} />
      )}

      {type === 'repeating' && (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Start date (optional)</label>
          <input
            type="datetime-local"
            value={startAt}
            onChange={e => setStartAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">
            First fire at this time, then repeating. Times are in the workspace timezone ({tz}).
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
        <textarea
          rows={2}
          value={conditions}
          onChange={e => setConditions(e.target.value)}
          placeholder="e.g. Only remind me between 9am and 5pm"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Requires acknowledgment</label>
        <button
          type="button"
          onClick={() => setRequiresAck(v => !v)}
          title={requiresAck ? 'Acknowledgment required' : 'No acknowledgment required'}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            requiresAck ? 'bg-emerald-600' : 'bg-zinc-700'
          }`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            requiresAck ? 'translate-x-[18px]' : 'translate-x-0'
          }`} />
        </button>
      </div>

      {requiresAck && (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Nag every</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0}
              value={nagDays}
              onChange={e => setNagDays(Number(e.target.value))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
            />
            <span className="text-xs text-zinc-500">d</span>
            <input
              type="number"
              min={0}
              value={nagHours}
              onChange={e => setNagHours(Number(e.target.value))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
            />
            <span className="text-xs text-zinc-500">h</span>
            <input
              type="number"
              min={0}
              value={nagMinutes}
              onChange={e => setNagMinutes(Number(e.target.value))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 text-center"
            />
            <span className="text-xs text-zinc-500">m</span>
          </div>
        </div>
      )}

      {requiresAck && nagSum === 0 && (
        <div className="text-xs text-red-400">Set a nag interval when &quot;Requires acknowledgment&quot; is on.</div>
      )}
      {nagSum > 43200 && (
        <div className="text-xs text-red-400">Nag interval must be at most 30 days.</div>
      )}
      {startAt && new Date(startAt) <= new Date() && (
        <div className="text-xs text-red-400">Start date must be in the future.</div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            createMutation.isPending
            || !headId
            || !message.trim()
            || (type === 'once' && !runAt)
            || (requiresAck && nagSum === 0)
            || nagSum > 43200
            || (startAt !== '' && new Date(startAt) <= new Date())
          }
          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
        >
          {createMutation.isPending ? 'Adding…' : 'Add reminder'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── Sensor schedule row ──────────────────────────────────────────────────────

function SensorScheduleRow({ schedule, tz }: { schedule: Schedule; tz: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [editConditions, setEditConditions] = useState('')

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.schedules.delete(schedule.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const updateMutation = useMutation({
    mutationFn: (update: { cron?: string; runAt?: string; conditions?: string }) =>
      api.schedules.update(schedule.id, update),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
  })

  function startEdit() {
    setEditValue(schedule.cron !== null ? schedule.cron : (schedule.runAt ? toDatetimeLocalInTz(schedule.runAt, tz) : ''))
    setEditConditions(schedule.conditions ?? '')
    setEditing(true)
  }

  function commitEdit() {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditing(false); return }
    const conditionsUnchanged = editConditions === (schedule.conditions ?? '')
    if (schedule.cron !== null) {
      if (trimmed === schedule.cron && conditionsUnchanged) { setEditing(false); return }
      updateMutation.mutate({ cron: trimmed, conditions: editConditions })
      return
    }
    const runAtUtc = datetimeLocalToUtc(trimmed, tz)
    if (!runAtUtc) return
    const runAtUnchanged = runAtUtc === schedule.runAt
    if (runAtUnchanged && conditionsUnchanged) { setEditing(false); return }
    updateMutation.mutate({ runAt: runAtUtc, conditions: editConditions })
  }

  const scheduleLabel = schedule.cron
    ? formatCron(schedule.cron)
    : schedule.runAt
      ? `Once at ${formatInTz(schedule.runAt, tz, { style: 'full' })}`
      : '—'

  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100 truncate">
          {schedule.taskName ?? '—'}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">{scheduleLabel}</div>
        {schedule.conditions && (
          <div className="text-xs text-zinc-600 mt-0.5 truncate">if: {schedule.conditions}</div>
        )}
      </div>
      <div className="shrink-0">
        <span
          className="inline-block px-2 py-0.5 rounded text-xs font-medium text-zinc-300"
          style={{ backgroundColor: headColor(schedule.headId), borderLeft: `2px solid ${headColorBorder(schedule.headId)}` }}
          title={`Head: ${schedule.headId}`}
        >
          {schedule.headId}
        </span>
      </div>
      <div className="text-right text-xs text-zinc-500 w-28 shrink-0">
        <div>Next: <span className="text-zinc-400">{formatRelTime(schedule.nextRun)}</span></div>
        <div>Last: <span className="text-zinc-400">{formatRelTime(schedule.lastRun)}</span></div>
      </div>
      <button
        onClick={() => toggleMutation.mutate(!schedule.enabled)}
        disabled={toggleMutation.isPending}
        title={schedule.enabled ? 'Disable' : 'Enable'}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          schedule.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
        } disabled:opacity-50`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          schedule.enabled ? 'translate-x-[18px]' : 'translate-x-0'
        }`} />
      </button>
      <button
        onClick={startEdit}
        title="Edit schedule"
        className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
      >
        <Pencil size={13} />
      </button>
      <button
        onClick={() => { if (window.confirm(`Delete sensor schedule "${schedule.taskName ?? schedule.id}"?`)) deleteMutation.mutate() }}
        disabled={deleteMutation.isPending}
        title="Delete"
        className="text-zinc-500 hover:text-red-400 transition-colors shrink-0 disabled:opacity-50"
      >
        <Trash2 size={13} />
      </button>

      {editing && createPortal(
        <>
          <div className="fixed inset-0 z-50 bg-black/70" onClick={() => setEditing(false)} />
          <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-100 mb-3">Edit sensor schedule</h3>
              <div className="space-y-3">
                <div>
                  {schedule.cron !== null ? (
                    <CronPicker value={editValue} onChange={setEditValue} />
                  ) : (
                    <>
                      <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
                      <input
                        autoFocus
                        type="datetime-local"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                      />
                    </>
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
                  <textarea
                    rows={2}
                    value={editConditions}
                    onChange={e => setEditConditions(e.target.value)}
                    placeholder="e.g. Only run between 9am and 5pm"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
                  />
                </div>
                {updateMutation.isError && (
                  <div className="text-xs text-red-400">{(updateMutation.error as Error).message}</div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditing(false)}
                    className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    disabled={updateMutation.isPending}
                    className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {updateMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ─── Add sensor schedule form ──────────────────────────────────────────────────

function AddSensorScheduleForm({
  sensors,
  loading,
  onDone,
  tz,
}: {
  sensors: Array<{ slug: string }>
  loading: boolean
  onDone: () => void
  tz: string
}) {
  const qc = useQueryClient()
  const [targetSlug, setTargetSlug] = useState<string>('')
  const [headId, setHeadId] = useState<string>('')
  const [type, setType] = useState<'repeating' | 'once'>('repeating')
  const [cron, setCron] = useState('*/30 * * * *')
  const [runAt, setRunAt] = useState('')
  const [startAt, setStartAt] = useState('')
  const [conditions, setConditions] = useState('')
  const [error, setError] = useState('')

  const headsQuery = useQuery({
    queryKey: ['heads'],
    queryFn: api.heads.list,
  })

  // Seed targetSlug once sensor list arrives
  useEffect(() => {
    if (targetSlug) return
    if (sensors.length > 0) setTargetSlug(sensors[0]!.slug)
  }, [sensors, targetSlug])

  // Seed headId from localStorage 'active-head' (hidden plumbing — server requires it)
  useEffect(() => {
    if (headId) return
    const heads = headsQuery.data?.heads ?? []
    if (heads.length === 0) return
    const stored = readActiveHeadFromStorage()
    if (stored && heads.some(h => h.id === stored)) {
      setHeadId(stored)
    } else {
      setHeadId(heads[0]!.id)
    }
  }, [headsQuery.data, headId])

  const createMutation = useMutation({
    mutationFn: () => {
      if (!headId) throw new Error('No head configured — create a head first')
      if (!targetSlug) throw new Error('Pick a sensor')
      if (type === 'once' && !runAt) throw new Error('Pick a date and time for the schedule')
      return api.schedules.create({
        headId,
        taskName: targetSlug,
        kind: 'script',
        ...(type === 'repeating' ? { cron } : { runAt: datetimeLocalToUtc(runAt, tz) }),
        ...(conditions ? { conditions } : {}),
        ...(type === 'repeating' && startAt ? { startAt: datetimeLocalToUtc(startAt, tz) } : {}),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
      setStartAt('')
      onDone()
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <form
      onSubmit={e => { e.preventDefault(); setError(''); createMutation.mutate() }}
      className="p-4 border-t border-zinc-700 space-y-3"
    >
      <div className="flex gap-3 flex-wrap">
        <div className="flex-1 min-w-40">
          <label className="text-xs text-zinc-500 mb-1 block">Sensor</label>
          <select
            value={targetSlug}
            onChange={e => setTargetSlug(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
            required
          >
            {sensors.length === 0
              ? <option disabled value="">No sensors yet — create one on the Sensors page</option>
              : sensors.map(s => (
                  <option key={s.slug} value={s.slug}>{s.slug}</option>
                ))}
          </select>
        </div>
        <div className="flex-1 min-w-40">
          <label className="text-xs text-zinc-500 mb-1 block">Head</label>
          <select
            value={headId}
            onChange={e => setHeadId(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
            required
          >
            {(headsQuery.data?.heads ?? []).length === 0
              ? <option disabled value="">No heads configured</option>
              : (headsQuery.data?.heads ?? []).map(h => (
                  <option key={h.id} value={h.id}>{h.id}</option>
                ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Type</label>
          <div className="flex gap-1">
            {(['repeating', 'once'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  type === t ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'repeating' ? 'Repeating' : 'One-time'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {type === 'repeating' ? (
        <CronPicker value={cron} onChange={setCron} />
      ) : (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={e => setRunAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">Times are in the workspace timezone ({tz})</div>
        </div>
      )}

      {type === 'repeating' && (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Start date (optional)</label>
          <input
            type="datetime-local"
            value={startAt}
            onChange={e => setStartAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">
            First fire at this time, then repeating. Times are in the workspace timezone ({tz}).
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Run conditions</label>
        <textarea
          rows={2}
          value={conditions}
          onChange={e => setConditions(e.target.value)}
          placeholder="e.g. Only run between 9am and 5pm"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      {startAt && new Date(startAt) <= new Date() && (
        <div className="text-xs text-red-400">Start date must be in the future.</div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            createMutation.isPending
            || loading
            || !headId
            || !targetSlug
            || (type === 'once' && !runAt)
            || (startAt !== '' && new Date(startAt) <= new Date())
          }
          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
        >
          {createMutation.isPending ? 'Adding…' : 'Add sensor schedule'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SchedulesPage() {
  const [showForm, setShowForm] = useState(false)
  const [showReminderForm, setShowReminderForm] = useState(false)
  const [showSensorForm, setShowSensorForm] = useState(false)
  const tz = useConfigTimezone()

  const schedulesQuery = useQuery({
    queryKey: ['schedules'],
    queryFn: api.schedules.list,
    refetchInterval: 30_000,
  })

  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: api.tasks.list,
  })

  const sensorsQuery = useQuery({
    queryKey: ['sensors'],
    queryFn: api.sensors.list,
  })
  const sensors = sensorsQuery.data?.sensors ?? []

  const allSchedules = schedulesQuery.data?.schedules ?? []
  const taskSchedules = allSchedules.filter(s => s.kind !== 'reminder' && s.kind !== 'script')
  const reminderSchedules = allSchedules.filter(s => s.kind === 'reminder')
  const sensorSchedules = allSchedules.filter(s => s.kind === 'script')
  const tasks = tasksQuery.data?.tasks ?? []

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* ── Scheduled Tasks ── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Tasks</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Scheduled task runs</p>
          </div>
          <button
            onClick={() => setShowForm(f => !f)}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors"
          >
            {showForm ? 'Cancel' : '+ New task'}
          </button>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {schedulesQuery.isLoading && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</div>
          )}
          {schedulesQuery.isError && (
            <div className="px-4 py-8 text-center text-sm text-red-400">
              Failed to load schedules
            </div>
          )}
          {!schedulesQuery.isLoading && !schedulesQuery.isError && taskSchedules.length === 0 && !showForm && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">No schedules configured.</div>
          )}
          {taskSchedules.map(s => <ScheduleRow key={s.id} schedule={s} tz={tz} />)}
          {showForm && (
            <AddScheduleForm
              tasks={tasks}
              loading={tasksQuery.isLoading}
              onDone={() => setShowForm(false)}
              tz={tz}
            />
          )}
        </div>

        {/* ── Reminders ── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Reminders</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Upcoming reminders set by the assistant</p>
          </div>
          <button
            onClick={() => setShowReminderForm(f => !f)}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors"
          >
            {showReminderForm ? 'Cancel' : '+ New reminder'}
          </button>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {schedulesQuery.isLoading && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</div>
          )}
          {!schedulesQuery.isLoading && !schedulesQuery.isError && reminderSchedules.length === 0 && !showReminderForm && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No reminders set. Ask the assistant or add one here.
            </div>
          )}
          {reminderSchedules.map(s => <ReminderRow key={s.id} schedule={s} tz={tz} />)}
          {showReminderForm && (
            <AddReminderForm onDone={() => setShowReminderForm(false)} tz={tz} />
          )}
        </div>

        {/* ── Sensor Schedules ── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Sensor Schedules</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Scheduled sensor script runs</p>
          </div>
          <button
            onClick={() => setShowSensorForm(f => !f)}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors"
          >
            {showSensorForm ? 'Cancel' : '+ New sensor schedule'}
          </button>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {schedulesQuery.isLoading && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</div>
          )}
          {!schedulesQuery.isLoading && !schedulesQuery.isError && sensorSchedules.length === 0 && !showSensorForm && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No sensor schedules. Create a sensor first, then schedule it here.
            </div>
          )}
          {sensorSchedules.map(s => <SensorScheduleRow key={s.id} schedule={s} tz={tz} />)}
          {showSensorForm && (
            <AddSensorScheduleForm
              sensors={sensors}
              loading={sensorsQuery.isLoading}
              onDone={() => setShowSensorForm(false)}
              tz={tz}
            />
          )}
        </div>

      </div>
    </div>
  )
}
