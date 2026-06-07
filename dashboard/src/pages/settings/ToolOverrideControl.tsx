import React from 'react'
import { TagSelect } from '../../components/TagSelect'

// ─── Mode helpers (exported for unit testing) ─────────────────────────────────

/** Map a raw tri-state override value to a UI mode. */
export function modeForValue(
  value: string[] | null | '__inherit__' | undefined
): 'inherit' | 'all' | 'subset' {
  if (value === undefined || value === '__inherit__') return 'inherit'
  if (value === null) return 'all'
  return 'subset'
}

/** Map a UI mode back to the wire value sent to the API. */
export function valueForMode(
  mode: 'inherit' | 'all' | 'subset',
  subset: string[]
): string[] | null | '__inherit__' {
  if (mode === 'inherit') return '__inherit__'
  if (mode === 'all') return null
  return subset
}

// ─── GlobalToolControl (2-mode: All / Subset) ─────────────────────────────────
// Used for the global head-tool and agent-tool defaults in the Settings Behavior
// tab. The global layer has no "inherit" state — it IS the base. Only two modes:
// "All tools" (value === null) and "Choose subset" (value is string[]).

interface GlobalToolControlProps {
  value: string[] | null
  onChange: (v: string[] | null) => void
  options: string[]
}

export function GlobalToolControl({ value, onChange, options }: GlobalToolControlProps) {
  const mode: 'all' | 'subset' = value === null ? 'all' : 'subset'

  function setMode(next: 'all' | 'subset') {
    if (next === 'all') onChange(null)
    else onChange([])
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setMode('all')}
          className={`px-3 py-1 text-xs rounded-md border transition-colors ${
            mode === 'all'
              ? 'bg-[var(--accent)] border-[var(--accent)]/50 text-white'
              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
          }`}
        >
          All tools
        </button>
        <button
          type="button"
          onClick={() => setMode('subset')}
          className={`px-3 py-1 text-xs rounded-md border transition-colors ${
            mode === 'subset'
              ? 'bg-[var(--accent)] border-[var(--accent)]/50 text-white'
              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
          }`}
        >
          Choose subset
        </button>
      </div>
      {mode === 'subset' && (
        <TagSelect
          values={value ?? []}
          onChange={onChange}
          options={options}
          placeholder="Pick tools…"
        />
      )}
    </div>
  )
}

// ─── HeadToolOverrideControl (3-mode: Inherit / All / Subset) ─────────────────
// Used on each head card to configure per-head tool overrides. Three explicit,
// visually-distinct modes per TOOLCFG-09:
//   Inherit global — key absent → use the global default (the safe non-action)
//   All tools     — null → all tools regardless of the global default
//   Choose subset — string[] → only those tools

interface HeadToolOverrideControlProps {
  value: string[] | null | '__inherit__' | undefined
  onChange: (v: string[] | null | '__inherit__') => void
  options: string[]
}

export function HeadToolOverrideControl({
  value,
  onChange,
  options,
}: HeadToolOverrideControlProps) {
  const mode = modeForValue(value)
  // Keep a local subset buffer so switching back to subset restores the last
  // chosen tags instead of losing them.
  const [subset, setSubset] = React.useState<string[]>(
    Array.isArray(value) ? value : []
  )

  function setMode(next: 'inherit' | 'all' | 'subset') {
    if (next === 'inherit') {
      onChange('__inherit__')
    } else if (next === 'all') {
      onChange(null)
    } else {
      // Switching to subset: emit current subset buffer
      onChange(subset)
    }
  }

  function handleSubsetChange(tags: string[]) {
    setSubset(tags)
    onChange(tags)
  }

  const modeButtonClass = (active: boolean) =>
    `px-3 py-1 text-xs rounded-md border transition-colors ${
      active
        ? 'bg-[var(--accent)] border-[var(--accent)]/50 text-white'
        : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
    }`

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => setMode('inherit')}
          className={modeButtonClass(mode === 'inherit')}
          title="Use the global default from Settings → Behavior"
        >
          Inherit global
        </button>
        <button
          type="button"
          onClick={() => setMode('all')}
          className={modeButtonClass(mode === 'all')}
        >
          All tools
        </button>
        <button
          type="button"
          onClick={() => setMode('subset')}
          className={modeButtonClass(mode === 'subset')}
        >
          Choose subset
        </button>
      </div>
      {mode === 'inherit' && (
        <p className="text-xs text-zinc-500">Uses the global default — change it in Settings → Behavior.</p>
      )}
      {mode === 'subset' && (
        <TagSelect
          values={subset}
          onChange={handleSubsetChange}
          options={options}
          placeholder="Pick tools…"
        />
      )}
    </div>
  )
}
