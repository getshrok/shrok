import React from 'react'
import type { DraftState, SettingsTabProps } from './draft'
import { Field, ComboInput, ProviderCard } from './components'

const ANTHROPIC_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']
const GEMINI_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview']
const OPENAI_MODELS = ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-pro']
const TIER_OPTIONS = ['standard', 'capable', 'expert']

export default function ModelsTab({ d, s, set }: SettingsTabProps) {
  return (
    <>
      {/* Provider priority cards */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <span className="text-sm font-semibold text-zinc-300">Providers</span>
          <span className="text-[11px] text-zinc-500">Priority order — first configured provider is used, others are fallbacks</span>
        </div>
        {d.llmProviderPriority.map((providerName, idx) => {
          const providerLabel = providerName === 'anthropic' ? 'Anthropic' : providerName === 'gemini' ? 'Google Gemini' : 'OpenAI'
          const models = providerName === 'anthropic' ? ANTHROPIC_MODELS : providerName === 'gemini' ? GEMINI_MODELS : OPENAI_MODELS
          const keyField = `${providerName}ApiKey` as 'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'
          const isKeySet = s[keyField]?.isSet ?? false
          const pendingKey = d[keyField] as string | null
          const hasKey = pendingKey !== null ? pendingKey !== '' : isKeySet
          const stdField = `${providerName}ModelStandard` as keyof DraftState
          const capField = `${providerName}ModelCapable` as keyof DraftState
          const expField = `${providerName}ModelExpert` as keyof DraftState

          return (
            <ProviderCard
              key={providerName}
              name={providerName}
              label={providerLabel}
              index={idx}
              total={d.llmProviderPriority.length}
              hasKey={hasKey}
              isKeySet={isKeySet}
              pendingKey={pendingKey}
              onKeyChange={v => set(keyField, v)}
              models={models}
              standardModel={d[stdField] as string}
              capableModel={d[capField] as string}
              expertModel={d[expField] as string}
              onStandardChange={v => set(stdField, v)}
              onCapableChange={v => set(capField, v)}
              onExpertChange={v => set(expField, v)}

              onMoveUp={idx > 0 ? () => {
                const arr = [...d.llmProviderPriority]
                ;[arr[idx - 1], arr[idx]] = [arr[idx]!, arr[idx - 1]!]
                set('llmProviderPriority', arr)
              } : undefined}
              onMoveDown={idx < d.llmProviderPriority.length - 1 ? () => {
                const arr = [...d.llmProviderPriority]
                ;[arr[idx], arr[idx + 1]] = [arr[idx + 1]!, arr[idx]!]
                set('llmProviderPriority', arr)
              } : undefined}
              onRemove={d.llmProviderPriority.length > 1 ? () => {
                set('llmProviderPriority', d.llmProviderPriority.filter((_, i) => i !== idx))
              } : undefined}
            />
          )
        })}
        {/* Add provider button */}
        {(() => {
          const ALL_PROVIDERS = [
            { id: 'anthropic', label: 'Anthropic' },
            { id: 'gemini', label: 'Google Gemini' },
            { id: 'openai', label: 'OpenAI' },
          ] as const
          const available = ALL_PROVIDERS.filter(p => !d.llmProviderPriority.includes(p.id))
          if (available.length === 0) return null
          return (
            <div className="flex gap-2 items-center px-1">
              <span className="text-xs text-zinc-500">Add:</span>
              {available.map(p => (
                <button
                  key={p.id}
                  onClick={() => set('llmProviderPriority', [...d.llmProviderPriority, p.id])}
                  className="px-2.5 py-1 text-xs rounded-md border border-dashed border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  + {p.label}
                </button>
              ))}
            </div>
          )
        })()}
      </div>

      {/* Role Models card */}
      {(() => {
        const primaryProvider = d.llmProviderPriority[0] ?? 'anthropic'
        const providerModels = primaryProvider === 'anthropic' ? ANTHROPIC_MODELS
          : primaryProvider === 'gemini' ? GEMINI_MODELS
          : OPENAI_MODELS
        const roleOpts = [...TIER_OPTIONS, ...providerModels]
        return (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="text-sm font-semibold text-zinc-300">Role Models</div>
            <p className="text-xs text-zinc-500">Each role accepts a tier name (<span className="font-mono">standard</span>, <span className="font-mono">capable</span>, <span className="font-mono">expert</span>) or a direct model ID.</p>
            <Field label="Head (main conversation)" tooltip="The model you talk to. Runs on every message, agent completion, and scheduled event. Handles conversation and decides when to hand work off to agents.">
              <ComboInput value={d.headModel} onChange={v => set('headModel', v)} options={roleOpts} />
            </Field>
            <Field label="Agent (spawned workers)" tooltip="The default model for agents that do work in the background. Individual tasks can override this.">
              <ComboInput value={d.agentModel} onChange={v => set('agentModel', v)} options={roleOpts} />
            </Field>
            <Field label="Steward (loop detection, nudges)" tooltip="Small, cheap model calls that run between turns — catching missed actions, filtering output, and keeping things on track. Runs often, so keep this on a fast cheap model.">
              <ComboInput value={d.stewardModel} onChange={v => set('stewardModel', v)} options={roleOpts} />
            </Field>
            <Field label="Memory — chunking (topic segmentation)" tooltip="Segments archived conversation into topic-coherent chunks, picks labels, and extracts entities. Runs on every archival pass and determines how memory is organized — errors here affect retrieval quality long-term, so a more capable model pays off.">
              <ComboInput value={d.memoryChunkingModel} onChange={v => set('memoryChunkingModel', v)} options={roleOpts} />
            </Field>
            <Field label="Memory — archival (summary compression)" tooltip="Compresses aged chunks within a topic into dense prose summaries to keep topic size bounded. Runs only when a topic exceeds its threshold — much less frequent than chunking, and more forgiving, so a cheaper model is usually fine.">
              <ComboInput value={d.memoryArchivalModel} onChange={v => set('memoryArchivalModel', v)} options={roleOpts} />
            </Field>
            <Field label="Memory — retrieval (topic ranking)" tooltip="Picks which past conversations are relevant to what you're talking about right now. Runs every turn.">
              <ComboInput value={d.memoryRetrievalModel} onChange={v => set('memoryRetrievalModel', v)} options={roleOpts} />
            </Field>
          </div>
        )
      })()}

    </>
  )
}
