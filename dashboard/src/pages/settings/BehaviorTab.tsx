import React from 'react'
import type { SettingsTabProps } from './draft'
import { Field } from './components'

export default function BehaviorTab({ d, set, isDeveloper, inputClass, selectClass }: SettingsTabProps) {
  return (
    <>
      {/* General */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">General</div>

        <Field label="Memory vs. History balance" tooltip="Splits the per-turn context budget between recalled memories and recent chat history. The history side is a real budget the head fills up to — raising it keeps more verbatim recent messages in context. The memory side is a CEILING the retriever rarely hits, since it pulls only what's relevant to the current query. Tune this when you want stronger long-term recall (raise %) or more verbatim recent chat (lower %). Default: 45/55.">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-zinc-500 w-16">Memory {d.memoryBudgetPercent}%</span>
            <input
              type="range"
              min={10}
              max={80}
              value={d.memoryBudgetPercent}
              onChange={e => set('memoryBudgetPercent', Number(e.target.value))}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="text-[11px] text-zinc-500 w-16 text-right">History {100 - d.memoryBudgetPercent}%</span>
          </div>
        </Field>

        <Field label="Context window ceiling" tooltip="Hard cap on total tokens assembled per turn (system + memory + history + output reserve). Acts as a SAFETY ceiling, not an operating budget — the retriever auto-scales below this and only approaches it on dense-recall turns. Raise it if those turns ever feel truncated; lower it to bound worst-case cost and latency. The Memory/History balance is what actually controls per-turn behavior. Default: 100,000.">
          <input
            type="number"
            min={10000}
            max={1000000}
            step={5000}
            value={d.contextWindowTokens}
            onChange={e => set('contextWindowTokens', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Retrieval context window" tooltip="Token budget for recent conversation history fed to the query rewriter before memory retrieval. Helps resolve vague references like 'that thing we discussed'. Higher values help with longer-range references but add a small cost per turn. 0 to disable. Default: 3,000.">
          <input
            type="number"
            min={0}
            max={50000}
            step={500}
            value={d.memoryQueryContextTokens}
            onChange={e => set('memoryQueryContextTokens', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Log level" tooltip="Controls how much detail appears in logs. Default: info.">
          <select value={d.logLevel} onChange={e => set('logLevel', e.target.value)} className={selectClass}>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </Field>

        <Field label="Agent continuation" tooltip="Let finished agents be resumed with follow-up instructions instead of starting fresh. They keep all their context from the original task. Default: on.">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.agentContinuationEnabled}
              onChange={e => set('agentContinuationEnabled', e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="text-sm text-zinc-300">{d.agentContinuationEnabled ? 'On' : 'Off'}</span>
          </label>
        </Field>

        <Field label="Usage footers" tooltip="Shows token counts and cost on each response. Default: off.">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.usageFootersEnabled}
              onChange={e => set('usageFootersEnabled', e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="text-sm text-zinc-300">{d.usageFootersEnabled ? 'On' : 'Off'}</span>
          </label>
        </Field>

        <Field label="Trace history tokens" tooltip="Token budget for recent conversation history included in each trace file. Traces are debug snapshots of LLM calls — higher values give more context but produce larger files. Default: 2,000.">
          <input
            type="number"
            min={0}
            max={50000}
            step={500}
            value={d.traceHistoryTokens}
            onChange={e => set('traceHistoryTokens', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>

      {/* Context & Archival */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Context & Archival</div>

        <Field label="Max output tokens" tooltip="Safety cap on how long a single model response can be. Normal responses never hit this — it's a guardrail for runaway output. Default: 16,384.">
          <input
            type="number"
            min={256}
            max={65536}
            step={256}
            value={d.llmMaxTokens}
            onChange={e => set('llmMaxTokens', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Archival threshold" tooltip="How full the conversation history can get before older messages are archived to long-term memory. Default: 80%.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={20}
              max={90}
              value={Math.round(d.archivalThresholdFraction * 100)}
              onChange={e => set('archivalThresholdFraction', Number(e.target.value) / 100)}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="text-xs text-zinc-400 w-10 text-right">{Math.round(d.archivalThresholdFraction * 100)}%</span>
          </div>
        </Field>

        <Field label="Context assembly budget" tooltip="Total budget for memory + history that gets packed into each turn. Default: 100,000.">
          <input
            type="number"
            min={10000}
            max={500000}
            step={10000}
            value={d.contextAssemblyTokenBudget}
            onChange={e => set('contextAssemblyTokenBudget', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>

      {/* Stewards */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Stewards</div>

        <Field label="Steward context budget" tooltip="How much conversation history stewards can see when making their decisions. Default: 10,000.">
          <input
            type="number"
            min={1000}
            max={50000}
            step={1000}
            value={d.stewardContextTokenBudget}
            onChange={e => set('stewardContextTokenBudget', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>

      {/* Loop Detection */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-zinc-300">Loop Detection</div>

        <Field label="Same-args trigger" tooltip="How many times an agent can make the exact same tool call in a row before it's flagged as stuck. Default: 3.">
          <input
            type="number"
            min={2}
            max={10}
            value={d.loopSameArgsTrigger}
            onChange={e => set('loopSameArgsTrigger', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Error trigger" tooltip="How many consecutive errors from the same tool before the loop detection steward is invoked. Default: 2.">
          <input
            type="number"
            min={1}
            max={10}
            value={d.loopErrorTrigger}
            onChange={e => set('loopErrorTrigger', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Post-nudge error trigger" tooltip="After the system tries to unstick an agent, how many more errors before giving up. Default: 1.">
          <input
            type="number"
            min={1}
            max={5}
            value={d.loopPostNudgeErrorTrigger}
            onChange={e => set('loopPostNudgeErrorTrigger', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Tool input chars" tooltip="How much of each tool call's input the loop detector sees. Just enough to spot repetition. Default: 200.">
          <input
            type="number"
            min={50}
            max={2000}
            step={50}
            value={d.loopStewardToolInputChars}
            onChange={e => set('loopStewardToolInputChars', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Tool result chars" tooltip="How much of each tool result the loop detector sees. Enough to tell if results are changing. Default: 300.">
          <input
            type="number"
            min={50}
            max={2000}
            step={50}
            value={d.loopStewardToolResultChars}
            onChange={e => set('loopStewardToolResultChars', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="System prompt chars" tooltip="How much of the system prompt the loop detector sees for context. Default: 500.">
          <input
            type="number"
            min={100}
            max={5000}
            step={100}
            value={d.loopStewardSystemPromptChars}
            onChange={e => set('loopStewardSystemPromptChars', Number(e.target.value))}
            className={inputClass}
          />
        </Field>

        <Field label="Max output tokens" tooltip="Response length for the loop detector. Only needs a few words. Default: 128.">
          <input
            type="number"
            min={32}
            max={512}
            step={32}
            value={d.loopStewardMaxTokens}
            onChange={e => set('loopStewardMaxTokens', Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  )
}
