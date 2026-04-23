import React, { useRef } from 'react'
import type { Mode } from '../../context/ModeContext'
import type { DraftState } from './draft'
import { useAssistantName } from '../../lib/assistant-name'
import { useTheme } from '../../lib/theme'
import { Field, SettingTooltip } from './components'

const MODES: { value: Mode; label: string; description: string }[] = [
  { value: 'standard',  label: 'Standard',     description: 'Everything you need for everyday use.' },
  { value: 'developer', label: 'Development',  description: 'Adds extra tools for development and debugging.' },
]

const developerWarning = (name: string) =>
  `Development mode exposes tools for running tests and evals, ` +
  `deep debug output, and other things that can cost money or have side effects.\n\n` +
  `Only enable this if you're working on ${name} itself or know what you're doing.`

function formatTimezoneHelper(tz: string): string {
  const trimmed = tz.trim()
  if (trimmed === '') return 'Required — enter an IANA timezone name.'
  try {
    // Intl.DateTimeFormat throws RangeError for invalid IANA zones — no other runtime cost
    const test = new Intl.DateTimeFormat('en-US', { timeZone: trimmed, timeZoneName: 'short' })
    const formatted = test.format(new Date())
    // Extract the trailing timezone abbreviation from the formatted output
    const match = /(GMT[+-]\d+(?::\d+)?|UTC[+-]\d+|[A-Z]{2,5})$/.exec(formatted)
    const offset = match ? match[0] : 'valid'
    return `Resolved: ${offset}`
  } catch {
    return 'Invalid IANA timezone — see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
  }
}

export default function GeneralTab({ draftMode, onSetMode, d, set }: { draftMode: Mode; onSetMode: (m: Mode) => void; d?: DraftState; set?: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void }) {
  const assistantName = useAssistantName()
  const { logoUrl } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !set) return
    const reader = new FileReader()
    reader.onload = () => { set('logoDataUrl', reader.result as string) }
    reader.readAsDataURL(file)
  }
  return (
    <>
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
      <div className="text-sm font-semibold text-zinc-300 px-1 pb-2.5 flex items-center">Mode<SettingTooltip text="Standard mode is for everyday use. Development mode adds extra tools for development and debugging." /></div>
      <div className="grid grid-cols-2 gap-2">
        {MODES.map(({ value, label, description }) => {
          const selected = draftMode === value
          const isDev = value === 'developer'
          return (
            <button
              key={value}
              onClick={() => onSetMode(value)}
              className={`text-left px-3 py-3 rounded-lg border transition-colors ${
                selected
                  ? isDev
                    ? 'bg-amber-950/50 border-amber-800/60'
                    : 'bg-zinc-800 border-zinc-600'
                  : 'bg-zinc-900/60 border-zinc-800 hover:bg-zinc-800/60 hover:border-zinc-700'
              }`}
            >
              <div className={`text-sm font-medium ${selected ? (isDev ? 'text-amber-300' : 'text-zinc-100') : 'text-zinc-400'}`}>
                {label}
              </div>
              <div className={`text-[11px] mt-1 leading-snug ${selected ? (isDev ? 'text-amber-500/70' : 'text-zinc-400') : 'text-zinc-500'}`}>
                {description}
              </div>
            </button>
          )
        })}
      </div>
    </div>

    {d && set && (() => {
      const categories: Array<{ key: 'visAgentWork' | 'visHeadTools' | 'visSystemEvents' | 'visStewardRuns' | 'visAgentPills' | 'visMemoryRetrievals'; label: string; tooltip: string }> = [
        { key: 'visAgentWork',        label: 'Agent work',             tooltip: "See what agents are doing as they work — which tools they call and what comes back. In chat apps, tool calls start collapsed. Add any reaction to expand, remove it to collapse." },
        { key: 'visHeadTools',        label: 'Head tool activity',     tooltip: "See when agents are being created, messaged, or cancelled behind the scenes." },
        { key: 'visSystemEvents',     label: 'System events',          tooltip: "See system-level activity like agent completions, scheduled task triggers, and internal nudges." },
        { key: 'visStewardRuns',      label: 'Steward runs',           tooltip: "See the behind-the-scenes decisions stewards made on each turn — what they checked and whether they acted." },
        { key: 'visAgentPills',       label: 'Agent stream selector',  tooltip: "Adds a row of pills at the top of the conversation for switching between the main view and individual agent work streams." },
        { key: 'visMemoryRetrievals', label: 'Memory retrievals',      tooltip: "See which past conversations were pulled from memory to inform each response." },
      ]
      return (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="text-sm font-semibold text-zinc-300 flex items-center">Conversation detail<SettingTooltip text="What shows up in the conversation besides your messages and responses. Everything off gives you a clean chat view." /></div>
          {categories.map(c => (
            <Field key={c.key} label={c.label} tooltip={c.tooltip}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={d[c.key]}
                  onChange={e => set(c.key, e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                <span className="text-sm text-zinc-300">{d[c.key] ? 'On' : 'Off'}</span>
              </label>
            </Field>
          ))}
        </div>
      )
    })()}

    {d && set && (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Appearance</div>

        <Field label="Accent color" tooltip="The accent color used throughout the dashboard — buttons, active indicators, message bubbles.">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={d.accentColor}
              onChange={e => set('accentColor', e.target.value)}
              className="w-8 h-8 rounded border border-zinc-700 cursor-pointer bg-transparent"
            />
            <span className="text-[11px] text-zinc-500 font-mono">{d.accentColor}</span>
          </div>
        </Field>

        <Field label="Logo" tooltip="Custom image for the sidebar and favicon. Any browser-supported image format (PNG, JPG, SVG, WebP, etc.).">
          <div className="flex items-center gap-3">
            <img src={d.logoDataUrl || logoUrl} alt="" className="w-8 h-8 rounded border border-zinc-700" />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-[11px] font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded border border-zinc-700 transition-colors"
            >
              Choose image
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
            {d.logoDataUrl && <span className="text-[11px] text-zinc-500">New logo selected</span>}
          </div>
        </Field>
      </div>
    )}

    {d && set && (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Scheduling</div>

        <Field label="Timezone" tooltip="IANA timezone used for scheduled tasks and reminders. The cron expressions you (and agents) create are interpreted in this zone. Example: America/New_York, Europe/London, Asia/Tokyo.">
          <div className="space-y-1">
            <input
              type="text"
              value={d.timezone}
              onChange={e => set('timezone', e.target.value)}
              placeholder="America/New_York"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-600 outline-none font-mono"
              aria-label="IANA timezone"
            />
            <div className="text-[11px] text-zinc-500">
              {formatTimezoneHelper(d.timezone)}
            </div>
          </div>
        </Field>
      </div>
    )}
    </>
  )
}

export { MODES, developerWarning }
