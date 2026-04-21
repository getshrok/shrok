import { describe, it, expect } from 'vitest'
import { buildScopedEnv } from '../../src/sub-agents/env.js'

// The baseline keys always forwarded regardless of declared vars
const BASELINE_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_PATH', 'WORKSPACE_PATH', 'SHROK_ENV_FILE', 'SHROK_ROOT']

describe('buildScopedEnv', () => {
  it('includes baseline keys present in the env dict', () => {
    const env = buildScopedEnv([], { PATH: '/usr/bin', HOME: '/home/user' })
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/user')
  })

  it('does not include baseline keys missing from the env dict', () => {
    const env = buildScopedEnv([], { PATH: '/usr/bin' })
    expect(env['HOME']).toBeUndefined()
    expect(env['USER']).toBeUndefined()
  })

  it('includes declared vars present in the env dict', () => {
    const env = buildScopedEnv(['MY_SECRET', 'API_KEY'], { MY_SECRET: 'abc123', API_KEY: 'xyz' })
    expect(env['MY_SECRET']).toBe('abc123')
    expect(env['API_KEY']).toBe('xyz')
  })

  it('does not include declared vars missing from the env dict', () => {
    const env = buildScopedEnv(['MISSING_VAR'], { PATH: '/usr/bin' })
    expect(env['MISSING_VAR']).toBeUndefined()
  })

  it('does not include keys not in baseline or declared', () => {
    const env = buildScopedEnv(['ALLOWED'], {
      ALLOWED: 'yes',
      SECRET_RANDOM: 'nope',
      AWS_SECRET_KEY: 'leak',
    })
    expect(env['ALLOWED']).toBe('yes')
    expect(env['SECRET_RANDOM']).toBeUndefined()
    expect(env['AWS_SECRET_KEY']).toBeUndefined()
  })

  it('returns empty object when env dict is empty', () => {
    const env = buildScopedEnv(['MY_VAR'], {})
    expect(Object.keys(env).length).toBe(0)
  })

  it('does not include keys with undefined values', () => {
    const env = buildScopedEnv(['MAYBE'], { MAYBE: undefined, PATH: '/bin' })
    expect(env['MAYBE']).toBeUndefined()
    expect(env['PATH']).toBe('/bin')
  })

  it('defaults to process.env when no envDict provided', () => {
    // Verify the default argument works — result type should be Record<string, string>
    const env = buildScopedEnv([])
    // PATH should exist in any real Node.js process
    expect(typeof env).toBe('object')
    // Should not throw — the default path is exercised
  })

  it('handles duplicate keys between baseline and declared without error', () => {
    // PATH is a baseline key — also passing it as a declared var should not cause issues
    const env = buildScopedEnv(['PATH'], { PATH: '/usr/bin' })
    expect(env['PATH']).toBe('/usr/bin')
  })
})
