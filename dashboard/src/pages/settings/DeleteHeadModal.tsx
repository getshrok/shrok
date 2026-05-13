import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { HeadDTO } from '../../types/api'

// Phase 33 Plan 07 (D-06) — typed-confirmation Delete modal. Replaces the
// Plan 06 baseline `window.confirm` in HeadCard.tsx. Shows the three real
// counts (messages, queueEvents, channels) the user is about to destroy and
// disables the Delete button until they type the head ID exactly. The
// backend DELETE /api/heads/:id receives `confirmId` in the body as a
// secondary server-side guard (T-33-04 layered mitigation).

interface Props {
  head: HeadDTO
  onClose: () => void
  onDeleted: () => void
}

export default function DeleteHeadModal({ head, onClose, onDeleted }: Props) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')

  const countsQuery = useQuery({
    queryKey: ['heads', head.id, 'counts'],
    queryFn: () => api.heads.counts(head.id),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.heads.delete(head.id, head.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['heads'] })
      onDeleted()
      onClose()
    },
  })

  const canConfirm = typed === head.id

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/80" onClick={onClose} />
      <div className="fixed z-[60] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[90vw] bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-zinc-100">Delete head &quot;{head.id}&quot;?</h2>
        <p className="text-sm text-zinc-300">
          This permanently deletes ALL data for this head. Cannot be undone.
        </p>
        {countsQuery.isLoading && (
          <div className="text-xs text-zinc-500">Loading counts…</div>
        )}
        {countsQuery.isError && (
          <div className="text-xs text-red-400">
            Failed to load counts: {(countsQuery.error as Error).message}
          </div>
        )}
        {countsQuery.data && (
          <ul className="text-sm text-zinc-300 space-y-1">
            <li>• {countsQuery.data.messages} messages will be deleted</li>
            <li>• {countsQuery.data.queueEvents} pending queue events will be deleted</li>
            <li>• {countsQuery.data.channels} channel adapter(s) will be removed</li>
          </ul>
        )}
        <p className="text-sm text-zinc-300">
          Type <code className="px-1 bg-zinc-800 rounded text-zinc-100">{head.id}</code> to confirm:
        </p>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
          placeholder={head.id}
          autoFocus
        />
        {deleteMutation.isError && (
          <p className="text-sm text-red-400">
            Delete failed: {(deleteMutation.error as Error).message}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg border border-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={() => deleteMutation.mutate()}
            disabled={!canConfirm || deleteMutation.isPending}
            className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
