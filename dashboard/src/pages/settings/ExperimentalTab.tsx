import React from 'react'
import type { DraftState, SettingsTabProps } from './draft'
import { Field, StewardCard } from './components'
import { STEWARDS } from './stewards-registry'

export default function ExperimentalTab({ d, set, inputClass }: SettingsTabProps) {
  const experimentalStewards = STEWARDS.filter(s => s.experimental)
  return (
    <>
      <div className="text-xs text-zinc-500 px-1 -mb-2">
        Features in this tab are still being refined — behavior may change, and defaults are tuned conservatively. Enable them if they solve a specific problem you're hitting; leave them off otherwise.
      </div>

      {/* Agent behavior */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Agent behavior</div>

        <Field label="Nested agent spawning" tooltip="Let agents spawn their own child agents (one level deep). When off, only the head can create agents. Default: off.">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.nestedAgentSpawningEnabled}
              onChange={e => set('nestedAgentSpawningEnabled', e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="text-sm text-zinc-300">{d.nestedAgentSpawningEnabled ? 'On' : 'Off'}</span>
          </label>
        </Field>
      </div>

      {/* Experimental stewards */}
      {experimentalStewards.length > 0 && (
        <>
          <div className="text-sm font-semibold text-zinc-300 pt-2">Experimental stewards</div>
          {experimentalStewards.map(steward => (
            <StewardCard
              key={steward.id}
              steward={steward}
              enabled={d[steward.configKey] as boolean}
              contextTokens={steward.contextTokensKey ? d[steward.contextTokensKey] as number : undefined}
              onToggle={v => set(steward.configKey, v as DraftState[typeof steward.configKey])}
              onContextTokensChange={steward.contextTokensKey
                ? (v: number) => set(steward.contextTokensKey!, v as DraftState[NonNullable<typeof steward.contextTokensKey>])
                : undefined}
              showExperimentalBadge={false}
              inputClass={inputClass}
            />
          ))}
        </>
      )}
    </>
  )
}
