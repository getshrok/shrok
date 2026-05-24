// src/channels/home-assistant/adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HomeAssistantChannelAdapter } from './adapter.js'
import { ChannelRouterImpl } from '../router.js'
import type { InboundMessage } from '../../types/channel.js'

// ─── Block A: Adapter contract + loud-but-safe send ──────────────────────────

describe('HomeAssistantChannelAdapter — contract', () => {
  it('has default id "home-assistant"', () => {
    const adapter = new HomeAssistantChannelAdapter()
    expect(adapter.id).toBe('home-assistant')
  })

  it('honors a custom id passed to constructor', () => {
    const adapter = new HomeAssistantChannelAdapter('ha-2', 'work')
    expect(adapter.id).toBe('ha-2')
  })

  it('start() resolves without throwing', async () => {
    const adapter = new HomeAssistantChannelAdapter()
    await expect(adapter.start()).resolves.not.toThrow()
  })

  it('stop() resolves without throwing', async () => {
    const adapter = new HomeAssistantChannelAdapter()
    await expect(adapter.stop()).resolves.not.toThrow()
  })

  describe('send() — loud-but-safe (D-05)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('resolves to undefined and does not throw', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      const result = await adapter.send('hello world')
      expect(result).toBeUndefined()
    })

    it('calls console.warn exactly once', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      await adapter.send('hello world')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('warn message mentions Phase 42 (not wired yet)', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      await adapter.send('some text')
      const warnArg: unknown = warnSpy.mock.calls[0]?.[0]
      expect(typeof warnArg).toBe('string')
      expect(warnArg as string).toMatch(/Phase 42/)
    })

    it('warn message does not log any token value', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      await adapter.send('some text')
      const warnArg: unknown = warnSpy.mock.calls[0]?.[0]
      expect(typeof warnArg).toBe('string')
      expect(warnArg as string).not.toMatch(/HA_ACCESS_TOKEN|Bearer/)
    })
  })

  describe('injectMessage()', () => {
    it('calls registered handler with correct InboundMessage', () => {
      const adapter = new HomeAssistantChannelAdapter()
      const received: InboundMessage[] = []
      adapter.onMessage((msg) => received.push(msg))
      adapter.injectMessage('hi', 'Ashley')
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        channel: 'home-assistant',
        text: 'hi',
        senderName: 'Ashley',
      })
    })

    it('omits senderName key when not provided', () => {
      const adapter = new HomeAssistantChannelAdapter()
      const received: InboundMessage[] = []
      adapter.onMessage((msg) => received.push(msg))
      adapter.injectMessage('hi')
      expect(received).toHaveLength(1)
      const msg = received[0]
      expect(msg).toBeDefined()
      if (msg) {
        expect(msg.channel).toBe('home-assistant')
        expect(msg.text).toBe('hi')
        expect('senderName' in msg).toBe(false)
      }
    })

    it('does not throw when no handler is registered', () => {
      const adapter = new HomeAssistantChannelAdapter()
      expect(() => adapter.injectMessage('hi')).not.toThrow()
    })
  })
})

// ─── Block B: SC3 — full inject→activation→reply cycle stamps lastActiveChannel ─

describe('HomeAssistantChannelAdapter — SC3 lastActiveChannel routing', () => {
  // lastActiveChannel is OUTBOUND-ONLY — it is stamped by ChannelRouterImpl.send()
  // on a successful outbound send (router.ts:21), NOT on inbound receipt.
  // This test guards that contract: inbound alone does NOT stamp it; only the
  // outbound router.send() call does.
  // If a future refactor moves the stamp to the inbound path, step (3) will fail.

  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('inbound injectMessage delivers to handler; only outbound router.send stamps lastActiveChannel', async () => {
    // (1) Build minimal wiring inline (self-contained, per channel-router-isolation precedent)
    const router = new ChannelRouterImpl()
    const adapter = new HomeAssistantChannelAdapter()
    router.register(adapter)

    const received: InboundMessage[] = []
    // (2) Register the inbound handler — simulates what headRouteMessage does at startup
    adapter.onMessage((msg) => received.push(msg))

    // (3) Fire the inbound path via injectMessage
    adapter.injectMessage('what is the score')

    // Assert inbound delivery
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ channel: 'home-assistant', text: 'what is the score' })

    // (4) Assert that lastActiveChannel is still null after inbound — outbound-only stamp
    expect(router.getLastActiveChannel()).toBeNull()

    // (5) Simulate the head's reply: outbound router.send drives adapter.send() and stamps lastActiveChannel
    await router.send('home-assistant', 'on it')

    // (6) Assert lastActiveChannel is now stamped by the outbound send
    expect(router.getLastActiveChannel()).toBe('home-assistant')
  })
})
