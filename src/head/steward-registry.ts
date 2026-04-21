/**
 * Steward registry — single source of truth for user-facing steward toggles.
 *
 * Adding a new steward:
 *   1. Add its config flag to src/config.ts
 *   2. Gate the call site with the flag
 *   3. Add a descriptor entry here
 *   4. Mirror the entry in dashboard/src/pages/settings/stewards-registry.ts
 *
 * The dashboard's StewardsTab and draft helpers iterate this list, so adding
 * a steward updates the UI automatically.
 */

import type { Config } from '../config.js'

export interface StewardDescriptor {
  /** Stable ID (used for React keys) */
  id: string
  /** Key in Config — must match the boolean flag in src/config.ts */
  configKey: keyof Config
  /** Short title for the UI card */
  label: string
  /** One-sentence description shown as tooltip/subtitle */
  description: string
  /** Default state for new installs */
  defaultOn: boolean
  /** Optional paired sub-setting (context token budget, etc.) */
  contextTokensKey?: keyof Config
  /** Min/max/default for the context token sub-setting */
  contextTokensRange?: { min: number; max: number; step: number; default: number }
  /** Show experimental badge in the UI */
  experimental?: boolean
}

export const STEWARDS: StewardDescriptor[] = [
  // ── Stable ──
  {
    id: 'workSummary',
    configKey: 'relaySummary',
    label: 'Work summaries',
    description: 'Summarizes what an agent did before reporting back. When off, the head sees the raw tool history instead.',
    defaultOn: true,
  },
  {
    id: 'scheduledRelay',
    configKey: 'scheduledRelayStewardEnabled',
    label: 'Task output filter',
    description: "Decides whether a scheduled task's output is worth telling you about. Quiet runs get silently logged instead.",
    defaultOn: true,
  },
  {
    id: 'spawnAgent',
    configKey: 'spawnAgentStewardEnabled',
    label: 'Nested spawn guard',
    description: 'When nested agent spawning is on, checks whether a child agent is really needed or if the parent could do the work itself.',
    defaultOn: true,
  },
  {
    id: 'headRelay',
    configKey: 'headRelaySteward',
    label: 'Message polish',
    description: "Rewrites outgoing messages so they say 'I' instead of referencing agents and internal systems.",
    defaultOn: false,
    contextTokensKey: 'headRelayStewardContextTokens',
    contextTokensRange: { min: 100, max: 10000, step: 100, default: 2000 },
  },
  {
    id: 'bootstrap',
    configKey: 'bootstrapStewardEnabled',
    label: 'Onboarding',
    description: 'Makes sure first-time setup completes — saving your profile and personality before moving on.',
    defaultOn: true,
  },
  {
    id: 'preference',
    configKey: 'preferenceStewardEnabled',
    label: 'Preference capture',
    description: "Nudges the assistant to save facts and preferences you mention into USER.md and SOUL.md, so it doesn't lose track of details you shared in passing.",
    defaultOn: true,
  },
  // ── Experimental ──
  {
    id: 'routing',
    configKey: 'routingStewardEnabled',
    label: 'Routing',
    description: 'Suggests the best approach for each message before the head responds. Usually not needed — the head already has routing built in.',
    defaultOn: false,
    experimental: true,
  },
  {
    id: 'resume',
    configKey: 'resumeStewardEnabled',
    label: 'Resume validation',
    description: 'Checks that answers to paused agents actually answer the question before passing them along.',
    defaultOn: true,
    experimental: true,
    contextTokensKey: 'resumeStewardContextTokens',
    contextTokensRange: { min: 500, max: 20000, step: 500, default: 4000 },
  },
  {
    id: 'messageAgent',
    configKey: 'messageAgentStewardEnabled',
    label: 'Check-in guard',
    description: 'Prevents the head from impatiently checking in on agents that are still working.',
    defaultOn: false,
    experimental: true,
  },
  {
    id: 'spawn',
    configKey: 'spawnStewardEnabled',
    label: 'Spawn commitment',
    description: "Catches cases where the assistant says it will do something but forgets to actually spawn an agent for it.",
    defaultOn: false,
    experimental: true,
  },
  {
    id: 'actionCompliance',
    configKey: 'actionComplianceStewardEnabled',
    label: 'Action compliance',
    description: "Flags missed spawns, made-up real-world facts, and answers the assistant computed itself when it should have delegated.",
    defaultOn: false,
    experimental: true,
  },
  {
    id: 'contextRelevance',
    configKey: 'contextRelevanceStewardEnabled',
    label: 'Context trimming',
    description: 'Filters out irrelevant older conversation before each response. Keeps things relevant and saves on token cost.',
    defaultOn: false,
    experimental: true,
  },
]
