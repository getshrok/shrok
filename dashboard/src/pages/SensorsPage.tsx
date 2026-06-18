import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { api } from '../lib/api'

// Derive a slug from a user-supplied name: lowercase, trim, replace runs of
// non-[a-z0-9] with '-', strip leading/trailing hyphens.
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function SensorsPage() {
  const qc = useQueryClient()

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')

  // New-sensor form state
  const [newName, setNewName] = useState('')
  const [newBody, setNewBody] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)
  const [newError, setNewError] = useState('')

  // ── List query ─────────────────────────────────────────────────────────────

  const listQuery = useQuery({
    queryKey: ['sensors'],
    queryFn: api.sensors.list,
  })

  // ── Detail query ───────────────────────────────────────────────────────────

  const detailQuery = useQuery({
    queryKey: ['sensors', selectedSlug],
    queryFn: () => api.sensors.get(selectedSlug!),
    enabled: !!selectedSlug,
  })

  // Sync editor when detail loads (or slug changes)
  const detailContent = detailQuery.data?.content
  // Keep a ref to detect when the loaded slug changes vs. user edits
  const [loadedSlugContent, setLoadedSlugContent] = useState<{ slug: string; content: string } | null>(null)

  if (
    detailContent !== undefined &&
    selectedSlug !== null &&
    (loadedSlugContent === null ||
      loadedSlugContent.slug !== selectedSlug ||
      loadedSlugContent.content !== detailContent)
  ) {
    setLoadedSlugContent({ slug: selectedSlug, content: detailContent })
    setEditorContent(detailContent)
  }

  // ── Save mutation ──────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.sensors.save(slug, content),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      if (selectedSlug !== null) {
        void qc.invalidateQueries({ queryKey: ['sensors', selectedSlug] })
      }
    },
  })

  // ── Delete mutation ────────────────────────────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => api.sensors.delete(slug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      setSelectedSlug(null)
      setEditorContent('')
      setLoadedSlugContent(null)
    },
  })

  // ── Create (via save) ──────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.sensors.save(slug, content),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      setNewName('')
      setNewBody('')
      setShowNewForm(false)
      setNewError('')
      setSelectedSlug(vars.slug)
    },
    onError: (err: Error) => setNewError(err.message),
  })

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const slug = nameToSlug(newName)
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      setNewError('Name produces an invalid slug — use letters, numbers, or hyphens.')
      return
    }
    setNewError('')
    createMutation.mutate({ slug, content: newBody })
  }

  function handleDelete(slug: string) {
    if (!window.confirm(`Delete sensor "${slug}"?`)) return
    deleteMutation.mutate(slug)
  }

  const sensors = listQuery.data?.sensors ?? []

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left panel: sensor list ─────────────────────────────────────────── */}
      <div className="w-56 shrink-0 border-r border-zinc-800 flex flex-col overflow-hidden">
        <div className="px-3 py-3 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Sensors</span>
          <button
            onClick={() => { setShowNewForm(f => !f); setNewError('') }}
            title={showNewForm ? 'Cancel' : 'New sensor'}
            className="text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none"
          >
            {showNewForm ? '×' : '+'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {listQuery.isLoading && (
            <div className="px-3 py-4 text-xs text-zinc-500">Loading…</div>
          )}
          {listQuery.isError && (
            <div className="px-3 py-4 text-xs text-red-400">Failed to load sensors</div>
          )}
          {!listQuery.isLoading && sensors.length === 0 && (
            <div className="px-3 py-4 text-xs text-zinc-500">No sensors yet.</div>
          )}
          {sensors.map(({ slug }) => (
            <div
              key={slug}
              className={`group flex items-center gap-1 px-3 py-2 cursor-pointer transition-colors ${
                selectedSlug === slug
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
              onClick={() => {
                setSelectedSlug(slug)
                setEditorContent('')
                setLoadedSlugContent(null)
              }}
            >
              <span className="flex-1 text-sm truncate">{slug}</span>
              <button
                onClick={e => { e.stopPropagation(); handleDelete(slug) }}
                disabled={deleteMutation.isPending}
                title="Delete sensor"
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-colors shrink-0 disabled:opacity-30"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: editor or new-sensor form ──────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {showNewForm ? (
          /* ── New-sensor form ──────────────────────────────────────────────── */
          <form onSubmit={handleCreate} className="flex flex-col h-full p-4 gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">New sensor</h2>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-zinc-500">Name</label>
              <input
                autoFocus
                value={newName}
                onChange={e => { setNewName(e.target.value); setNewError('') }}
                placeholder="e.g. weather"
                className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
              {newName && (
                <span className="text-[11px] text-zinc-500">
                  slug: <code>{nameToSlug(newName) || '(invalid)'}</code>
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1 flex-1 min-h-0">
              <label className="text-xs text-zinc-500">Script body</label>
              <textarea
                value={newBody}
                onChange={e => setNewBody(e.target.value)}
                placeholder={`process.stdout.write('# My Sensor\\nHello!')`}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-500 resize-none"
              />
            </div>

            {newError && <div className="text-xs text-red-400">{newError}</div>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending || !newName.trim()}
                className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
              >
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowNewForm(false); setNewError('') }}
                className="px-3 py-1.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : selectedSlug !== null ? (
          /* ── Script editor ────────────────────────────────────────────────── */
          <div className="flex flex-col h-full p-4 gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">{selectedSlug}</h2>
              <button
                onClick={() => saveMutation.mutate({ slug: selectedSlug, content: editorContent })}
                disabled={saveMutation.isPending || detailQuery.isLoading}
                className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>

            {detailQuery.isLoading && (
              <div className="text-xs text-zinc-500">Loading…</div>
            )}
            {detailQuery.isError && (
              <div className="text-xs text-red-400">Failed to load sensor</div>
            )}

            <textarea
              value={editorContent}
              onChange={e => setEditorContent(e.target.value)}
              disabled={detailQuery.isLoading}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-500 resize-none"
              spellCheck={false}
            />

            {saveMutation.isSuccess && (
              <div className="text-xs text-zinc-500">
                Saved. Saving doesn't run a sensor — schedule it on the Schedules page and it'll run within 60 seconds.
              </div>
            )}
            {saveMutation.isError && (
              <div className="text-xs text-red-400">
                {(saveMutation.error as Error).message}
              </div>
            )}
          </div>
        ) : (
          /* ── Empty state ──────────────────────────────────────────────────── */
          <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
            {sensors.length === 0
              ? 'Create your first sensor using the + button.'
              : 'Select a sensor to edit.'}
          </div>
        )}
      </div>
    </div>
  )
}
