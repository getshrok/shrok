import type { Config } from './config.js'

/**
 * Set process.env.TZ to the configured IANA timezone.
 *
 * Call this ONCE at startup, right after loadConfig() and before any
 * spawning or heavy Date work. Startup-only — no live update (DECISION 2).
 */
export function applyTimezoneEnv(config: Pick<Config, 'timezone'>): void {
  process.env['TZ'] = config.timezone
}
