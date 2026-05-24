// src/channels/home-assistant/adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HomeAssistantChannelAdapter } from './adapter.js'
import { ChannelRouterImpl } from '../router.js'
import type { InboundMessage } from '../../types/channel.js'

// ─── Block A: Adapter contract + loud-but-safe send ──────────────────────────

describe('HomeAssistantChannelAdapter — contract', () => {
  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = 'test-inbound-key'
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
  })

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
    process.env['HA_INBOUND_API_KEY'] = 'test-inbound-key'
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
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

// ─── Block C: Phase 41 — pendingReply slot lifecycle + upgraded send + fail-fast ───

describe('HomeAssistantChannelAdapter — Phase 41 slot lifecycle + fail-fast', () => {
  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = 'test-inbound-key'
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    vi.useRealTimers()
  })

  // ── D-02: constructor fail-fast ──────────────────────────────────────────

  describe('constructor fail-fast (D-02)', () => {
    it('throws when HA_INBOUND_API_KEY is absent', () => {
      delete process.env['HA_INBOUND_API_KEY']
      expect(() => new HomeAssistantChannelAdapter()).toThrow(/HA_INBOUND_API_KEY/)
    })

    it('throws when HA_INBOUND_API_KEY is an empty string', () => {
      process.env['HA_INBOUND_API_KEY'] = ''
      expect(() => new HomeAssistantChannelAdapter()).toThrow(/HA_INBOUND_API_KEY/)
    })

    it('succeeds when HA_INBOUND_API_KEY is a non-empty string', () => {
      process.env['HA_INBOUND_API_KEY'] = 'my-secret-key'
      expect(() => new HomeAssistantChannelAdapter()).not.toThrow()
    })
  })

  // ── setPendingReply + send: basic resolve path ───────────────────────────

  describe('setPendingReply + send() resolve path', () => {
    it('send() with an open slot resolves the awaiting promise with the reply text', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      const replyReceived = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        adapter.setPendingReply({ resolve, reject, timer })
      })
      await adapter.send('hello from head')
      await expect(replyReceived).resolves.toBe('hello from head')
    })

    it('send() with an open slot leaves pendingReply null afterward', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      let resolveSlot!: (text: string) => void
      const replyReceived = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        resolveSlot = resolve
        adapter.setPendingReply({ resolve, reject, timer })
      })
      await adapter.send('reply text')
      await replyReceived
      // Sending again should hit the null-slot path (warn), not throw or resolve a second time
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(adapter.send('second send')).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      warnSpy.mockRestore()
      void resolveSlot // suppress unused warning
    })
  })

  // ── send() with null slot → Phase 42 warn seam ──────────────────────────

  describe('send() null-slot path (Phase 42 seam)', () => {
    it('logs a warn mentioning Phase 42 when no slot is open', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const adapter = new HomeAssistantChannelAdapter()
      await adapter.send('drop me')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warnArg: unknown = warnSpy.mock.calls[0]?.[0]
      expect(typeof warnArg).toBe('string')
      expect(warnArg as string).toMatch(/Phase 42/)
      warnSpy.mockRestore()
    })

    it('does not throw when no slot is open', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const adapter = new HomeAssistantChannelAdapter()
      await expect(adapter.send('x')).resolves.toBeUndefined()
      warnSpy.mockRestore()
    })
  })

  // ── D-04: concurrent-replace ─────────────────────────────────────────────

  describe('D-04 concurrent-replace: setPendingReply twice', () => {
    it('rejects the FIRST promise and keeps only the SECOND slot', async () => {
      const adapter = new HomeAssistantChannelAdapter()

      const firstRejected: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        adapter.setPendingReply({ resolve, reject, timer })
      })

      let secondResolve!: (text: string) => void
      const secondResolved: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        secondResolve = resolve
        adapter.setPendingReply({ resolve, reject, timer })
      })

      // First promise should be rejected with 'replaced by concurrent turn'
      await expect(firstRejected).rejects.toThrow('replaced by concurrent turn')

      // Second promise should resolve when send() is called
      await adapter.send('winner reply')
      await expect(secondResolved).resolves.toBe('winner reply')

      void secondResolve // suppress unused warning
    })

    it('clears the first timer on replacement (no dangling timer)', async () => {
      vi.useFakeTimers()
      const adapter = new HomeAssistantChannelAdapter()

      const firstTimerCallback = vi.fn()
      const firstRejected: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          firstTimerCallback()
          reject(new Error('first timer fired'))
        }, 500)
        adapter.setPendingReply({ resolve, reject, timer })
      })

      // Replace with second slot
      const secondResolved: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('second timer fired')), 1000)
        adapter.setPendingReply({ resolve, reject, timer })
      })

      // firstRejected should reject immediately from setPendingReply (not from timer)
      await expect(firstRejected).rejects.toThrow('replaced by concurrent turn')

      // Advance timers past where the first timer would have fired
      vi.advanceTimersByTime(600)

      // First timer callback should NOT have been called (was cleared)
      expect(firstTimerCallback).not.toHaveBeenCalled()

      // Clean up the second slot
      adapter.clearPendingReply()
      vi.useRealTimers()

      void secondResolved // suppress unused warning
    })
  })

  // ── clearPendingReply ────────────────────────────────────────────────────

  describe('clearPendingReply()', () => {
    it('clears the timer and nulls the slot', async () => {
      const adapter = new HomeAssistantChannelAdapter()
      let slotReject!: (err: Error) => void
      const slotPromise: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        slotReject = reject
        adapter.setPendingReply({ resolve, reject, timer })
      })

      adapter.clearPendingReply()

      // After clearPendingReply, send() should hit the null-slot path (warn)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await adapter.send('x')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      warnSpy.mockRestore()

      // slotPromise stays pending (no resolve or reject called by clearPendingReply)
      // — just void it to avoid unhandled rejection
      void slotPromise.catch(() => {})
      void slotReject // suppress unused warning
    })

    it('timer does not fire after send() resolves the slot', async () => {
      vi.useFakeTimers()
      const adapter = new HomeAssistantChannelAdapter()

      const rejectCallback = vi.fn()
      const replyReceived: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectCallback()
          reject(new Error('deadline fired'))
        }, 500)
        adapter.setPendingReply({ resolve, reject, timer })
      })

      // Resolve via send() before the deadline fires
      await adapter.send('fast reply')
      await expect(replyReceived).resolves.toBe('fast reply')

      // Advance past deadline — reject callback should NOT have been called
      vi.advanceTimersByTime(600)
      expect(rejectCallback).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  // ── dispatchInbound ───────────────────────────────────────────────────────

  describe('dispatchInbound()', () => {
    it('delivers InboundMessage to handler with correct fields', () => {
      const adapter = new HomeAssistantChannelAdapter()
      const received: InboundMessage[] = []
      adapter.onMessage((msg) => received.push(msg))

      adapter.dispatchInbound('hi', 'conv-9')

      expect(received).toHaveLength(1)
      const msg = received[0]
      expect(msg).toBeDefined()
      if (msg) {
        expect(msg.channel).toBe('home-assistant')
        expect(msg.text).toBe('hi')
        expect(msg.senderName).toBe('HA Voice')
        expect(msg.rawPayload).toEqual({ conversationId: 'conv-9' })
      }
    })

    it('does not throw when no handler is registered', () => {
      const adapter = new HomeAssistantChannelAdapter()
      expect(() => adapter.dispatchInbound('hi', 'conv-1')).not.toThrow()
    })
  })
})
