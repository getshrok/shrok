import { describe, it, expect } from 'vitest'
import { shouldDeliverStreamEvent } from './streamFilter'
import type { DashboardEvent, Message } from '../types/api'

const dummyMessage: Message = {
  id: 'm1',
  kind: 'text',
  role: 'user',
  content: 'hi',
  createdAt: '2026-05-13T00:00:00Z',
} as Message

describe('shouldDeliverStreamEvent (D-11, RESEARCH § A4)', () => {
  it('drops message_added for a different head', () => {
    const e: DashboardEvent = { type: 'message_added', payload: dummyMessage, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers message_added for the matching head', () => {
    const e: DashboardEvent = { type: 'message_added', payload: dummyMessage, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'work')).toBe(true)
  })

  it('drops typing for a different head', () => {
    const e: DashboardEvent = { type: 'typing', headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers typing for the matching head', () => {
    const e: DashboardEvent = { type: 'typing', headId: 'default' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
  })

  it('always delivers process-wide usage_updated', () => {
    const e: DashboardEvent = { type: 'usage_updated' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
    expect(shouldDeliverStreamEvent(e, 'work')).toBe(true)
    expect(shouldDeliverStreamEvent(e, null)).toBe(true)
  })

  it('always delivers agent_status_changed (scope: out of phase per RESEARCH § A4)', () => {
    const e: DashboardEvent = { type: 'agent_status_changed', payload: { id: 'a1', status: 'running' } } as DashboardEvent
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
    expect(shouldDeliverStreamEvent(e, 'work')).toBe(true)
  })

  it('always delivers steward_run_added (scope: out of phase per RESEARCH § A4)', () => {
    const e: DashboardEvent = { type: 'steward_run_added', payload: { id: 's1' } as never } as DashboardEvent
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
    expect(shouldDeliverStreamEvent(e, 'work')).toBe(true)
  })

  it('delivers per-head events when selectedHead is null (pre-resolution)', () => {
    const e: DashboardEvent = { type: 'message_added', payload: dummyMessage, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, null)).toBe(true)
  })
})
