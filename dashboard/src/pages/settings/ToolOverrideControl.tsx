import React from 'react'
import { TagSelect } from '../../components/TagSelect'

// ─── Mode helpers (exported for unit testing) ─────────────────────────────────

/** Map a raw two-state override value to a UI mode.
 *
 *  '__inherit__' / undefined  → 'inherit'
 *  string[] (including empty) → 'subset'
 *
 *  Legacy-null: a null arriving from old config is treated as 'inherit' (the
 *  safe non-action — the head reads the global default) rather than a broken
 *  "all-tools" state that no longer exists in the two-state model.
 */
export function modeForValue(
  value: string[] | null | '__inherit__' | undefined
): 'inherit' | 'subset' {
  if (value === undefined || value === '__inherit__') return 'inherit'
  if (value === null) return 'inherit' // legacy null → inherit (see note above)
  return 'subset'
}

/** Map a UI mode back to the wire value sent to the API. */
export function valueForMode(
  mode: 'inherit' | 'subset',
  subset: string[]
): string[] | '__inherit__' {
  if (mode === 'inherit') return '__inherit__'
  return subset
}

// ─── GlobalToolControl (subset-only) ──────────────────────────────────────────
// Used for the global head-tool and agent-tool defaults in the Settings Behavior
// tab. The global layer has no "inherit" state — it IS the base. The value is
// always a concrete subset (string[]); checking every available option is
// equivalent to enabling everything that layer can run.

interface GlobalToolControlProps {
  value: string[]
  onChange: (v: string[]) => void
  options: string[]
}

export function GlobalToolControl({ value, onChange, options }: GlobalToolControlProps) {
  return (
    <div className="space-y-2">
      <TagSelect
        values={value}
        onChange={onChange}
        options={options}
        placeholder="Pick tools…"
      />
    </div>
  )
}

// ─── HeadToolOverrideControl (2-mode: Inherit global / Custom subset) ─────────
// Used on each head card to configure per-head tool overrides. Two explicit,
// visually-distinct modes per TOOLCFG-09 (D-04):
//   Inherit global — key absent → use the global default (the safe non-action)
//   Custom subset  — string[]  → only those tools

interface HeadToolOverrideControlProps {
  value: string[] | '__inherit__' | undefined
  onChange: (v: string[] | '__inherit__') => void
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

  // WR-05: re-sync the local buffer whenever the controlled `value` prop changes
  // to a new array (e.g. after a save/refetch hands down the persisted DTO, or a
  // concurrent edit). Without this the TagSelect renders stale tags because the
  // buffer was only seeded once at mount, and a subsequent save would push that
  // stale buffer back to the server. We compare contents (not identity) so a
  // re-render with an equal-but-new array does not clobber an in-flight edit.
  React.useEffect(() => {
    if (Array.isArray(value)) {
      setSubset(prev =>
        prev.length === value.length && prev.every((t, i) => t === value[i]) ? prev : value
      )
    }
  }, [value])

  function setMode(next: 'inherit' | 'subset') {
    if (next === 'inherit') {
      onChange('__inherit__')
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
          onClick={() => setMode('subset')}
          className={modeButtonClass(mode === 'subset')}
        >
          Custom subset
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
