// src/ring/store.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRingStateStore } from './store.js'
import type { RingState } from './store.js'

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-ring-store-test-'))
}

function makeRecord(headId: string, channelId: string, overrides: Partial<RingState> = {}): RingState {
  return {
    id: `${headId}:${channelId}`,
    headId,
    channelId,
    mediaPlayerEntityId: `media_player.${headId}_${channelId}_media_player`,
    ledEntityId: `light.${headId}_${channelId}_led_ring`,
    startedAt: new Date().toISOString(),
    source: 'timer',
    ...overrides,
  }
}

describe('createRingStateStore', () => {
  const workspaces: string[] = []

  afterEach(() => {
    for (const ws of workspaces) {
      try { fs.rmSync(ws, { recursive: true }) } catch { /* ignore */ }
    }
    workspaces.length = 0
  })

  function makeStore() {
    const ws = makeTempWorkspace()
    workspaces.push(ws)
    return { store: createRingStateStore(ws), ws }
  }

  it('creates the data/rings directory automatically', () => {
    const { ws } = makeStore()
    expect(fs.existsSync(path.join(ws, 'data', 'rings'))).toBe(true)
  })

  it('save() + get() round-trip a RingState record', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant')
    store.save(record)
    const retrieved = store.get(record.id)
    expect(retrieved).toEqual(record)
  })

  it('id is `${headId}:${channelId}`', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant')
    store.save(record)
    expect(record.id).toBe('headA:home-assistant')
    const retrieved = store.get('headA:home-assistant')
    expect(retrieved).not.toBeNull()
  })

  it('list() returns all saved records', () => {
    const { store } = makeStore()
    const r1 = makeRecord('headA', 'home-assistant')
    const r2 = makeRecord('headB', 'home-assistant')
    store.save(r1)
    store.save(r2)
    const all = store.list()
    expect(all).toHaveLength(2)
    const ids = all.map(r => r.id).sort()
    expect(ids).toEqual(['headA:home-assistant', 'headB:home-assistant'].sort())
  })

  it('delete() removes the record', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant')
    store.save(record)
    store.delete(record.id)
    expect(store.get(record.id)).toBeNull()
  })

  it('get() returns null after delete()', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant')
    store.save(record)
    store.delete(record.id)
    expect(store.get(record.id)).toBeNull()
  })

  it('list() returns empty array on a fresh store', () => {
    const { store } = makeStore()
    expect(store.list()).toEqual([])
  })

  it('two records with same channelId under different heads do not collide (Pitfall 4)', () => {
    const { store } = makeStore()
    const headA = makeRecord('headA', 'home-assistant')
    const headB = makeRecord('headB', 'home-assistant', { source: 'alarm' })
    // same channelId, different headIds → different ids
    expect(headA.id).toBe('headA:home-assistant')
    expect(headB.id).toBe('headB:home-assistant')
    store.save(headA)
    store.save(headB)
    const retrievedA = store.get('headA:home-assistant')
    const retrievedB = store.get('headB:home-assistant')
    expect(retrievedA).not.toBeNull()
    expect(retrievedB).not.toBeNull()
    expect(retrievedA?.headId).toBe('headA')
    expect(retrievedB?.headId).toBe('headB')
    expect(retrievedA?.source).toBe('timer')
    expect(retrievedB?.source).toBe('alarm')
  })

  it('ledEntityId can be null (LED derive failure) and round-trips correctly', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant', { ledEntityId: null })
    store.save(record)
    const retrieved = store.get(record.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.ledEntityId).toBeNull()
  })

  it('ledEntityId is never the string "undefined"', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant', { ledEntityId: null })
    store.save(record)
    const retrieved = store.get(record.id)
    expect(retrieved?.ledEntityId).not.toBe('undefined')
  })

  it('source field is preserved as "timer"', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant', { source: 'timer' })
    store.save(record)
    expect(store.get(record.id)?.source).toBe('timer')
  })

  it('source field is preserved as "alarm"', () => {
    const { store } = makeStore()
    const record = makeRecord('headA', 'home-assistant', { source: 'alarm' })
    store.save(record)
    expect(store.get(record.id)?.source).toBe('alarm')
  })
})
