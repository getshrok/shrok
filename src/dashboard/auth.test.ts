import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenStore, verifyPassword } from './auth.js'

describe('TokenStore', () => {
  let store: TokenStore

  beforeEach(() => {
    store = new TokenStore()
  })

  it('create() returns a hex string token', () => {
    const token = store.create()
    expect(typeof token).toBe('string')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validate() returns true for a valid token', () => {
    const token = store.create()
    expect(store.validate(token)).toBe(true)
  })

  it('validate() returns false for an unknown token', () => {
    expect(store.validate('nonexistent-token')).toBe(false)
  })

  it('revoke() invalidates a specific token without affecting others', () => {
    const token1 = store.create()
    const token2 = store.create()
    store.revoke(token1)
    expect(store.validate(token1)).toBe(false)
    expect(store.validate(token2)).toBe(true)
  })

  it('revokeAll() invalidates ALL tokens — no tokens pass validate() after', () => {
    const tokens = [store.create(), store.create(), store.create()]
    store.revokeAll()
    for (const token of tokens) {
      expect(store.validate(token)).toBe(false)
    }
  })

  it('expired sessions are rejected by validate() (mock Date.now)', () => {
    const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
    const realNow = Date.now()
    const dateSpy = vi.spyOn(Date, 'now')
    dateSpy.mockReturnValue(realNow)

    const token = store.create()
    expect(store.validate(token)).toBe(true)

    // Advance time past TTL
    dateSpy.mockReturnValue(realNow + SESSION_TTL_MS + 1)
    expect(store.validate(token)).toBe(false)

    dateSpy.mockRestore()
  })

  it('create() after revokeAll() produces valid new tokens (store is reusable)', () => {
    const oldToken = store.create()
    store.revokeAll()
    expect(store.validate(oldToken)).toBe(false)

    const newToken = store.create()
    expect(store.validate(newToken)).toBe(true)
    expect(store.validate(oldToken)).toBe(false)
  })
})

describe('verifyPassword', () => {
  it('returns true for correct password against known bcrypt hash', async () => {
    // bcrypt hash of 'testpassword' with 10 rounds (generated via bcryptjs.hash)
    const hash = '$2b$10$a5llDz4NfLmJxaPABRldiuWQZRpVMRSlYLWCxW92yruHV2ravYCWq'
    const result = await verifyPassword('testpassword', hash)
    expect(result).toBe(true)
  })

  it('returns false for incorrect password', async () => {
    const hash = '$2b$10$a5llDz4NfLmJxaPABRldiuWQZRpVMRSlYLWCxW92yruHV2ravYCWq'
    const result = await verifyPassword('wrongpassword', hash)
    expect(result).toBe(false)
  })
})
