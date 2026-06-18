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
    createdAt: new Date().toISOString(),
  }
}

function scheduleTrigger(taskName: string): QueueEvent {
  return {
    type: 'schedule_trigger',
    id: generateId('ev'),
    scheduleId: generateId('sched'),
    taskName,
    kind: 'skill',
    createdAt: new Date().toISOString(),
  }
}

function headMessage(text = 'dinner moved to 7pm'): QueueEvent {
  return {
    type: 'head_message',
    id: generateId('ev'),
    fromHeadId: 'ashley',
    fromHeadName: 'Ashley',
    text,
    createdAt: new Date().toISOString(),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QueueStore.requeueStale', () => {
  it('resets a stuck processing event back to pending', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    // Claim it (now 'processing')
    const claimed = queue.claimNext('default')
    expect(claimed).not.toBeNull()

    // Simulate crash recovery — do not ack; call requeueStale
    queue.requeueStale('default')

    // Now it should be claimable again
    const reclaimed = queue.claimNext('default')
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.rowId).toBe(claimed!.rowId)
  })

  it('does not affect already-done events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)
    const claimed = queue.claimNext('default')!
    queue.ack(claimed.rowId)

    queue.requeueStale('default')

    // Queue is empty — nothing was re-enqueued
    expect(queue.claimNext('default')).toBeNull()
  })

  it('does not affect pending events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg('first'), PRIORITY.USER_MESSAGE)
    queue.enqueue(userMsg('second'), PRIORITY.USER_MESSAGE)

    // Don't claim anything — both stay pending
    queue.requeueStale('default')

    // Both still claimable in order
    const first = queue.claimNext('default')
    const second = queue.claimNext('default')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
  })
})

// ─── Phase 31: head_id threading (ADPT-01) ──────────────────────────────────

describe('QueueStore.enqueue head_id threading (ADPT-01)', () => {
  it('events enqueued with headId="work" are not claimable by head="default"', () => {
    const queue = new QueueStore(freshDb())
    const ev = userMsg('hello from work')
    queue.enqueue(ev, PRIORITY.USER_MESSAGE, 'work')

    // Default head should NOT see it
    expect(queue.claimNext('default')).toBeNull()

    // Work head SHOULD see it
    const claimed = queue.claimNext('work')
    expect(claimed).not.toBeNull()
    expect(claimed?.event.id).toBe(ev.id)
  })

  it('events enqueued with no headId argument default to head="default"', () => {
    const queue = new QueueStore(freshDb())
    const ev = userMsg('hello default')
    queue.enqueue(ev, PRIORITY.USER_MESSAGE)  // no headId arg

    expect(queue.claimNext('work')).toBeNull()
    const claimed = queue.claimNext('default')
    expect(claimed?.event.id).toBe(ev.id)
  })

  it('two events with distinct headIds isolate cleanly under concurrent claims', () => {
    const queue = new QueueStore(freshDb())
    const evW = userMsg('work msg')
    const evP = userMsg('personal msg')
    queue.enqueue(evW, PRIORITY.USER_MESSAGE, 'work')
    queue.enqueue(evP, PRIORITY.USER_MESSAGE, 'personal')

    const claimedW = queue.claimNext('work')
    const claimedP = queue.claimNext('personal')
    expect(claimedW?.event.id).toBe(evW.id)
    expect(claimedP?.event.id).toBe(evP.id)
    // Neither head sees the other's event
    expect(queue.claimNext('work')).toBeNull()
    expect(queue.claimNext('personal')).toBeNull()
  })
})

describe('QueueStore cross-head relay (head_message)', () => {
  it('a head_message enqueued onto another head is claimable only by that head', () => {
    const queue = new QueueStore(freshDb())
    const ev = headMessage()
    queue.enqueue(ev, PRIORITY.HEAD_MESSAGE, 'zoey')

    // The sender's head does not see it
    expect(queue.claimNext('ashley')).toBeNull()

    // The target head does, with the relay payload intact
    const claimed = queue.claimNext('zoey')
    expect(claimed?.event.id).toBe(ev.id)
    expect(claimed?.event.type).toBe('head_message')
    expect((claimed?.event as Extract<QueueEvent, { type: 'head_message' }>).fromHeadName).toBe('Ashley')
  })

  it('the wake hook fires with the TARGET head id, not the sender', () => {
    const seen: string[] = []
    const queue = new QueueStore(freshDb(), (headId) => seen.push(headId))
    queue.enqueue(headMessage(), PRIORITY.HEAD_MESSAGE, 'zoey')
    expect(seen).toEqual(['zoey'])
  })
})

describe('QueueStore.claimAllPendingBackground', () => {
  it('returns all pending non-user_message events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    const claimed = queue.claimAllPendingBackground('default')
    expect(claimed.length).toBe(3)
  })

  it('does not include user_message events', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    const claimed = queue.claimAllPendingBackground('default')
    expect(claimed.length).toBe(1)
    expect(claimed[0]!.event.type).toBe('agent_completed')
  })

  it('marks claimed events as processing (not claimable again)', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    queue.claimAllPendingBackground('default')
    const second = queue.claimAllPendingBackground('default')

    expect(second.length).toBe(0)
  })

  it('returns empty array when no background events pending', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    const claimed = queue.claimAllPendingBackground('default')
    expect(claimed.length).toBe(0)
  })

  it('does not reclaim the already-claimed primary event', () => {
    const queue = new QueueStore(freshDb())
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED)

    // Claim one as the primary (now 'processing')
    const primary = queue.claimNext('default')!

    // claimAllPendingBackground should only return the remaining pending one
    const background = queue.claimAllPendingBackground('default')
    expect(background.length).toBe(1)
    expect(background[0]!.rowId).not.toBe(primary.rowId)
  })
})

describe('QueueStore onEnqueue wake hook', () => {
  it('calls the hook once with the enqueued headId after insert', () => {
    const seen: string[] = []
    const queue = new QueueStore(freshDb(), (headId) => seen.push(headId))

    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE, 'h1')
    queue.enqueue(agentCompleted(), PRIORITY.AGENT_COMPLETED, 'h2')

    expect(seen).toEqual(['h1', 'h2'])
  })

  it('passes the default headId when none is given', () => {
    const seen: string[] = []
    const queue = new QueueStore(freshDb(), (headId) => seen.push(headId))

    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    expect(seen).toEqual(['default'])
  })

  it('fires the hook only after the row is durably claimable', () => {
    let claimableAtHookTime = false
    const queue = new QueueStore(freshDb(), () => {
      // The wake must see a claimable row — insert happens before the signal.
      claimableAtHookTime = queue.claimNext('default') !== null
    })

    queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)

    expect(claimableAtHookTime).toBe(true)
  })

  it('works without a hook (backward compatible)', () => {
    const queue = new QueueStore(freshDb())
    expect(() => queue.enqueue(userMsg(), PRIORITY.USER_MESSAGE)).not.toThrow()
    expect(queue.claimNext('default')).not.toBeNull()
  })
})

