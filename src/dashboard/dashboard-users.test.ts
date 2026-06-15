import { describe, it, expect } from 'vitest'
import { normalizeDashboardUsers } from './dashboard-users.js'

describe('normalizeDashboardUsers', () => {
  it('returns [] for non-array / missing input', () => {
    expect(normalizeDashboardUsers(undefined)).toEqual([])
    expect(normalizeDashboardUsers(null)).toEqual([])
    expect(normalizeDashboardUsers('nope')).toEqual([])
  })

  it('coerces legacy bare strings to { name }', () => {
    expect(normalizeDashboardUsers(['Zoey', 'Ashley'])).toEqual([{ name: 'Zoey' }, { name: 'Ashley' }])
  })

  it('keeps { name, headId } objects', () => {
    expect(normalizeDashboardUsers([{ name: 'Ashley', headId: 'ashley' }])).toEqual([{ name: 'Ashley', headId: 'ashley' }])
  })

  it('trims names and headIds, dropping blank names and blank headIds', () => {
    expect(normalizeDashboardUsers([
      { name: '  Ashley ', headId: ' ashley ' },
      { name: '   ' },
      { name: 'Zoey', headId: '   ' },
      '  ',
    ])).toEqual([{ name: 'Ashley', headId: 'ashley' }, { name: 'Zoey' }])
  })

  it('drops malformed entries (missing/ non-string name)', () => {
    expect(normalizeDashboardUsers([{ headId: 'x' }, { name: 5 }, 42, null, { name: 'Ok' }]))
      .toEqual([{ name: 'Ok' }])
  })
})
