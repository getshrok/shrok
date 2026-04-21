import React from 'react'
import type { DraftState, SettingsTabProps } from './draft'
import { StewardCard } from './components'
import { STEWARDS } from './stewards-registry'

export default function StewardsTab({ d, set, inputClass }: SettingsTabProps) {
  const stableStewards = STEWARDS.filter(s => !s.experimental)
  return (
    <>
      <div className="text-xs text-zinc-500 px-1 -mb-2">
        Stewards are lightweight LLM checks that run at specific points in the message flow. Each has its own purpose, cost, and risk of false positives. Toggle off any that misbehave. Experimental stewards live in the Experimental tab.
      </div>
      {stableStewards.map(steward => (
        <StewardCard
          key={steward.id}
          steward={steward}
          enabled={d[steward.configKey] as boolean}
          contextTokens={steward.contextTokensKey ? d[steward.contextTokensKey] as number : undefined}
          onToggle={v => set(steward.configKey, v as DraftState[typeof steward.configKey])}
          onContextTokensChange={steward.contextTokensKey
            ? (v: number) => set(steward.contextTokensKey!, v as DraftState[NonNullable<typeof steward.contextTokensKey>])
            : undefined}
          showExperimentalBadge={true}
          inputClass={inputClass}
        />
      ))}
    </>
  )
}
