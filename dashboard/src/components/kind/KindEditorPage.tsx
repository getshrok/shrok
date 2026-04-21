import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { SkillDetail, SkillInfo, SkillFile } from '../../types/api'
import { Pencil, MoreHorizontal, Plus, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SettingTooltip } from '../../pages/settings/components'
import { useUnsavedGuard, confirmIfDirty } from '../../hooks/useUnsavedGuard'

// ─── Field tooltip copy (kind-aware where it matters) ─────────────────────────

const TIP_NAME = {
  skill: 'A short, memorable handle that agents use to reach for this skill.',
  task: 'A short, memorable handle for this task. Shows up in logs and anywhere you reference it.',
}

const TIP_DESCRIPTION = {
  skill: 'The best descriptions say what the skill does (not how), and when it should be reached for.',
  task: 'The best descriptions say what the task does (not how), and when it should be reached for.',
}

const TIP_BUNDLED_SKILLS = {
  skill: "Other skills whose instructions get pulled in automatically whenever this one is used. Cheaper, faster, and more reliable than the agent having to go retrieve them itself.",
  task: "Skills whose instructions get pulled in automatically whenever this task runs — its toolkit. Cheaper, faster, and more reliable than the agent having to go retrieve them itself.",
}

const TIP_MODEL = "Which model to use when this task runs on its own. Standard is fast and cheap, Capable is balanced, Expert is heavier."

const TIP_TOOLS = "Which tools the agent can use when the task runs on its own. Leave empty to allow all."

const TIP_ENV = "Environment variables the task needs at runtime. Values live in the .env file — just list the names here."

const TIP_NPM = "npm packages this needs. They get installed automatically before it runs."

const TIP_MONTHLY_BUDGET = "Monthly spending cap for this task. If the task has spent this much in the current month, scheduled runs are skipped. Leave empty for no cap."

const TIP_INSTRUCTIONS = {
  skill: "What the agent reads when it pulls this skill. Stick to what's specific to this skill — no need to explain things the model already knows.",
  task: "The prompt the agent runs when this task fires. Write it like a brief for someone doing the task unattended.",
}

// ─── Kind editor contract ──────────────────────────────────────────────────────

export interface KindApiClient {
  list: () => Promise<{ skills: SkillInfo[] } | { tasks: SkillInfo[] }>
  get: (name: string) => Promise<SkillDetail>
  save: (name: string, content: string, inPlace?: boolean) => Promise<{ ok: boolean }>
  delete: (name: string) => Promise<{ ok: boolean }>
  readFile: (name: string, filename: string) => Promise<{ content: string }>
  writeFile: (name: string, filename: string, content: string) => Promise<{ ok: boolean }>
  deleteFile: (name: string, filename: string) => Promise<{ ok: boolean }>
  renameFile: (name: string, oldFilename: string, newName: string) => Promise<{ ok: boolean }>
  rename: (name: string, newName: string) => Promise<{ ok: boolean; updatedDeps: string[] }>
}

export interface KindEditorPageProps {
  kind: 'skill' | 'task'
  apiClient: KindApiClient
  routeBase: string
  title: string
  subtitle?: string
  emptyStateHeading: string
  emptyStateBody?: string
  primaryCta: string
  createHeading: string
  createButtonLabel: string
  createPendingLabel: string
  deleteConfirm: (name: string) => string
  placeholderBody: string
  icon?: LucideIcon
}

function unpackList(data: { skills: SkillInfo[] } | { tasks: SkillInfo[] }): SkillInfo[] {
  if ('skills' in data) return data.skills
  return data.tasks
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SkillFormFields {
  name: string
  description: string
  model: string
  triggerTools: string[]
  skillDeps: string[]
  env: string[]
  npmDeps: string[]
  maxPerMonthUsd: string   // empty string = no cap; numeric string = cap in USD
}

interface FileState {
  draft: string
  saved: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function extractBody(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
  return match ? match[1]!.trimStart() : raw
}

function detailToFields(data: SkillDetail): SkillFormFields {
  return {
    name: data.name,
    description: data.description,
    model: data.model ?? '',
    triggerTools: data.triggerTools ?? [],
    skillDeps: data.skillDeps,
    env: data.requiredEnv,
    npmDeps: data.npmDeps,
    maxPerMonthUsd: data.maxPerMonthUsd != null ? String(data.maxPerMonthUsd) : '',
  }
}

function serializeSkill(fields: SkillFormFields, body: string): string {
  const lines: string[] = ['---']
  lines.push(`name: ${fields.name}`)
  lines.push(`description: ${JSON.stringify(fields.description)}`)
  if (fields.triggerTools.length > 0) {
    lines.push('trigger-tools:')
    fields.triggerTools.forEach(t => lines.push(`  - ${t}`))
  }
  if (fields.env.length > 0) {
    lines.push('trigger-env:')
    fields.env.forEach(e => lines.push(`  - ${e}`))
  }
  if (fields.model) lines.push(`model: ${fields.model}`)
  if (fields.skillDeps.length > 0) {
    lines.push('skill-deps:')
    fields.skillDeps.forEach(u => lines.push(`  - ${u}`))
  }
  if (fields.npmDeps.length > 0) {
    lines.push('npm-deps:')
    fields.npmDeps.forEach(d => lines.push(`  - ${d}`))
  }
  const capVal = parseFloat(fields.maxPerMonthUsd)
  if (!isNaN(capVal) && capVal > 0) lines.push(`max-per-month-usd: ${capVal}`)
  lines.push('---')
  lines.push('')
  lines.push(body.trimEnd())
  lines.push('')
  return lines.join('\n')
}

function newSkillContent(name: string, description: string): string {
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

## Instructions

Write your skill instructions here.
`
}

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.-]+$/
const ALLOWED_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.ts', '.sh', '.json', '.txt', '.yaml', '.yml'])
function isValidFilename(f: string): boolean {
  if (!SAFE_FILENAME_RE.test(f) || f.includes('..')) return false
  const ext = f.lastIndexOf('.') >= 0 ? f.slice(f.lastIndexOf('.')).toLowerCase() : ''
  return ALLOWED_EXTENSIONS.has(ext)
}

// ─── TagInput ──────────────────────────────────────────────────────────────────

function TagInput({ values, onChange, placeholder, readOnly }: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  readOnly?: boolean
}) {
  const [inputVal, setInputVal] = useState('')

  function commit() {
    const v = inputVal.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setInputVal('')
  }

  return (
    <div className={`flex flex-wrap gap-1.5 p-2 bg-zinc-800/60 border border-zinc-700/50 rounded-lg min-h-[38px] ${readOnly ? 'opacity-60' : ''}`}>
      {values.map(v => (
        <span key={v} className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-700 text-xs text-zinc-200">
          {v}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(values.filter(x => x !== v))}
              className="text-zinc-500 hover:text-zinc-200 leading-none"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
            if (e.key === 'Backspace' && !inputVal && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ''}
          className="bg-transparent text-xs text-zinc-200 placeholder-zinc-600 outline-none min-w-[80px] flex-1"
        />
      )}
    </div>
  )
}

// ─── TagSelect ────────────────────────────────────────────────────────────────

function TagSelect({ values, onChange, options, placeholder, readOnly }: {
  values: string[]
  onChange: (v: string[]) => void
  options: string[]
  placeholder?: string
  readOnly?: boolean
}) {
  const [inputVal, setInputVal] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightedIdx, setHighlightedIdx] = useState(0)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const filtered = options.filter(o =>
    !values.includes(o) && o.toLowerCase().includes(inputVal.toLowerCase())
  )

  function addTag(tag: string) {
    const v = tag.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setInputVal('')
    setHighlightedIdx(0)
  }

  function commitInput() {
    if (open && filtered[highlightedIdx]) {
      addTag(filtered[highlightedIdx]!)
    } else if (inputVal.trim()) {
      addTag(inputVal)
    }
    setOpen(false)
  }

  React.useEffect(() => {
    setHighlightedIdx(0)
  }, [inputVal])

  React.useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <div className={`flex flex-wrap gap-1.5 p-2 bg-zinc-800/60 border border-zinc-700/50 rounded-lg min-h-[38px] ${readOnly ? 'opacity-60' : ''}`}>
        {values.map(v => (
          <span key={v} className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-700 text-xs text-zinc-200">
            {v}
            {!readOnly && (
              <button
                type="button"
                onClick={() => onChange(values.filter(x => x !== v))}
                className="text-zinc-500 hover:text-zinc-200 leading-none"
              >×</button>
            )}
          </span>
        ))}
        {!readOnly && (
          <input
            value={inputVal}
            onChange={e => { setInputVal(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitInput() }
              if (e.key === 'Escape') { setOpen(false) }
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIdx(i => Math.min(i + 1, filtered.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIdx(i => Math.max(i - 1, 0)) }
              if (e.key === 'Backspace' && !inputVal && values.length > 0) { onChange(values.slice(0, -1)) }
            }}
            placeholder={values.length === 0 ? placeholder : ''}
            className="bg-transparent text-xs text-zinc-200 placeholder-zinc-600 outline-none min-w-[80px] flex-1"
          />
        )}
      </div>
      {open && !readOnly && filtered.length > 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-y-auto max-h-48">
          {filtered.map((opt, i) => (
            <button
              key={opt}
              type="button"
              onMouseDown={e => { e.preventDefault(); addTag(opt); setOpen(false) }}
              onMouseEnter={() => setHighlightedIdx(i)}
              className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                i === highlightedIdx ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── New entry form ────────────────────────────────────────────────────────────

function NewEntryForm({ kind, onCancel, onCreate, apiClient, listQueryKey, createHeading, createButtonLabel, createPendingLabel }: {
  kind: 'skill' | 'task'
  onCancel: () => void
  onCreate: (name: string) => void
  apiClient: KindApiClient
  listQueryKey: string
  createHeading: string
  createButtonLabel: string
  createPendingLabel: string
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const saveMutation = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) => apiClient.save(name, content),
    onSuccess: (_data, { name }) => {
      void qc.invalidateQueries({ queryKey: [listQueryKey] })
      onCreate(name)
    },
  })

  const nameValid = /^[a-zA-Z0-9_-]+$/.test(name)
  const fullName = name

  function handleCreate() {
    if (!nameValid || !description.trim()) return
    saveMutation.mutate({ name: fullName, content: newSkillContent(fullName, description.trim()) })
  }

  const heading = createHeading

  return (
    <div className="flex-1 flex flex-col p-6 gap-4">
      <h2 className="text-sm font-semibold text-zinc-200">
        {heading}
      </h2>
      <div className="space-y-3">
        <div>
          <label className="flex items-center text-xs text-zinc-500 mb-1">Name<SettingTooltip text={TIP_NAME[kind]} /></label>
          <div className="flex items-center gap-0">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={kind === 'task' ? 'my-task' : 'my-skill'}
              className="flex-1 bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 font-mono"
            />
          </div>
          {name && !nameValid && (
            <p className="text-[11px] text-red-400 mt-1">Only letters, numbers, hyphens, underscores</p>
          )}
        </div>
        <div>
          <label className="flex items-center text-xs text-zinc-500 mb-1">Description<SettingTooltip text={TIP_DESCRIPTION[kind]} /></label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={kind === 'task' ? 'What does this task do?' : 'What does this skill do?'}
            className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleCreate}
          disabled={!nameValid || !description.trim() || saveMutation.isPending}
          className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saveMutation.isPending ? createPendingLabel : createButtonLabel}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </div>
      {saveMutation.isError && (
        <p className="text-xs text-red-400">{(saveMutation.error as Error).message}</p>
      )}
    </div>
  )
}

// ─── File tab context menu ────────────────────────────────────────────────────

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

// ─── Entry editor ──────────────────────────────────────────────────────────────

function EntryEditor({ name, onDeleted, onRenamed, apiClient, listQueryKey, detailQueryKey, deleteConfirm, kind }: {
  name: string
  onDeleted: () => void
  onRenamed: (newName: string) => void
  apiClient: KindApiClient
  listQueryKey: string
  detailQueryKey: string
  deleteConfirm: (name: string) => string
  kind: 'skill' | 'task'
}) {
  const qc = useQueryClient()


  const { data, isLoading } = useQuery({
    queryKey: [detailQueryKey, name],
    queryFn: () => apiClient.get(name),
    staleTime: 30_000,
  })

  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: api.tools.list, staleTime: Infinity })
  // skill-deps always references skills (for both skill and task editors — tasks
  // bundle skill instructions too; no entity ever depends on tasks).
  // Uses native API shape so the ['skills'] cache slot is consistent with any
  // other consumer reading api.skills.list().
  const skillsForDepsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: api.skills.list,
    staleTime: 30_000,
  })

  // Active file tab
  const [activeFile, setActiveFile] = useState('SKILL.md')

  // SKILL.md form state
  const [fields, setFields] = useState<SkillFormFields | null>(null)
  const [body, setBody] = useState('')
  const [savedFields, setSavedFields] = useState<SkillFormFields | null>(null)
  const [savedBody, setSavedBody] = useState('')

  // Raw mode state (developer only)
  const [showRaw, setShowRaw] = useState(false)

  // Per-file state (for non-SKILL.md files)
  const [fileStates, setFileStates] = useState<Map<string, FileState>>(new Map())

  // Inline rename for skill name
  const [isRenamingSkill, setIsRenamingSkill] = useState(false)
  const [renameSkillValue, setRenameSkillValue] = useState('')

  // Inline rename for file tab
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameFileValue, setRenameFileValue] = useState('')

  // New file creation
  const [isCreatingFile, setIsCreatingFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')

  // Context menu
  const [menuFile, setMenuFile] = useState<string | null>(null)
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null)

  // Initialize SKILL.md state from data
  useEffect(() => {
    if (data) {
      const f = detailToFields(data)
      const b = extractBody(data.rawContent)
      setFields(f)
      setBody(b)
      setSavedFields(f)
      setSavedBody(b)
      // Seed SKILL.md file state
      setFileStates(prev => {
        const next = new Map(prev)
        next.set('SKILL.md', { draft: data.rawContent, saved: data.rawContent })
        return next
      })
    }
  }, [data])

  // Reset active file when skill changes
  useEffect(() => {
    setActiveFile('SKILL.md')
    setFileStates(new Map())
    setIsCreatingFile(false)
    setMenuFile(null)
    setRenamingFile(null)
    setIsRenamingSkill(false)
  }, [name])

  // Load file content lazily when tab selected
  useEffect(() => {
    if (activeFile === 'SKILL.md') return
    if (fileStates.has(activeFile)) return
    apiClient.readFile(name, activeFile).then(({ content }) => {
      setFileStates(prev => {
        const next = new Map(prev)
        next.set(activeFile, { draft: content, saved: content })
        return next
      })
    }).catch(() => { /* file may have been deleted */ })
    // fileStates intentionally omitted: the `has` check is a first-hit guard;
    // including it would re-fire the effect after we populate state.
  }, [activeFile, name, apiClient])

  // ── Mutations ─────────────────────────────────────────────────────────────

  const saveSkillMutation = useMutation({
    mutationFn: (content: string) => apiClient.save(name, content),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [listQueryKey] })
      void qc.invalidateQueries({ queryKey: [detailQueryKey, name] })
    },
  })

  const saveFileMutation = useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      apiClient.writeFile(name, filename, content),
    onSuccess: (_data, { filename, content }) => {
      setFileStates(prev => {
        const next = new Map(prev)
        next.set(filename, { draft: content, saved: content })
        return next
      })
      void qc.invalidateQueries({ queryKey: [detailQueryKey, name] })
    },
  })

  const deleteFileMutation = useMutation({
    mutationFn: (filename: string) => apiClient.deleteFile(name, filename),
    onSuccess: (_data, filename) => {
      setFileStates(prev => {
        const next = new Map(prev)
        next.delete(filename)
        return next
      })
      if (activeFile === filename) setActiveFile('SKILL.md')
      void qc.invalidateQueries({ queryKey: [detailQueryKey, name] })
    },
  })

  const renameFileMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      apiClient.renameFile(name, oldName, newName),
    onSuccess: (_data, { oldName, newName }) => {
      setFileStates(prev => {
        const next = new Map(prev)
        const old = next.get(oldName)
        if (old) {
          next.delete(oldName)
          next.set(newName, old)
        }
        return next
      })
      if (activeFile === oldName) setActiveFile(newName)
      void qc.invalidateQueries({ queryKey: [detailQueryKey, name] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiClient.delete(name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [listQueryKey] })
      onDeleted()
    },
  })

  const renameSkillMutation = useMutation({
    mutationFn: (newName: string) => apiClient.rename(name, newName),
    onSuccess: (_data, newName) => {
      void qc.invalidateQueries({ queryKey: [listQueryKey] })
      onRenamed(newName)
    },
  })

  const createFileMutation = useMutation({
    mutationFn: (filename: string) => apiClient.writeFile(name, filename, ''),
    onSuccess: (_data, filename) => {
      setFileStates(prev => {
        const next = new Map(prev)
        next.set(filename, { draft: '', saved: '' })
        return next
      })
      setActiveFile(filename)
      setIsCreatingFile(false)
      setNewFileName('')
      void qc.invalidateQueries({ queryKey: [detailQueryKey, name] })
    },
  })

  // ── Dirty state (computed before early return so hook count is stable) ───

  const skillMdDirty = data && fields && showRaw
    ? (fileStates.get('SKILL.md')?.draft ?? data.rawContent) !== (fileStates.get('SKILL.md')?.saved ?? data.rawContent)
    : data && fields
    ? JSON.stringify(fields) !== JSON.stringify(savedFields) || body !== savedBody
    : false

  const activeFileState = activeFile !== 'SKILL.md' ? fileStates.get(activeFile) : null
  const otherFileDirty = activeFileState ? activeFileState.draft !== activeFileState.saved : false

  const isDirty = activeFile === 'SKILL.md' ? skillMdDirty : otherFileDirty
  useUnsavedGuard(isDirty)

  if (isLoading || !data || !fields) {
    return <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">Loading...</div>
  }

  const isEditable = true
  const files: SkillFile[] = data.files ?? []

  // ── Save / Reset ──────────────────────────────────────────────────────────

  function handleSave() {
    if (!isDirty || !data) return
    if (activeFile === 'SKILL.md') {
      const content = showRaw
        ? (fileStates.get('SKILL.md')?.draft ?? data.rawContent)
        : serializeSkill(fields!, body)
      saveSkillMutation.mutate(content)
      if (!showRaw) {
        setSavedFields({ ...fields! })
        setSavedBody(body)
        setFileStates(prev => {
          const next = new Map(prev)
          next.set('SKILL.md', { draft: content, saved: content })
          return next
        })
      } else {
        setFileStates(prev => {
          const next = new Map(prev)
          const s = next.get('SKILL.md')
          if (s) next.set('SKILL.md', { ...s, saved: s.draft })
          return next
        })
      }
    } else {
      const state = fileStates.get(activeFile)
      if (state) {
        saveFileMutation.mutate({ filename: activeFile, content: state.draft })
      }
    }
  }

  function handleReset() {
    if (activeFile === 'SKILL.md') {
      if (showRaw) {
        setFileStates(prev => {
          const next = new Map(prev)
          const s = next.get('SKILL.md')
          if (s) next.set('SKILL.md', { ...s, draft: s.saved })
          return next
        })
      } else {
        setFields(savedFields ? { ...savedFields } : null)
        setBody(savedBody)
      }
    } else {
      setFileStates(prev => {
        const next = new Map(prev)
        const s = next.get(activeFile)
        if (s) next.set(activeFile, { ...s, draft: s.saved })
        return next
      })
    }
  }

  function handleToggleRaw(toRaw: boolean) {
    if (!toRaw && data) {
      const f = detailToFields(data)
      const b = extractBody(data.rawContent)
      setFields(f)
      setBody(b)
      setSavedFields(f)
      setSavedBody(b)
    }
    setShowRaw(toRaw)
  }

  function setField<K extends keyof SkillFormFields>(key: K, value: SkillFormFields[K]) {
    setFields(f => f ? { ...f, [key]: value } : f)
  }

  function updateFileDraft(filename: string, content: string) {
    setFileStates(prev => {
      const next = new Map(prev)
      const s = next.get(filename)
      if (s) next.set(filename, { ...s, draft: content })
      return next
    })
  }

  // ── Skill rename ──────────────────────────────────────────────────────────

  function startSkillRename() {
    setRenameSkillValue(name.includes('/') ? name.split('/').pop()! : name)
    setIsRenamingSkill(true)
  }

  function commitSkillRename() {
    setIsRenamingSkill(false)
    const trimmed = renameSkillValue.trim()
    if (!trimmed || trimmed === name) return
    const newFullName = trimmed
    renameSkillMutation.mutate(newFullName)
  }

  // ── File rename ───────────────────────────────────────────────────────────

  function startFileRename(filename: string) {
    setRenameFileValue(filename)
    setRenamingFile(filename)
  }

  function commitFileRename() {
    const oldName = renamingFile
    setRenamingFile(null)
    if (!oldName) return
    const trimmed = renameFileValue.trim()
    if (!trimmed || trimmed === oldName) return
    if (!isValidFilename(trimmed)) return
    renameFileMutation.mutate({ oldName, newName: trimmed })
  }

  // ── New file ──────────────────────────────────────────────────────────────

  function commitNewFile() {
    const trimmed = newFileName.trim()
    if (!trimmed || !isValidFilename(trimmed)) return
    createFileMutation.mutate(trimmed)
  }

  const isSaving = saveSkillMutation.isPending || saveFileMutation.isPending

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-2.5 shrink-0 flex-wrap">
        {isRenamingSkill ? (
          <input
            autoFocus
            value={renameSkillValue}
            onChange={e => setRenameSkillValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitSkillRename(); if (e.key === 'Escape') setIsRenamingSkill(false) }}
            onBlur={commitSkillRename}
            className="text-sm font-medium text-zinc-100 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 outline-none font-mono"
          />
        ) : (
          <span className="text-sm font-medium text-zinc-100 flex items-center gap-1.5">
            {data.name}
            {isEditable && (
              <button onClick={startSkillRename} className="text-zinc-500 hover:text-zinc-400 transition-colors">
                <Pencil size={12} />
              </button>
            )}
          </span>
        )}
        <div className="flex-1" />
        {activeFile === 'SKILL.md' && (
          <button
            onClick={() => handleToggleRaw(!showRaw)}
            className={`text-xs transition-colors ${showRaw ? 'text-zinc-300' : 'text-zinc-500 hover:text-zinc-400'}`}
          >
            Raw
          </button>
        )}
        {isEditable && isDirty && (
          <button onClick={handleReset} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            Reset
          </button>
        )}
        {(
          <button
            onClick={() => { if (window.confirm(deleteConfirm(name))) deleteMutation.mutate() }}
            disabled={deleteMutation.isPending}
            className="text-xs text-red-800 hover:text-red-500 transition-colors disabled:opacity-40"
          >
            Delete
          </button>
        )}
        {isEditable && (
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="px-3 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : isDirty ? 'Save' : 'Saved'}
          </button>
        )}
      </div>


      {/* File tab bar */}
      {(files.length > 1 || isEditable) && (
        <div className="px-5 pt-2 flex items-center gap-0 border-b border-zinc-800 overflow-x-auto shrink-0">
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
              {isEditable && !f.isProtected && activeFile === f.name && renamingFile !== f.name && (
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
          {isEditable && (
            isCreatingFile ? (
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
                  placeholder="filename.md"
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
            )
          )}
        </div>
      )}

      {/* ── SKILL.md editor ────────────────────────────────────────────────── */}
      {activeFile === 'SKILL.md' && (
        <>
          {/* Raw textarea (developer mode) */}
          {showRaw && (
            <div className="flex-1 p-5 min-h-0">
              <textarea
                value={fileStates.get('SKILL.md')?.draft ?? data.rawContent}
                onChange={e => updateFileDraft('SKILL.md', e.target.value)}
                readOnly={!isEditable}
                className="w-full h-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-200 font-mono leading-relaxed resize-none focus:outline-none focus:border-zinc-600"
                spellCheck={false}
              />
            </div>
          )}

          {/* Structured form */}
          {!showRaw && (
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Description */}
              <div>
                <label className="flex items-center text-xs text-zinc-500 mb-1">Description<SettingTooltip text={TIP_DESCRIPTION[kind]} /></label>
                <input
                  type="text"
                  value={fields.description}
                  onChange={e => setField('description', e.target.value)}
                  readOnly={!isEditable}
                  className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                />
              </div>

              {/* Advanced fields */}
              <>
                {/* Skills */}
                  <div>
                    <label className="flex items-center text-xs text-zinc-500 mb-1">Skills (bundled)<SettingTooltip text={TIP_BUNDLED_SKILLS[kind]} /></label>
                    <TagSelect
                      values={fields.skillDeps}
                      onChange={v => setField('skillDeps', v)}
                      options={(skillsForDepsQuery.data?.skills ?? []).map(s => s.name).filter(n => kind === 'task' || n !== fields.name)}
                      placeholder="skill-name..."
                      readOnly={!isEditable}
                    />
                  </div>

                  {/* npm-deps — both kinds; Advanced collapsible for skills */}
                  {kind === 'skill' && (
                  <details className="rounded-lg border border-zinc-700/50 p-3 group">
                    <summary className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider cursor-pointer select-none list-none flex items-center gap-1.5">
                      <span className="inline-block transition-transform group-open:rotate-90">›</span>
                      Advanced
                    </summary>
                    <div className="space-y-4 mt-3">
                      <div>
                        <label className="flex items-center text-xs text-zinc-500 mb-1">npm packages<SettingTooltip text={TIP_NPM} /></label>
                        <TagInput
                          values={fields.npmDeps}
                          onChange={v => setField('npmDeps', v)}
                          placeholder="package-name..."
                          readOnly={!isEditable}
                        />
                      </div>
                    </div>
                  </details>
                  )}

                  {/* Scheduled / trigger settings — tasks only. Skills are run
                      as instructions by generic agents (no pre-load). */}
                  {kind === 'task' && (
                  <details className="rounded-lg border border-zinc-700/50 p-3 group">
                    <summary className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider cursor-pointer select-none list-none flex items-center gap-1.5">
                      <span className="inline-block transition-transform group-open:rotate-90">›</span>
                      Scheduled &amp; triggered runs
                    </summary>
                    <div className="space-y-4 mt-3">

                    {/* Model */}
                    <div>
                      <label className="flex items-center text-xs text-zinc-500 mb-1">Model<SettingTooltip text={TIP_MODEL} /></label>
                      <select
                        value={['', 'standard', 'capable', 'expert'].includes(fields.model) ? fields.model : 'custom'}
                        onChange={e => {
                          if (e.target.value !== 'custom') setField('model', e.target.value)
                        }}
                        disabled={!isEditable}
                        className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600 disabled:opacity-60"
                      >
                        <option value="">Default (capable)</option>
                        <option value="standard">Standard</option>
                        <option value="capable">Capable</option>
                        <option value="expert">Expert</option>
                        {!['', 'standard', 'capable', 'expert'].includes(fields.model) && (
                          <option value="custom">{fields.model}</option>
                        )}
                      </select>
                    </div>

                    {/* Trigger Tools */}
                    <div>
                      <label className="flex items-center text-xs text-zinc-500 mb-1">Tools<SettingTooltip text={TIP_TOOLS} /></label>
                      <TagSelect
                        values={fields.triggerTools}
                        onChange={v => setField('triggerTools', v)}
                        options={toolsQuery.data?.tools ?? []}
                        placeholder="Add tool name..."
                        readOnly={!isEditable}
                      />
                      <p className="text-[11px] text-zinc-500 mt-1">Leave empty to allow all tools.</p>
                    </div>

                    {/* Env vars */}
                    <div>
                      <label className="flex items-center text-xs text-zinc-500 mb-1">Env vars<SettingTooltip text={TIP_ENV} /></label>
                      <TagInput
                        values={fields.env}
                        onChange={v => setField('env', v)}
                        placeholder="GITHUB_TOKEN..."
                        readOnly={!isEditable}
                      />
                    </div>

                    {/* npm packages */}
                    <div>
                      <label className="flex items-center text-xs text-zinc-500 mb-1">npm packages<SettingTooltip text={TIP_NPM} /></label>
                      <TagInput
                        values={fields.npmDeps}
                        onChange={v => setField('npmDeps', v)}
                        placeholder="package-name..."
                        readOnly={!isEditable}
                      />
                    </div>

                    {/* Monthly budget cap */}
                    <div>
                      <label className="flex items-center text-xs text-zinc-500 mb-1">Monthly budget cap (USD)<SettingTooltip text={TIP_MONTHLY_BUDGET} /></label>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={fields.maxPerMonthUsd}
                        onChange={e => setField('maxPerMonthUsd', e.target.value)}
                        readOnly={!isEditable}
                        placeholder="e.g. 5.00"
                        className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-60"
                      />
                      <p className="text-[11px] text-zinc-500 mt-1">Leave empty for no cap.</p>
                    </div>
                    </div>
                  </details>
                  )}
              </>

              {/* Instructions body */}
              <div className="flex flex-col" style={{ minHeight: '400px', height: '80vh' }}>
                <label className="flex items-center text-xs text-zinc-500 mb-1">Instructions<SettingTooltip text={TIP_INSTRUCTIONS[kind]} /></label>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  readOnly={!isEditable}
                  className={`flex-1 bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-200 font-mono leading-relaxed resize-none focus:outline-none focus:border-zinc-600 ${!isEditable ? 'text-zinc-400 cursor-default' : ''}`}
                  spellCheck={false}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Other file editor ──────────────────────────────────────────────── */}
      {activeFile !== 'SKILL.md' && (
        <div className="flex-1 p-5 min-h-0">
          {fileStates.has(activeFile) ? (
            <textarea
              value={fileStates.get(activeFile)!.draft}
              onChange={e => updateFileDraft(activeFile, e.target.value)}
              readOnly={!isEditable}
              className="w-full h-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-200 font-mono leading-relaxed resize-none focus:outline-none focus:border-zinc-600"
              spellCheck={false}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading file...</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sidebar components ────────────────────────────────────────────────────────

function SidebarRow({ label, selected, depth = 0, onSelect, trailing }: {
  label: string
  selected: boolean
  depth?: number
  onSelect: () => void
  trailing?: React.ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => e.key === 'Enter' && onSelect()}
      className={`flex items-stretch rounded cursor-pointer transition-colors group ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`}
    >
      {depth > 0 && <div className="w-4 shrink-0 flex items-center justify-center"><span className="w-px h-full bg-zinc-800" /></div>}
      <div className={`flex-1 min-w-0 px-2 py-1.5 text-xs flex items-center ${selected ? 'text-zinc-100' : 'text-zinc-400'}`}>
        <span className="font-medium break-words flex-1">{label}</span>
        {trailing && <span className="shrink-0 ml-1">{trailing}</span>}
      </div>
    </div>
  )
}

function SkillEntry({ skill, selectedName, onSelect }: {
  skill: SkillInfo
  selectedName: string | null
  onSelect: (name: string) => void
}) {
  return (
    <div>
      <SidebarRow
        label={skill.name}
        selected={skill.name === selectedName}
        onSelect={() => onSelect(skill.name)}
      />
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export function KindEditorPage(props: KindEditorPageProps) {
  const { kind, apiClient, title, subtitle, emptyStateHeading, emptyStateBody, primaryCta, createHeading, createButtonLabel, createPendingLabel, deleteConfirm, placeholderBody, icon: Icon } = props
  const listQueryKey = `${kind}s`
  const detailQueryKey = kind

  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: [listQueryKey],
    queryFn: apiClient.list,
  })

  const allSkills = data ? unpackList(data) : []

  function select(name: string) {
    if (!confirmIfDirty()) return
    setSelectedName(name)
    setIsCreating(false)
  }

  function handleCreated(name: string) {
    setIsCreating(false)
    setSelectedName(name)
  }

  function handleDeleted() {
    setSelectedName(null)
  }

  function handleRenamed(newName: string) {
    setSelectedName(newName)
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading...</div>
  }

  return (
    <div className="h-full flex">
      {/* List pane */}
      <div className="w-48 shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">
        <div className="px-4 pt-6 pb-3 border-b border-zinc-800 shrink-0 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-1.5">
            {Icon && <Icon size={16} className="shrink-0" />}
            {title}
          </h1>
          <button
            onClick={() => { setIsCreating(true); setSelectedName(null) }}
            className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            {primaryCta}
          </button>
        </div>

        {subtitle && (
          <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
            <p className="text-[11px] text-zinc-500 leading-snug">{subtitle}</p>
          </div>
        )}

        <nav className="flex-1 px-2 py-3">
          {allSkills.length === 0 ? (
            emptyStateBody ? (
              <div className="px-2 py-1">
                <p className="text-xs text-zinc-500">{emptyStateHeading}</p>
                <p className="text-[11px] text-zinc-600 mt-1 leading-snug">{emptyStateBody}</p>
              </div>
            ) : (
              <p className="px-2 text-xs text-zinc-500 py-1">{emptyStateHeading}</p>
            )
          ) : (
            allSkills.map(s => (
              <SkillEntry
                key={s.name}
                skill={s}
                selectedName={selectedName}
                onSelect={select}
              />
            ))
          )}
        </nav>
      </div>

      {/* Right panel */}
      {isCreating ? (
        <NewEntryForm
          kind={kind}
          onCancel={() => { setIsCreating(false) }}
          onCreate={handleCreated}
          apiClient={apiClient}
          listQueryKey={listQueryKey}
          createHeading={createHeading}
          createButtonLabel={createButtonLabel}
          createPendingLabel={createPendingLabel}
        />
      ) : selectedName ? (
        <EntryEditor
          key={selectedName}
          name={selectedName}
          onDeleted={handleDeleted}
          onRenamed={handleRenamed}
          apiClient={apiClient}
          listQueryKey={listQueryKey}
          detailQueryKey={detailQueryKey}
          deleteConfirm={deleteConfirm}
          kind={kind}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
          {placeholderBody}
        </div>
      )}
    </div>
  )
}
