import { describe, it, expect } from 'vitest'
import { shouldDeliverStreamEvent } from './streamFilter'
import type { DashboardEvent, Message, StewardRun } from '../types/api'

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

  // agent_status_changed: top-level headId
  it('drops agent_status_changed for a different head', () => {
    const e: DashboardEvent = { type: 'agent_status_changed', payload: { id: 'a1', status: 'running' }, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers agent_status_changed for the matching head', () => {
    const e: DashboardEvent = { type: 'agent_status_changed', payload: { id: 'a1', status: 'running' }, headId: 'default' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
  })

  // steward_run_added: headId inside payload (StewardRun-shaped), NOT at the top level
  it('drops steward_run_added for a different head (headId in payload)', () => {
    const payload: StewardRun = { id: 's1', stewards: [], createdAt: '2026-06-18T00:00:00Z', headId: 'work' }
    const e: DashboardEvent = { type: 'steward_run_added', payload }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers steward_run_added for the matching head (headId in payload)', () => {
    const payload: StewardRun = { id: 's1', stewards: [], createdAt: '2026-06-18T00:00:00Z', headId: 'default' }
    const e: DashboardEvent = { type: 'steward_run_added', payload }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
  })

  // agent_message_added: top-level headId
  it('drops agent_message_added for a different head', () => {
    const e: DashboardEvent = { type: 'agent_message_added', payload: { agentId: 'ag1', message: dummyMessage, trigger: 'manual' }, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers agent_message_added for the matching head', () => {
    const e: DashboardEvent = { type: 'agent_message_added', payload: { agentId: 'ag1', message: dummyMessage, trigger: 'manual' }, headId: 'default' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
  })

  // memory_retrieval: top-level headId
  it('drops memory_retrieval for a different head', () => {
    const e: DashboardEvent = { type: 'memory_retrieval', payload: { text: 'mem', tokens: 10 }, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(false)
  })

  it('delivers memory_retrieval for the matching head', () => {
    const e: DashboardEvent = { type: 'memory_retrieval', payload: { text: 'mem', tokens: 10 }, headId: 'default' }
    expect(shouldDeliverStreamEvent(e, 'default')).toBe(true)
  })

  it('delivers per-head events when selectedHead is null (pre-resolution)', () => {
    const e: DashboardEvent = { type: 'message_added', payload: dummyMessage, headId: 'work' }
    expect(shouldDeliverStreamEvent(e, null)).toBe(true)
  })
})
