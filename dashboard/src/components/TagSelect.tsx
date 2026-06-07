import React, { useState } from 'react'

// ─── TagSelect ────────────────────────────────────────────────────────────────
// Shared multi-value tag picker backed by a dropdown of options. Extracted from
// KindEditorPage.tsx (Phase 46 Plan 04 Task 1) for reuse across the Settings
// page (global allowlist editors) and head cards (per-head override pickers).

export function TagSelect({ values, onChange, options, placeholder, readOnly }: {
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
