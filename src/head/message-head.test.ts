/**
 * Tests for the message_head cross-head relay tool: buildMessageHeadDef (recipient
 * listing) and the HeadToolExecutor dispatch case (resolve → enqueue onto target).
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { HeadToolExecutor, buildMessageHeadDef } from './index.js'
import { FileSystemIdentityLoader } from '../identity/loader.js'
import { QueueStore } from '../db/queue.js'
import { PRIORITY } from '../types/core.js'
import type { QueueEvent } from '../types/core.js'
import { freshDb } from '../../tests/integration/helpers.js'
import type { AgentRunner } from '../types/agent.js'
import type { Memory } from '../memory/index.js'
import type { SkillLoader } from '../types/skill.js'
import type { UsageStore } from '../db/usage.js'
import type { MessageStore } from '../db/messages.js'

const ROSTER = [
  { id: 'ashley', displayName: 'Ashley' },
  { id: 'zoey', displayName: 'Zoey' },
  { id: 'house', displayName: 'House' },
]

function makeExecutor(opts: { headId: string; queueStore?: QueueStore; headRoster?: ReadonlyArray<{ id: string; displayName: string }> }): { executor: HeadToolExecutor; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-head-test-'))
  const executor = new HeadToolExecutor({
    headId: opts.headId,
    agentRunner: { spawn: vi.fn(), update: vi.fn(), signal: vi.fn(), retract: vi.fn() } as unknown as AgentRunner,
    skillLoader: { load: vi.fn(), listAll: vi.fn().mockReturnValue([]) } as unknown as SkillLoader,
    topicMemory: {} as unknown as Memory,
    usageStore: {} as unknown as UsageStore,
    identityDir: tmpDir,
    identityLoader: new FileSystemIdentityLoader(tmpDir, tmpDir),
    messages: { getAll: () => [] } as unknown as MessageStore,
    ...(opts.queueStore ? { queueStore: opts.queueStore } : {}),
    ...(opts.headRoster ? { headRoster: opts.headRoster } : {}),
  })
  return { executor, tmpDir }
}

describe('buildMessageHeadDef', () => {
  it('lists the other heads by display name and excludes self', () => {
    const def = buildMessageHeadDef(ROSTER, 'ashley')
    expect(def.name).toBe('message_head')
    expect(def.description).toContain('"Zoey"')
    expect(def.description).toContain('"House"')
    expect(def.description).not.toContain('"Ashley"')
  })

  it('says none configured when there are no other heads', () => {
    const def = buildMessageHeadDef([{ id: 'solo', displayName: 'Solo' }], 'solo')
    expect(def.description).toContain('none configured')
  })
})

describe('HeadToolExecutor message_head', () => {
  it('resolves the recipient by display name and enqueues onto that head at HEAD_MESSAGE priority', async () => {
    let wokeHead: string | null = null
    const queue = new QueueStore(freshDb(), (h) => { wokeHead = h })
    const { executor } = makeExecutor({ headId: 'ashley', queueStore: queue, headRoster: ROSTER })

    const result = await executor.execute({
      id: 'tc1', name: 'message_head', input: { head: 'Zoey', message: 'dinner moved to 7pm' },
    })
    expect(JSON.parse(result.content as string)).toMatchObject({ ok: true, relayedTo: 'Zoey' })

    // Woke Zoey's loop, not the sender's
    expect(wokeHead).toBe('zoey')

    // The event lands on Zoey's queue, attributed to Ashley
    expect(queue.claimNext('ashley')).toBeNull()
    const claimed = queue.claimNext('zoey')
    const ev = claimed?.event as Extract<QueueEvent, { type: 'head_message' }>
    expect(ev.type).toBe('head_message')
    expect(ev.fromHeadId).toBe('ashley')
    expect(ev.fromHeadName).toBe('Ashley')
    expect(ev.text).toBe('dinner moved to 7pm')
  })

  it('resolves case-insensitively and by id as a fallback', async () => {
    const queue = new QueueStore(freshDb())
    const { executor } = makeExecutor({ headId: 'ashley', queueStore: queue, headRoster: ROSTER })

    await executor.execute({ id: 'tc1', name: 'message_head', input: { head: 'zoey', message: 'hi' } })
    expect(queue.claimNext('zoey')).not.toBeNull()
  })

  it('rejects messaging self', async () => {
    const queue = new QueueStore(freshDb())
    const { executor } = makeExecutor({ headId: 'ashley', queueStore: queue, headRoster: ROSTER })

    const result = await executor.execute({ id: 'tc1', name: 'message_head', input: { head: 'Ashley', message: 'hi' } })
    expect(JSON.parse(result.content as string)).toMatchObject({ error: true })
    // self is filtered out of recipients, so it reads as "no recipient named"
    expect(queue.claimNext('ashley')).toBeNull()
  })

  it('rejects an unknown recipient with the valid list', async () => {
    const queue = new QueueStore(freshDb())
    const { executor } = makeExecutor({ headId: 'ashley', queueStore: queue, headRoster: ROSTER })

    const result = await executor.execute({ id: 'tc1', name: 'message_head', input: { head: 'Bob', message: 'hi' } })
    const parsed = JSON.parse(result.content as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('Zoey')
    expect(parsed.message).toContain('House')
  })

  it('is a graceful no-op when there are no other heads (single-head install)', async () => {
    const queue = new QueueStore(freshDb())
    const { executor } = makeExecutor({ headId: 'default', queueStore: queue, headRoster: [{ id: 'default', displayName: 'default' }] })

    const result = await executor.execute({ id: 'tc1', name: 'message_head', input: { head: 'anyone', message: 'hi' } })
    expect(JSON.parse(result.content as string)).toMatchObject({ error: true })
  })

  it('confirms PRIORITY.HEAD_MESSAGE sits below user_message and above agent events', () => {
    expect(PRIORITY.HEAD_MESSAGE).toBeLessThan(PRIORITY.USER_MESSAGE)
    expect(PRIORITY.HEAD_MESSAGE).toBeGreaterThan(PRIORITY.AGENT_QUESTION)
  })
})
