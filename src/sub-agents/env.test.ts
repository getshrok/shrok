import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BASELINE_ENV_KEYS, buildScopedEnv } from './env.js'
import { applyTimezoneEnv } from '../timezone-env.js'

// Save/restore process.env.TZ to prevent leakage across tests and shards (T-4zu-02 mitigation)
let origTZ: string | undefined
beforeEach(() => {
  origTZ = process.env['TZ']
})
afterEach(() => {
  if (origTZ === undefined) {
    delete process.env['TZ']
  } else {
    process.env['TZ'] = origTZ
  }
})

describe('BASELINE_ENV_KEYS', () => {
  it("contains 'TZ'", () => {
    expect(BASELINE_ENV_KEYS).toContain('TZ')
  })
})

describe('buildScopedEnv', () => {
  it('includes TZ when present in the supplied env dict', () => {
    const result = buildScopedEnv([], { TZ: 'America/New_York', PATH: '/usr/bin' })
    expect(result['TZ']).toBe('America/New_York')
  })

  it('omits TZ when absent from the supplied env dict (preserves filter-undefined behavior)', () => {
    const result = buildScopedEnv([], { PATH: '/usr/bin' })
    expect('TZ' in result).toBe(false)
  })
})

describe('applyTimezoneEnv', () => {
  it('sets process.env.TZ to config.timezone', () => {
    applyTimezoneEnv({ timezone: 'Europe/Berlin' })
    expect(process.env['TZ']).toBe('Europe/Berlin')
  })
})
