import { describe, it, expect, vi } from 'vitest'
import { ChannelRouterImpl } from '../../src/channels/router.js'
import type { ChannelAdapter } from '../../src/types/channel.js'

// ─── Adapter factory ──────────────────────────────────────────────────────────

function makeAdapter(id: string, sendImpl?: (text: string) => Promise<void>): ChannelAdapter & { received: string[] } {
  const received: string[] = []
  return {
    id,
    received,
    start: async () => {},
    stop: async () => {},
    send: sendImpl ?? (async (text: string) => { received.push(text) }),
    onMessage: () => {},
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ChannelRouterImpl', () => {
  describe('register + send', () => {
    it('routes a message to the registered adapter', async () => {
      const router = new ChannelRouterImpl()
      const adapter = makeAdapter('discord')
      router.register(adapter)

      await router.send('discord', 'hello world')

      expect(adapter.received).toEqual(['hello world'])
    })

    it('routes to the correct adapter when multiple are registered', async () => {
      const router = new ChannelRouterImpl()
      const discord = makeAdapter('discord')
      const telegram = makeAdapter('telegram')
      router.register(discord)
      router.register(telegram)

      await router.send('telegram', 'hi telegram')

      expect(discord.received).toEqual([])
      expect(telegram.received).toEqual(['hi telegram'])
    })

    it('passes text through without modification', async () => {
      const router = new ChannelRouterImpl()
      const adapter = makeAdapter('discord')
      router.register(adapter)

      await router.send('discord', 'one — two—three')

      expect(adapter.received).toEqual(['one — two—three'])
    })

    it('does not throw when sending to unregistered channel', async () => {
      const router = new ChannelRouterImpl()
      await expect(router.send('nonexistent', 'hello')).resolves.toBeUndefined()
    })

    it('does not throw when adapter send() rejects', async () => {
      const router = new ChannelRouterImpl()
      const failing = makeAdapter('flaky', async () => { throw new Error('network down') })
      router.register(failing)
      await expect(router.send('flaky', 'hello')).resolves.toBeUndefined()
    })
  })

  // ─── Phase 31: distinct-id registration (ADPT-02) ──────────────────────────

  describe('ChannelRouterImpl multi-instance registration (ADPT-02)', () => {
    it('two adapters with distinct ids can register without collision', async () => {
      const router = new ChannelRouterImpl()
      const personal = makeAdapter('telegram-personal')
      const work     = makeAdapter('telegram-work')
      router.register(personal)
      router.register(work)

      await router.send('telegram-personal', 'msg for personal')
      await router.send('telegram-work',     'msg for work')

      expect(personal.received).toEqual(['msg for personal'])
      expect(work.received).toEqual(['msg for work'])
    })

    it('registering a second adapter with the same id overwrites the first (documents current behavior)', async () => {
      const router = new ChannelRouterImpl()
      const first  = makeAdapter('telegram')
      const second = makeAdapter('telegram')
      router.register(first)
      router.register(second)

      await router.send('telegram', 'hello')

      // Second overwrites first — this is the failure mode ADPT-02 guards against
      // when adapters use static readonly ids. With distinct ids (test above) the
      // collision goes away.
      expect(first.received).toEqual([])
      expect(second.received).toEqual(['hello'])
    })
  })

  describe('getLastActiveChannel', () => {
    it('returns null before any successful send', () => {
      const router = new ChannelRouterImpl()
      expect(router.getLastActiveChannel()).toBeNull()
    })

    it('returns the channel after a successful send', async () => {
      const router = new ChannelRouterImpl()
      router.register(makeAdapter('discord'))
      await router.send('discord', 'hi')
      expect(router.getLastActiveChannel()).toBe('discord')
    })

    it('updates to the most recently successful channel', async () => {
      const router = new ChannelRouterImpl()
      router.register(makeAdapter('discord'))
      router.register(makeAdapter('telegram'))
      await router.send('discord', 'first')
      await router.send('telegram', 'second')
      expect(router.getLastActiveChannel()).toBe('telegram')
    })

    it('does not update lastActiveChannel when send to unregistered channel', async () => {
      const router = new ChannelRouterImpl()
      router.register(makeAdapter('discord'))
      await router.send('discord', 'first')
      await router.send('nonexistent', 'second')
      expect(router.getLastActiveChannel()).toBe('discord')
    })

    it('does not update lastActiveChannel when adapter throws', async () => {
      const router = new ChannelRouterImpl()
      router.register(makeAdapter('good'))
      router.register(makeAdapter('bad', async () => { throw new Error('boom') }))
      await router.send('good', 'first')
      await router.send('bad', 'second')
      expect(router.getLastActiveChannel()).toBe('good')
    })
  })
})
