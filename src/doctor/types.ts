// Type definitions for the `shrok doctor` health-check subsystem.
//
// The orchestrator owns id/title/layer/durationMs; each Check.run returns only
// the dynamic parts (status + detail/hint) so individual check files stay small.

import type { Config } from '../config.js'

export type Status = 'ok' | 'warn' | 'fail' | 'skip'
export type Layer = 'process' | 'config' | 'creds' | 'live'

export interface CheckResult {
  id: string
  title: string
  layer: Layer
  status: Status
  detail?: string
  hint?: string
  durationMs: number
}

export type CheckOutcome = Pick<CheckResult, 'status'> & Partial<Pick<CheckResult, 'detail' | 'hint'>>

export interface Check {
  id: string
  title: string
  layer: Layer
  run(ctx: Ctx): Promise<CheckOutcome>
}

export interface Ctx {
  /** null when loadConfig threw — see configError for the reason. */
  config: Config | null
  configError: Error | null
  deep: boolean
  fetch: typeof fetch
  fs: typeof import('node:fs')
  now: () => number
}
