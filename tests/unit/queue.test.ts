import { describe, it, expect } from 'vitest'
import { QueueStore } from '../../src/db/queue.js'
import { generateId } from '../../src/llm/util.js'
import { PRIORITY } from '../../src/types/core.js'
import type { QueueEvent } from '../../src/types/core.js'
import { freshDb } from '../integration/helpers.js'

// ─── Event factories ──────────────────────────────────────────────────────────

function userMsg(text = 'hello'): QueueEvent {
  return {
    type: 'user_message',
    id: generateId('ev'),
    channel: 'test',
    text,
    createdAt: new Date().toISOString(),
  }
}

function agentCompleted(agentId = generateId('ag')): QueueEvent {
  return {
    type: 'agent_completed',
    id: generateId('ev'),
    agentId,
    output: 'done',
    silent: false,
    createdAt: new Date().toISOString(),
  }
}

function scheduleTrigger(skillName: string): QueueEvent {
  return {
    type: 'schedule_trigger',
    id: generateId('ev'),
    scheduleId: generateId('sched'),
    skillName,
    kind: 'skill',
    createdAt: new Date().toISOString(),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueueStore.requeueStale', () => {
  it('resets a stuck processing event back to pending', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    // Claim it (now 'processing')
    const claimed = queue.claimNext()
    expect(claimed).not.toBeNull()

    // Simulate crash recovery — do not ack; call requeueStale
    queue.requeueStale()

    // Now it should be claimable again
    const reclaimed = queue.claimNext()
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.rowId).toBe(claimed!.rowId)
  })

  it('does not affect already-done events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)
    const claimed = queue.claimNext()!
    queue.ack(claimed.rowId)

    queue.requeueStale()

    // Queue is empty — nothing was re-enqueued
    expect(queue.claimNext()).toBeNull()
  })

  it('does not affect pending events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg('first'), PRIORITY.USER_MESSAGE)
    queue.enqueue(userMsg('second'), PRIORITY.USER_MESSAGE)

    // Don't claim anything — both stay pending
    queue.requeueStale()

    // Both still claimable in order
    const first = queue.claimNext()
    const second = queue.claimNext()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
  })
})

describe('QueueStore.claimAllPendingBackground', () => {
  it('returns all pending non-user_message events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    const claimed = queue.claimAllPendingBackground()
    expect(claimed.length).toBe(3)
  })

  it('does not include user_message events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    const claimed = queue.claimAllPendingBackground()
    expect(claimed.length).toBe(1)
    expect(claimed[0]!.event.type).toBe('agent_completed')
  })

  it('marks claimed events as processing (not claimable again)', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    queue.claimAllPendingBackground()
    const second = queue.claimAllPendingBackground()

    expect(second.length).toBe(0)
  })

  it('returns empty array when no background events pending', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    const claimed = queue.claimAllPendingBackground()
    expect(claimed.length).toBe(0)
  })

  it('does not reclaim the already-claimed primary event', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    // Claim one as the primary (now 'processing')
    const primary = queue.claimNext()!

    // claimAllPendingBackground should only return the remaining pending one
    const background = queue.claimAllPendingBackground()
    expect(background.length).toBe(1)
    expect(background[0]!.rowId).not.toBe(primary.rowId)
  })
})

