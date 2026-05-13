import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import HeadCard from './HeadCard'

// Phase 33 Plan 06 (D-01, D-03, D-05, D-13) — the Heads tab root. Renders a
// HeadCard per head plus a [+ New head] form at the bottom. Each mutation
// invalidates the ['heads'] query and bubbles `onSaved()` so the SettingsModal
// can trigger the RestartModal — multi-head changes are mandatory-restart,
// so per-card flows don't participate in the modal's draft + Save.

interface HeadsTabProps {
  onSaved: () => void
}

const HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/

const inputClass = "w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"

export default function HeadsTab({ onSaved }: HeadsTabProps) {
  const queryClient = useQueryClient()
  const headsQuery = useQuery({
    queryKey: ['heads'],
    queryFn: api.heads.list,
    staleTime: 0,
  })

  const [adding, setAdding] = useState(false)
  const [pendingId, setPendingId] = useState('')

  const createMutation = useMutation({
    mutationFn: (id: string) => api.heads.create(id),
    onSuccess: () => { setAdding(false); setPendingId(''); handleSaved() },
  })

  function handleSaved() {
    void queryClient.invalidateQueries({ queryKey: ['heads'] })
    onSaved()
  }

  function handleCreate() {
    if (!HEAD_ID_REGEX.test(pendingId)) return
    createMutation.mutate(pendingId)
  }

  const heads = headsQuery.data?.heads ?? []
  const valid = HEAD_ID_REGEX.test(pendingId)

  return (
    <div className="space-y-4">
      {headsQuery.isLoading && (
        <div className="text-sm text-zinc-500 text-center py-4">Loading heads…</div>
      )}
      {headsQuery.isError && (
        <div className="text-sm text-red-400 text-center py-4">
          Failed to load heads: {(headsQuery.error as Error).message}
        </div>
      )}
      {heads.map(h => (
        <HeadCard key={h.id} head={h} allHeads={heads} onSaved={handleSaved} />
      ))}

      {!adding && (
        <button
          onClick={() => { setAdding(true); setPendingId('') }}
          className="px-3 py-1.5 text-sm text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded-md"
        >
          + New head
        </button>
      )}
      {adding && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="text-sm font-semibold text-zinc-200">New head</div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Head ID</label>
            <input
              type="text"
              value={pendingId}
              onChange={e => setPendingId(e.target.value)}
              placeholder="work, personal, …"
              autoFocus
              className={inputClass}
            />
            {pendingId && !valid && (
              <div className="text-xs text-red-400 mt-1">id must match /^[a-z0-9][a-z0-9-]{`{0,31}`}$/ (lowercase kebab, 1-32 chars)</div>
            )}
          </div>
          {createMutation.isError && (
            <div className="text-xs text-red-400">Create failed: {(createMutation.error as Error).message}</div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAdding(false); setPendingId('') }}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!valid || createMutation.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
