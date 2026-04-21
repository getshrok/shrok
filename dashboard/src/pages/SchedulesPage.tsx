import cronstrue from 'cronstrue'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import type { Schedule } from '../types/api'
import { formatInTz, useConfigTimezone } from '../lib/formatTime'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isValidCron(expr: string): boolean {
  try {
    cronstrue.toString(expr.trim())
    return true
  } catch {
    return false
  }
}

function formatCron(cron: string): string {
  try {
    return cronstrue.toString(cron)
  } catch {
    return cron
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

// ─── Row ───────────────────────────────────────────────────────────────────────

function ScheduleRow({ schedule, tz }: { schedule: Schedule; tz: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [editConditions, setEditConditions] = useState('')
  const [editAgentContext, setEditAgentContext] = useState('')

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.schedules.delete(schedule.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const updateMutation = useMutation({
    mutationFn: (update: { cron?: string; runAt?: string; conditions?: string; agentContext?: string }) => api.schedules.update(schedule.id, update),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
  })

  function startEdit() {
    setEditValue(schedule.cron ?? schedule.runAt ?? '')
    setEditConditions(schedule.conditions ?? '')
    setEditAgentContext(schedule.agentContext ?? '')
    setEditing(true)
  }

  function commitEdit() {
    const trimmed = editValue.trim()
    if (!trimmed) { setEditing(false); return }
    const conditionsUnchanged = editConditions === (schedule.conditions ?? '')
    const agentContextUnchanged = editAgentContext === (schedule.agentContext ?? '')
    if (trimmed === schedule.cron && conditionsUnchanged && agentContextUnchanged) { setEditing(false); return }
    if (schedule.cron !== null) {
      if (!isValidCron(trimmed)) return
      updateMutation.mutate({ cron: trimmed, conditions: editConditions, agentContext: editAgentContext })
      return
    }
    const d = new Date(trimmed)
    if (Number.isNaN(d.getTime())) return
    updateMutation.mutate({ runAt: d.toISOString(), conditions: editConditions, agentContext: editAgentContext })
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
                  <label className="text-xs text-zinc-500 mb-1 block">
                    {schedule.cron !== null ? 'Cron expression' : 'Run at'}
                  </label>
                  {schedule.cron !== null ? (
                    <>
                      <input
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                        placeholder="*/30 * * * *"
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-600"
                      />
                      {editValue && (
                        <div className={`text-xs mt-1 ${isValidCron(editValue) ? 'text-zinc-500' : 'text-red-400'}`}>
                          {isValidCron(editValue) ? formatCron(editValue) : 'Invalid cron — use 5 fields (min hour dom mon dow)'}
                        </div>
                      )}
                    </>
                  ) : (
                    <input
                      autoFocus
                      type="datetime-local"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                    />
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
  const [type, setType] = useState<'repeating' | 'once'>('repeating')
  const [cron, setCron] = useState('*/30 * * * *')
  const [runAt, setRunAt] = useState('')
  const [conditions, setConditions] = useState('')
  const [agentContext, setAgentContext] = useState('')
  const [error, setError] = useState('')

  // Seed target once data arrives (Pitfall 5 — don't seed with empty string)
  useEffect(() => {
    if (target) return
    if (tasks.length > 0) setTarget(tasks[0]!.name)
  }, [tasks, target])

  const createMutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('Pick a task')
      if (type === 'once' && !runAt) throw new Error('Pick a date and time for the schedule')
      return api.schedules.create({
        taskName: target,
        kind: 'task',
        ...(type === 'repeating' ? { cron } : { runAt: new Date(runAt).toISOString() }),
        ...(conditions ? { conditions } : {}),
        ...(agentContext ? { agentContext } : {}),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] })
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
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Cron expression</label>
          <input
            value={cron}
            onChange={e => setCron(e.target.value)}
            placeholder="*/30 * * * *"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 font-mono"
          />
          {cron && <div className="text-xs text-zinc-500 mt-0.5">{formatCron(cron)}</div>}
        </div>
      ) : (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Run at</label>
          <input
            type="datetime-local"
            value={runAt}
            onChange={e => setRunAt(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="text-[11px] text-zinc-500 mt-0.5">Interpreted in {tz}</div>
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

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={createMutation.isPending || loading || !target || (type === 'once' && !runAt)}
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

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.schedules.update(schedule.id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.schedules.delete(schedule.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const updateMutation = useMutation({
    mutationFn: (update: { cron?: string; runAt?: string; conditions?: string; agentContext?: string }) =>
      api.schedules.update(schedule.id, update),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); setEditing(false) },
  })

  function startEdit() {
    setEditMessage(schedule.agentContext ?? '')
    setEditValue(schedule.cron ?? schedule.runAt ?? '')
    setEditConditions(schedule.conditions ?? '')
    setEditing(true)
  }

  function commitEdit() {
    const trimmedValue = editValue.trim()
    const trimmedMessage = editMessage.trim()
    if (!trimmedValue || !trimmedMessage) { setEditing(false); return }
    const conditionsUnchanged = editConditions === (schedule.conditions ?? '')
    const messageUnchanged = trimmedMessage === (schedule.agentContext ?? '')
    if (schedule.cron !== null) {
      if (trimmedValue === schedule.cron && conditionsUnchanged && messageUnchanged) { setEditing(false); return }
      if (!isValidCron(trimmedValue)) return
      updateMutation.mutate({ cron: trimmedValue, conditions: editConditions, agentContext: trimmedMessage })
      return
    }
    // one-time: editValue is a datetime-local string
    const d = new Date(trimmedValue)
    if (Number.isNaN(d.getTime())) return
    const runAtUnchanged = d.toISOString() === schedule.runAt
    if (runAtUnchanged && conditionsUnchanged && messageUnchanged) { setEditing(false); return }
    updateMutation.mutate({ runAt: d.toISOString(), conditions: editConditions, agentContext: trimmedMessage })
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
        <div className="text-xs text-zinc-500 mt-0.5">{scheduleLabel}</div>
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
                  <label className="text-xs text-zinc-500 mb-1 block">
                    {schedule.cron !== null ? 'Cron expression' : 'Remind at'}
                  </label>
                  {schedule.cron !== null ? (
                    <>
                      <input
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                        placeholder="0 9 * * *"
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-600"
                      />
                      {editValue && (
                        <div className={`text-xs mt-1 ${isValidCron(editValue) ? 'text-zinc-500' : 'text-red-400'}`}>
                          {isValidCron(editValue) ? formatCron(editValue) : 'Invalid cron — use 5 fields (min hour dom mon dow)'}
                        </div>
                      )}
                    </>
                  ) : (
                    <input
                      type="datetime-local"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitEdit() }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
                    />
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

// ─── Add reminder form ────────────────────────────────────────────────────────

function AddReminderForm({ onDone, tz }: { onDone: () => void; tz: string }) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'once' | 'repeating'>('once')
  const [runAt, setRunAt] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [conditions, setConditions] = useState('')
  const [error, setError] = useState('')

  const createMutation = useMutation({
    mutationFn: () => {
      if (!message.trim()) throw new Error('Enter a reminder message')
      if (type === 'once' && !runAt) throw new Error('Pick a date and time for the reminder')
      return api.schedules.create({
        kind: 'reminder',
        agentContext: message.trim(),
        ...(type === 'repeating' ? { cron } : { runAt: new Date(runAt).toISOString() }),
        ...(conditions ? { conditions } : {}),
      })
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['schedules'] }); onDone() },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <form
      onSubmit={e => { e.preventDefault(); setError(''); createMutation.mutate() }}
      className="p-4 border-t border-zinc-700 space-y-3"
    >
      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Message</label>
        <input
          autoFocus
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="e.g. Review weekly goals"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
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
          <div className="text-[11px] text-zinc-500 mt-0.5">Interpreted in {tz}</div>
        </div>
      ) : (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Cron expression</label>
          <input
            value={cron}
            onChange={e => setCron(e.target.value)}
            placeholder="0 9 * * *"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 font-mono"
          />
          {cron && <div className="text-xs text-zinc-500 mt-0.5">{formatCron(cron)}</div>}
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

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={createMutation.isPending || !message.trim() || (type === 'once' && !runAt)}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SchedulesPage() {
  const [showForm, setShowForm] = useState(false)
  const [showReminderForm, setShowReminderForm] = useState(false)
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

  const allSchedules = schedulesQuery.data?.schedules ?? []
  const taskSchedules = allSchedules.filter(s => s.kind !== 'reminder')
  const reminderSchedules = allSchedules.filter(s => s.kind === 'reminder')
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

      </div>
    </div>
  )
}
