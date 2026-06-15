import { describe, it, expect } from 'vitest'
import { isDashboardChannelId } from './adapter.js'

describe('isDashboardChannelId', () => {
  it('matches the per-head dashboard channel ids', () => {
    expect(isDashboardChannelId('dashboard:default')).toBe(true)
    expect(isDashboardChannelId('dashboard:ashley')).toBe(true)
    expect(isDashboardChannelId('dashboard')).toBe(true)
  })

  it('does not match real chat channels', () => {
    for (const id of ['discord', 'telegram', 'slack', 'whatsapp', 'zoho-cliq', 'home-assistant']) {
      expect(isDashboardChannelId(id)).toBe(false)
    }
  })

  it('does not match a lookalike channel name', () => {
    expect(isDashboardChannelId('dashboardx')).toBe(false)
  })
})
