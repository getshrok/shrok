import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, MoreHorizontal, Plus, X } from 'lucide-react'
import { api } from '../lib/api'

// The protected marker file. Like SKILL.md/TASK.md, it cannot be deleted or renamed
// (delete the whole sensor instead) and is always the first tab.
const MARKER = 'sensor.mjs'

// Derive a slug from a user-supplied name: lowercase, trim, replace runs of
// non-[a-z0-9] with '-', strip leading/trailing hyphens.
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.-]+$/
function isValidFilename(f: string): boolean {
  return SAFE_FILENAME_RE.test(f) && !f.includes('..')
}

// Per-file editor state: the saved copy on disk vs. the in-editor draft. A `gate`
// marks files we render read-only instead of in a textarea (binary / too large).
interface FileState {
  draft: string
  saved: string
  gate?: { kind: 'binary' | 'tooLarge'; size: number }
}

// ─── File tab context menu (rename / delete) ─────────────────────────────────

function FileTabMenu({ anchorRect, onRename, onDelete, onClose }: {
  anchorRect: DOMRect
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden min-w-[100px]"
      style={{ top: anchorRect.bottom + 4, left: anchorRect.left }}
    >
      <button
        type="button"
        onMouseDown={e => { e.preventDefault(); onRename(); onClose() }}
        className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        Rename
      </button>
      <button
        type="button"
        onMouseDown={e => { e.preventDefault(); onDelete(); onClose() }}
        className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-zinc-800 transition-colors"
      >
        Delete
      </button>
    </div>,
    document.body
  )
}

export default function SensorsPage() {
  const qc = useQueryClient()

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  // New-sensor form state
  const [newName, setNewName] = useState('')
  const [newBody, setNewBody] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)
  const [newError, setNewError] = useState('')

  // ── Multi-file editor state ──────────────────────────────────────────────
  const [activeFile, setActiveFile] = useState(MARKER)
  const [fileStates, setFileStates] = useState<Map<string, FileState>>(new Map())
  // File tab UI state
  const [menuFile, setMenuFile] = useState<string | null>(null)
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null)
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameFileValue, setRenameFileValue] = useState('')
  const [isCreatingFile, setIsCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')

  // ── List query ─────────────────────────────────────────────────────────────

  const listQuery = useQuery({
    queryKey: ['sensors'],
    queryFn: api.sensors.list,
  })

  // ── Detail query (marker content + file list) ────────────────────────────────

  const detailQuery = useQuery({
    queryKey: ['sensors', selectedSlug],
    queryFn: () => api.sensors.get(selectedSlug!),
    enabled: !!selectedSlug,
  })

  // Seed the marker file's state whenever the detail (re)loads.
  const detailContent = detailQuery.data?.content
  useEffect(() => {
    if (detailContent === undefined) return
    setFileStates(prev => {
      const next = new Map(prev)
      next.set(MARKER, { draft: detailContent, saved: detailContent })
      return next
    })
  }, [detailContent, selectedSlug])

  // Lazy-load a non-marker file's content the first time its tab is opened.
  useEffect(() => {
    if (!selectedSlug || activeFile === MARKER) return
    if (fileStates.has(activeFile)) return
    let cancelled = false
    void api.sensors.readFile(selectedSlug, activeFile).then(result => {
      if (cancelled) return
      setFileStates(prev => {
        const next = new Map(prev)
        if (result.binary) {
          next.set(activeFile, { draft: '', saved: '', gate: { kind: 'binary', size: result.size } })
        } else if (result.tooLarge) {
          next.set(activeFile, { draft: '', saved: '', gate: { kind: 'tooLarge', size: result.size } })
        } else {
          next.set(activeFile, { draft: result.content ?? '', saved: result.content ?? '' })
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [activeFile, selectedSlug, fileStates])

  function selectSlug(slug: string) {
    setSelectedSlug(slug)
    setActiveFile(MARKER)
    setFileStates(new Map())
    setIsCreatingFile(false)
    setNewFileName('')
    setRenamingFile(null)
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  // Save the active file. The marker uses the dedicated sensor save path; siblings
  // go through writeFile.
  const saveMutation = useMutation({
    mutationFn: async ({ slug, filename, content }: { slug: string; filename: string; content: string }) => {
      if (filename === MARKER) await api.sensors.save(slug, content)
      else await api.sensors.writeFile(slug, filename, content)
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      void qc.invalidateQueries({ queryKey: ['sensors', vars.slug] })
      // Mark the saved copy as current.
      setFileStates(prev => {
        const next = new Map(prev)
        const s = next.get(vars.filename)
        if (s) next.set(vars.filename, { ...s, saved: vars.content })
        return next
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => api.sensors.delete(slug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      setSelectedSlug(null)
      setFileStates(new Map())
      setActiveFile(MARKER)
    },
  })

  const deleteFileMutation = useMutation({
    mutationFn: (filename: string) => api.sensors.deleteFile(selectedSlug!, filename),
    onSuccess: (_data, filename) => {
      void qc.invalidateQueries({ queryKey: ['sensors', selectedSlug] })
      setFileStates(prev => {
        const next = new Map(prev)
        next.delete(filename)
        return next
      })
      if (activeFile === filename) setActiveFile(MARKER)
    },
  })

  const renameFileMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      api.sensors.renameFile(selectedSlug!, oldName, newName),
    onSuccess: (_data, { oldName, newName }) => {
      void qc.invalidateQueries({ queryKey: ['sensors', selectedSlug] })
      setFileStates(prev => {
        const next = new Map(prev)
        const s = next.get(oldName)
        next.delete(oldName)
        if (s) next.set(newName, s)
        return next
      })
      if (activeFile === oldName) setActiveFile(newName)
      setRenamingFile(null)
    },
  })

  const createFileMutation = useMutation({
    mutationFn: (filename: string) => api.sensors.writeFile(selectedSlug!, filename, ''),
    onSuccess: (_data, filename) => {
      void qc.invalidateQueries({ queryKey: ['sensors', selectedSlug] })
      setFileStates(prev => {
        const next = new Map(prev)
        next.set(filename, { draft: '', saved: '' })
        return next
      })
      setActiveFile(filename)
      setIsCreatingFile(false)
      setNewFileName('')
    },
    onError: () => { setIsCreatingFile(false); setNewFileName('') },
  })

  const createMutation = useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.sensors.save(slug, content),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['sensors'] })
      setNewName('')
      setNewBody('')
      setShowNewForm(false)
      setNewError('')
      selectSlug(vars.slug)
    },
    onError: (err: Error) => setNewError(err.message),
  })

  // ── Handlers ─────────────────────────────────────────────────────────────────

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

  function startFileRename(filename: string) {
    setRenamingFile(filename)
    setRenameFileValue(filename)
  }

  function commitFileRename() {
    const oldName = renamingFile
    if (!oldName) return
    const trimmed = renameFileValue.trim()
    if (!trimmed || trimmed === oldName) { setRenamingFile(null); return }
    if (!isValidFilename(trimmed)) return
    renameFileMutation.mutate({ oldName, newName: trimmed })
  }

  function commitNewFile() {
    const trimmed = newFileName.trim()
    if (!trimmed || !isValidFilename(trimmed)) return
    createFileMutation.mutate(trimmed)
  }

  function setActiveDraft(content: string) {
    setFileStates(prev => {
      const next = new Map(prev)
      const s = next.get(activeFile)
      if (s) next.set(activeFile, { ...s, draft: content })
      return next
    })
  }

  const sensors = listQuery.data?.sensors ?? []
  const files = detailQuery.data?.files ?? []
  const activeState = fileStates.get(activeFile)
  const isDirty = activeState && !activeState.gate ? activeState.draft !== activeState.saved : false

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left panel: sensor list ─────────────────────────────────────────── */}
      {/* Mirrors the shared KindEditorPage list pane (Tasks/Skills) so all three
          read as the same UI family: h1 header, a description blurb, w-48 width,
          and the same row styling. Sensors keep a bespoke page (no frontmatter /
          metadata form to share) but match the look. */}
      <div className="w-48 shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">
        <div className="px-4 pt-6 pb-3 border-b border-zinc-800 shrink-0 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100">Sensors</h1>
          <button
            onClick={() => { setShowNewForm(true); setNewError(''); setSelectedSlug(null) }}
            className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            + New
          </button>
        </div>

        <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
          <p className="text-[11px] text-zinc-500 leading-snug">
            Small scripts that run on a schedule and report what they observe — keeping live status (weather, calendar, host health) in the assistant's context, and nudging it when something noteworthy happens.
          </p>
        </div>

        <nav className="flex-1 px-2 py-3">
          {listQuery.isLoading && (
            <p className="px-2 py-1 text-xs text-zinc-500">Loading…</p>
          )}
          {listQuery.isError && (
            <p className="px-2 py-1 text-xs text-red-400">Failed to load sensors</p>
          )}
          {!listQuery.isLoading && sensors.length === 0 && (
            <p className="px-2 py-1 text-xs text-zinc-500">No sensors yet</p>
          )}
          {sensors.map(({ slug }) => {
            const selected = selectedSlug === slug
            return (
              <div
                key={slug}
                role="button"
                tabIndex={0}
                onClick={() => selectSlug(slug)}
                onKeyDown={e => e.key === 'Enter' && selectSlug(slug)}
                className={`flex items-stretch rounded cursor-pointer transition-colors group ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`}
              >
                <div className={`flex-1 min-w-0 px-2 py-1.5 text-xs flex items-center ${selected ? 'text-zinc-100' : 'text-zinc-400'}`}>
                  <span className="font-medium break-words flex-1">{slug}</span>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(slug) }}
                    disabled={deleteMutation.isPending}
                    title="Delete sensor"
                    className="shrink-0 ml-1 opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-30"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </nav>
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
          /* ── Multi-file editor ────────────────────────────────────────────── */
          <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-zinc-100">{selectedSlug}</h2>
              <button
                onClick={() => {
                  if (!activeState) return
                  saveMutation.mutate({ slug: selectedSlug, filename: activeFile, content: activeState.draft })
                }}
                disabled={saveMutation.isPending || detailQuery.isLoading || !isDirty || !!activeState?.gate}
                className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>

            {/* File tab bar */}
            <div className="px-4 flex items-center gap-0 border-b border-zinc-800 overflow-x-auto shrink-0">
              {files.map(f => (
                <div key={f.name} className="relative flex items-center">
                  {renamingFile === f.name ? (
                    <input
                      autoFocus
                      value={renameFileValue}
                      onChange={e => setRenameFileValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') commitFileRename(); if (e.key === 'Escape') setRenamingFile(null) }}
                      onBlur={commitFileRename}
                      className="px-2 py-1.5 text-xs font-mono text-zinc-200 bg-zinc-800 border border-zinc-600 rounded outline-none mb-px"
                    />
                  ) : (
                    <button
                      onClick={() => setActiveFile(f.name)}
                      className={`px-3 py-2 text-xs font-mono border-b-2 transition-colors whitespace-nowrap ${
                        activeFile === f.name
                          ? 'border-zinc-400 text-zinc-200'
                          : 'border-transparent text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {f.name}
                    </button>
                  )}
                  {/* Context menu trigger for non-protected files */}
                  {!f.isProtected && activeFile === f.name && renamingFile !== f.name && (
                    <button
                      onClick={e => {
                        if (menuFile === f.name) { setMenuFile(null); setMenuAnchorRect(null) }
                        else { setMenuFile(f.name); setMenuAnchorRect(e.currentTarget.getBoundingClientRect()) }
                      }}
                      className="p-0.5 text-zinc-500 hover:text-zinc-400 transition-colors"
                    >
                      <MoreHorizontal size={12} />
                    </button>
                  )}
                  {menuFile === f.name && menuAnchorRect && (
                    <FileTabMenu
                      anchorRect={menuAnchorRect}
                      onRename={() => startFileRename(f.name)}
                      onDelete={() => {
                        if (window.confirm(`Delete "${f.name}"?`)) {
                          deleteFileMutation.mutate(f.name)
                        }
                      }}
                      onClose={() => { setMenuFile(null); setMenuAnchorRect(null) }}
                    />
                  )}
                </div>
              ))}
              {/* New file button / input */}
              {isCreatingFile ? (
                <div className="flex items-center gap-1 ml-1 mb-px">
                  <input
                    autoFocus
                    value={newFileName}
                    onChange={e => setNewFileName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitNewFile()
                      if (e.key === 'Escape') { setIsCreatingFile(false); setNewFileName('') }
                    }}
                    onBlur={() => { if (!newFileName.trim()) { setIsCreatingFile(false); setNewFileName('') } }}
                    placeholder="filename.mjs"
                    className="px-2 py-1 text-xs font-mono text-zinc-200 bg-zinc-800 border border-zinc-600 rounded outline-none w-32"
                  />
                  <button
                    onClick={commitNewFile}
                    disabled={!newFileName.trim() || !isValidFilename(newFileName.trim())}
                    className="text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    onClick={() => { setIsCreatingFile(false); setNewFileName('') }}
                    className="text-zinc-500 hover:text-zinc-400"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingFile(true)}
                  className="px-2 py-2 text-zinc-500 hover:text-zinc-400 transition-colors border-b-2 border-transparent"
                  title="New file"
                >
                  <Plus size={14} />
                </button>
              )}
            </div>

            {/* Active file editor */}
            <div className="flex-1 flex flex-col p-4 gap-3 min-h-0">
              {detailQuery.isLoading && (
                <div className="text-xs text-zinc-500">Loading…</div>
              )}
              {detailQuery.isError && (
                <div className="text-xs text-red-400">Failed to load sensor</div>
              )}

              {activeState?.gate ? (
                <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
                  {activeState.gate.kind === 'binary'
                    ? 'Binary file — not shown.'
                    : `File too large to display (${(activeState.gate.size / 1024 / 1024).toFixed(1)} MB).`}
                </div>
              ) : (
                <textarea
                  value={activeState?.draft ?? ''}
                  onChange={e => setActiveDraft(e.target.value)}
                  disabled={detailQuery.isLoading || !activeState}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 font-mono outline-none focus:border-zinc-500 resize-none"
                  spellCheck={false}
                />
              )}

              {saveMutation.isSuccess && activeFile === MARKER && (
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
