import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Info, FlaskConical, ChevronUp, ChevronDown, ChevronRight, Check, X, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

// ---- Tooltip ----

export function SettingTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useEffect(() => {
    if (!show) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      setShow(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [show])

  const handleToggle = () => {
    if (!show && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setPos({
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
      })
    }
    setShow(!show)
  }

  return (
    <span className="inline-flex items-center ml-1.5">
      <button
        ref={ref}
        onClick={handleToggle}
        className="text-zinc-500 hover:text-zinc-300 transition-colors"
        aria-label="More info"
      >
        <Info size={14} />
      </button>
      {show && createPortal(
        <div
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
          className="fixed z-[9999] w-64 px-3 py-2 text-xs leading-relaxed text-zinc-300 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl"
        >
          {text}
          <div className="absolute top-1/2 -translate-y-1/2 right-full w-2 h-2 bg-zinc-800 border-l border-b border-zinc-700 rotate-45 -mr-1" />
        </div>,
        document.body,
      )}
    </span>
  )
}

// ---- Experimental badge ----

export function ExperimentalBadge() {
  return (
    <span className="inline-flex items-center ml-1.5 cursor-pointer" title="Experimental — may not be fully reliable yet">
      <FlaskConical size={13} className="text-amber-500/70" />
    </span>
  )
}

// ---- ComboInput ----

export function ComboInput({ value, onChange, options, placeholder, disabled }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlighted, setHighlighted] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Only filter when the user has typed something; otherwise show all options
  const filtered = filter ? options.filter(o => o.toLowerCase().includes(filter.toLowerCase())) : options

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) { setOpen(false); setFilter('') }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(h => Math.min(h + 1, filtered.length - 1))
      setOpen(true)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && filtered[highlighted]) {
        onChange(filtered[highlighted])
        setFilter('')
        setOpen(false)
        setHighlighted(-1)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      setFilter('')
      setHighlighted(-1)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={filter !== '' ? filter : value}
        onChange={e => { setFilter(e.target.value); onChange(e.target.value); setOpen(true); setHighlighted(-1) }}
        onFocus={() => { setFilter(''); setOpen(true) }}
        onBlur={() => { setFilter('') }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg max-h-48 overflow-y-auto z-50">
          {filtered.map((opt, i) => (
            <div
              key={opt}
              className={`px-3 py-1.5 text-sm cursor-pointer ${i === highlighted ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-700/50'}`}
              onMouseDown={e => { e.preventDefault(); onChange(opt); setFilter(''); setOpen(false); setHighlighted(-1) }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- SecretInput ----
// pending=null -> no change; pending=string -> user has typed a new value (may be '' to clear)

export function SecretInput({ isSet, pending, onPendingChange }: {
  isSet: boolean
  pending: string | null
  onPendingChange: (v: string | null) => void
}) {
  if (pending !== null) {
    return (
      <div className="flex gap-2">
        <input
          type="password"
          value={pending}
          onChange={e => onPendingChange(e.target.value)}
          placeholder={isSet ? 'New value (leave empty to clear)' : 'Enter value'}
          autoFocus
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
        />
        <button
          onClick={() => onPendingChange(null)}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex gap-2 items-center">
      <div className="flex-1 text-sm bg-zinc-800/50 border border-zinc-700 rounded-md px-3 py-1.5">
        {isSet
          ? <span className="text-zinc-500 tracking-widest">••••••••</span>
          : <span className="text-zinc-500 italic text-xs">not set</span>
        }
      </div>
      <button
        onClick={() => onPendingChange('')}
        className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
      >
        {isSet ? 'Replace' : 'Set'}
      </button>
    </div>
  )
}

// ---- Steward card ----
// Shared renderer used by StewardsTab and ExperimentalTab so the on/off toggle
// plus optional context-tokens sub-input stay in one place.

export function StewardCard({ steward, enabled, contextTokens, onToggle, onContextTokensChange, showExperimentalBadge, inputClass }: {
  steward: {
    id: string
    label: string
    description: string
    experimental?: boolean
    contextTokensKey?: string
    contextTokensRange?: { min: number; max: number; step: number }
  }
  enabled: boolean
  contextTokens?: number
  onToggle: (v: boolean) => void
  onContextTokensChange?: (v: number) => void
  showExperimentalBadge: boolean
  inputClass: string
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
      <Field label={<>{steward.label}{showExperimentalBadge && steward.experimental && <ExperimentalBadge />}</>} tooltip={steward.description}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onToggle(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span className="text-sm text-zinc-300">{enabled ? 'On' : 'Off'}</span>
        </label>
      </Field>
      {steward.contextTokensKey && steward.contextTokensRange && enabled && onContextTokensChange && (
        <Field label="Context token budget" tooltip="How many tokens of recent conversation this steward sees when making its decision.">
          <input
            type="number"
            min={steward.contextTokensRange.min}
            max={steward.contextTokensRange.max}
            step={steward.contextTokensRange.step}
            value={contextTokens ?? 0}
            onChange={e => onContextTokensChange(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      )}
    </div>
  )
}

// ---- Field row helper ----

export function Field({ label, tooltip, children }: { label: React.ReactNode; tooltip?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center text-xs text-zinc-500 mb-1">{label}{tooltip && <SettingTooltip text={tooltip} />}</label>
      {children}
    </div>
  )
}

// ---- Provider card ----

export function ProviderCard({ name, label, index, total, hasKey, isKeySet, pendingKey, onKeyChange,
  models, standardModel, capableModel, expertModel, onStandardChange, onCapableChange, onExpertChange,
  onMoveUp, onMoveDown, onRemove,
}: {
  name: string
  label: string
  index: number
  total: number
  hasKey: boolean
  isKeySet: boolean
  pendingKey: string | null
  onKeyChange: (v: string | null) => void
  models: string[]
  standardModel: string
  capableModel: string
  expertModel: string
  onStandardChange: (v: string) => void
  onCapableChange: (v: string) => void
  onExpertChange: (v: string) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onRemove?: () => void
}) {
  const [expanded, setExpanded] = useState(index === 0 || hasKey)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; model?: string; latencyMs?: number; error?: string } | null>(null)

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.settings.testProvider(name, pendingKey ?? undefined)
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const brandColor = name === 'anthropic' ? '#d97757' : name === 'gemini' ? '#078EFA' : name === 'openai' ? '#10A37F' : null

  return (
    <div className="rounded-xl overflow-hidden" style={{
      background: brandColor ? `color-mix(in srgb, ${brandColor} 5%, rgb(24 24 27 / 0.6))` : undefined,
      border: brandColor ? `1px solid color-mix(in srgb, ${brandColor} 70%, transparent)` : '1px solid rgb(39 39 42)',
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[11px] font-bold text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5 shrink-0">
          {index + 1}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasKey ? 'bg-green-500' : 'bg-zinc-700'}`} />
        <span className="text-sm font-medium flex-1 text-left" style={{ color: brandColor ?? '#e4e4e7' }}>{label}</span>
        {/* Priority arrows + remove */}
        <span className="flex gap-0.5 items-center" onClick={e => e.stopPropagation()}>
          <button
            onClick={onMoveUp}
            disabled={!onMoveUp}
            className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 disabled:cursor-default transition-colors"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={!onMoveDown}
            className="p-0.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-20 disabled:cursor-default transition-colors"
          >
            <ChevronDown size={14} />
          </button>
          {onRemove && (
            <button
              onClick={onRemove}
              className="p-0.5 ml-1 text-zinc-700 hover:text-red-400 transition-colors"
              title="Remove provider"
            >
              <X size={14} />
            </button>
          )}
        </span>
        <ChevronRight size={14} className={`text-zinc-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-800/50">
          <div className="pt-3">
            <Field label="API Key">
              <SecretInput isSet={isKeySet} pending={pendingKey} onPendingChange={onKeyChange} />
            </Field>
          </div>

          <Field label="Standard model (fast, inexpensive)">
            <ComboInput value={standardModel} onChange={onStandardChange} options={models} />
          </Field>
          <Field label="Capable model (balanced)">
            <ComboInput value={capableModel} onChange={onCapableChange} options={models} />
          </Field>
          <Field label="Expert model (most capable)">
            <ComboInput value={expertModel} onChange={onExpertChange} options={models} />
          </Field>

          {/* Test button */}
          <div className="flex items-center gap-2">
            <button
              onClick={runTest}
              disabled={testing || !hasKey}
              className="px-3 py-1.5 text-xs rounded-md border border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {testing ? (
                <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Testing...</span>
              ) : 'Test Connection'}
            </button>
            {testResult && (
              testResult.ok ? (
                <span className="flex items-center gap-1 text-xs text-green-400">
                  <Check size={12} /> {testResult.latencyMs}ms
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-400">
                  <X size={12} /> {testResult.error?.slice(0, 60)}
                </span>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
