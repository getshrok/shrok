// Live-layer checks: cheap list-models probes per configured LLM provider.
//
// These endpoints are free (no tokens consumed) but still prove the key
// works. Orchestrator skips all live checks when ctx.deep is false.

import type { Check, CheckOutcome, Ctx } from '../types.js'
import type { Config } from '../../config.js'

type ProviderName = 'anthropic' | 'openai' | 'gemini'

interface ProviderProbe {
  name: ProviderName
  configKey: keyof Config
  /** Returns the URL + RequestInit for this provider's list-models call. */
  build(key: string): { url: string; init: RequestInit }
  /** Host name used in the network-error hint. */
  host: string
}

const PROBES: Record<ProviderName, ProviderProbe> = {
  anthropic: {
    name: 'anthropic',
    configKey: 'anthropicApiKey',
    host: 'api.anthropic.com',
    build: key => ({
      url: 'https://api.anthropic.com/v1/models',
      init: {
        method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(5000),
      },
    }),
  },
  openai: {
    name: 'openai',
    configKey: 'openaiApiKey',
    host: 'api.openai.com',
    build: key => ({
      url: 'https://api.openai.com/v1/models',
      init: {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      },
    }),
  },
  gemini: {
    name: 'gemini',
    configKey: 'geminiApiKey',
    host: 'generativelanguage.googleapis.com',
    build: key => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      init: {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      },
    }),
  },
}

function buildProbeCheck(probe: ProviderProbe): Check {
  return {
    id: `live.${probe.name}`,
    title: `${probe.name} list-models probe`,
    layer: 'live',
    async run(ctx: Ctx): Promise<CheckOutcome> {
      if (!ctx.config) return { status: 'skip', detail: 'config did not load' }
      const key = ctx.config[probe.configKey] as string | undefined
      if (!key) {
        return { status: 'skip', detail: `${probe.name}: no key configured` }
      }
      const { url, init } = probe.build(key)
      try {
        const res = await ctx.fetch(url, init)
        if (res.status === 200) {
          return { status: 'ok', detail: `${probe.name} returned 200 from list-models` }
        }
        if (res.status === 401 || res.status === 403) {
          return {
            status: 'fail',
            detail: `${probe.name} returned ${res.status}`,
            hint: `API key rejected by ${probe.name} — verify it in the provider dashboard`,
          }
        }
        if (res.status >= 500) {
          return {
            status: 'warn',
            detail: `${probe.name} returned ${res.status}`,
            hint: `${probe.name} list-models returned ${res.status} — transient provider issue?`,
          }
        }
        return {
          status: 'warn',
          detail: `${probe.name} returned ${res.status}`,
          hint: `unexpected status from ${probe.name} list-models`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          status: 'warn',
          detail: `network error reaching ${probe.host}: ${msg}`,
          hint: `could not reach ${probe.host} — check network`,
        }
      }
    },
  }
}

/**
 * Build the provider probe suite for a given provider priority list. Order mirrors
 * the priority list; duplicates are dropped.
 */
export function buildProviderChecks(priority: ProviderName[]): Check[] {
  const seen = new Set<ProviderName>()
  const out: Check[] = []
  for (const p of priority) {
    if (seen.has(p)) continue
    seen.add(p)
    const probe = PROBES[p]
    if (probe) out.push(buildProbeCheck(probe))
  }
  return out
}
