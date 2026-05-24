// src/channels/home-assistant/adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HomeAssistantChannelAdapter } from './adapter.js'
import { ChannelRouterImpl } from '../router.js'
import type { InboundMessage } from '../../types/channel.js'

/** ANNOUNCE_TIMEOUT_MS must match the constant in adapter.ts */
const ANNOUNCE_TIMEOUT_MS = 30_000

const TEST_INBOUND_KEY = 'test-inbound-key'
const TEST_HA_TOKEN = 'test-ha-token-12345678'
const TEST_BASE_URL = 'http://ha.test:8123'
const TEST_ENTITY_ID = 'assist_satellite.test_speaker'

/** Helper: build an adapter with full outbound config wired */
function makeAdapter(id = 'home-assistant', headId = 'default') {
  return new HomeAssistantChannelAdapter(id, headId, {
    haBaseUrl: TEST_BASE_URL,
    haVoiceSatelliteEntityId: TEST_ENTITY_ID,
  })
}

// ─── Block A: Adapter contract ────────────────────────────────────────────────

describe('HomeAssistantChannelAdapter — contract', () => {
  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
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

  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
    process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    delete process.env['HA_ACCESS_TOKEN']
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('inbound injectMessage delivers to handler; only outbound router.send stamps lastActiveChannel', async () => {
    // (1) Build minimal wiring inline (self-contained, per channel-router-isolation precedent)
    const router = new ChannelRouterImpl()
    const adapter = makeAdapter()
    router.register(adapter)

    // Mock fetch to return 200 for the outbound announce
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

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
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

    it('send() with an open slot leaves pendingReply null afterward (second send hits announce path)', async () => {
      process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

      const adapter = makeAdapter()
      let resolveSlot!: (text: string) => void
      const replyReceived = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        resolveSlot = resolve
        adapter.setPendingReply({ resolve, reject, timer })
      })
      await adapter.send('reply text')
      await replyReceived
      // Sending again hits the null-slot path → calls announceOrStartConversation
      await expect(adapter.send('second send')).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      delete process.env['HA_ACCESS_TOKEN']
      void resolveSlot // suppress unused warning
    })
  })

  // ── send() with null slot → Phase 42 outbound announce ──────────────────

  describe('send() null-slot path (Phase 42 announce)', () => {
    it('throws when HA_ACCESS_TOKEN is missing (announce path requires token)', async () => {
      // HA_ACCESS_TOKEN not set in Block C beforeEach → fast error path
      const adapter = new HomeAssistantChannelAdapter()
      await expect(adapter.send('drop me')).rejects.toThrow(/HA_ACCESS_TOKEN/)
    })

    it('resolves on the happy path when HA returns 200', async () => {
      process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

      const adapter = makeAdapter()
      await expect(adapter.send('x')).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      delete process.env['HA_ACCESS_TOKEN']
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
    it('clears the timer and nulls the slot (send after clear hits announce path)', async () => {
      process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))

      const adapter = makeAdapter()
      let slotReject!: (err: Error) => void
      const slotPromise: Promise<string> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1000)
        slotReject = reject
        adapter.setPendingReply({ resolve, reject, timer })
      })

      adapter.clearPendingReply()

      // After clearPendingReply, send() should hit the null-slot announce path
      await adapter.send('x')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // slotPromise stays pending (no resolve or reject called by clearPendingReply)
      void slotPromise.catch(() => {})
      void slotReject // suppress unused warning

      delete process.env['HA_ACCESS_TOKEN']
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

// ─── Block D: Phase 42 outbound announce ─────────────────────────────────────

describe('HomeAssistantChannelAdapter — Phase 42 outbound announce', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_INBOUND_KEY
    process.env['HA_ACCESS_TOKEN'] = TEST_HA_TOKEN
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    delete process.env['HA_INBOUND_API_KEY']
    delete process.env['HA_ACCESS_TOKEN']
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Case 1: send() with pendingReply === null calls fetch on the correct announce URL
  it('case 1: null-slot send() POSTs to the correct HA REST announce URL', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()
    await adapter.send('hello satellite')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs).toBeDefined()
    if (callArgs) {
      const [url, opts] = callArgs as [string, RequestInit]
      expect(url).toBe(`${TEST_BASE_URL}/api/services/assist_satellite/announce`)
      expect((opts as RequestInit).method).toBe('POST')
    }
  })

  // Case 2: fetch body equals JSON { entity_id, message }
  it('case 2: fetch body contains entity_id and message fields', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()
    const text = 'your timer has fired'
    await adapter.send(text)
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs).toBeDefined()
    if (callArgs) {
      const [, opts] = callArgs as [string, RequestInit]
      const parsed = JSON.parse((opts as RequestInit & { body: string }).body) as unknown
      expect(parsed).toEqual({
        entity_id: TEST_ENTITY_ID,
        message: text,
      })
    }
  })

  // Case 3: fetch headers include Authorization: Bearer and Content-Type
  it('case 3: fetch headers include Authorization Bearer and Content-Type json', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()
    await adapter.send('some message')
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs).toBeDefined()
    if (callArgs) {
      const [, opts] = callArgs as [string, RequestInit]
      const headers = (opts as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe(`Bearer ${TEST_HA_TOKEN}`)
      expect(headers['Content-Type']).toBe('application/json')
    }
  })

  // Case 4: Redaction — no log.* call receives a string containing the raw token value
  it('case 4: token value never appears in any log.* argument (D-05 redaction)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await adapter.send('announce me')

    // Collect all args from every log call and check none contain the raw token
    const allLogArgs = [
      ...warnSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ]
    for (const arg of allLogArgs) {
      if (typeof arg === 'string') {
        expect(arg).not.toContain(TEST_HA_TOKEN)
      }
    }
  })

  // Case 5: HA returns 404 → send() rejects/throws
  it('case 5: HA returns 404 → send() throws (router would fall back)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    const adapter = makeAdapter()
    await expect(adapter.send('test')).rejects.toThrow(/HTTP 404/)
  })

  // Case 6: HA returns 500 → send() rejects/throws
  it('case 6: HA returns 500 → send() throws (router would fall back)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }))
    const adapter = makeAdapter()
    await expect(adapter.send('test')).rejects.toThrow(/HTTP 500/)
  })

  // Case 7: 30s timeout fires → send() resolves (does NOT throw), fetch called once
  it('case 7: 30s timeout → send() resolves to undefined (no throw, no re-announce)', async () => {
    vi.useFakeTimers()

    // mockFetch returns a promise that rejects with AbortError when the signal is aborted,
    // simulating the real Node fetch behavior under AbortController
    mockFetch.mockImplementation((_url: unknown, opts: { signal?: AbortSignal } = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = opts.signal
        if (signal) {
          if (signal.aborted) {
            const err = new DOMException('The operation was aborted.', 'AbortError')
            reject(err)
          } else {
            signal.addEventListener('abort', () => {
              const err = new DOMException('The operation was aborted.', 'AbortError')
              reject(err)
            })
          }
        }
        // Otherwise never resolves (hangs)
      })
    })

    const adapter = makeAdapter()
    const sendPromise = adapter.send('background result')

    vi.advanceTimersByTime(ANNOUNCE_TIMEOUT_MS + 100)
    await vi.runAllTimersAsync()

    await expect(sendPromise).resolves.toBeUndefined()
    // fetch was called exactly once — no re-announce
    expect(mockFetch).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  }, 10_000)

  // Case 8: HA_ACCESS_TOKEN absent → send() throws with clear error naming env var
  it('case 8: HA_ACCESS_TOKEN absent → send() throws naming the env var', async () => {
    delete process.env['HA_ACCESS_TOKEN']
    const adapter = makeAdapter()
    await expect(adapter.send('test')).rejects.toThrow(/HA_ACCESS_TOKEN/)
  })

  // Case 9: wantsReply=false default → URL ends in /announce not /start_conversation
  it('case 9: wantsReply=false default → URL path ends in /announce', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const adapter = makeAdapter()
    await adapter.send('background announce')
    const callArgs = mockFetch.mock.calls[0]
    expect(callArgs).toBeDefined()
    if (callArgs) {
      const [url] = callArgs as [string]
      expect(url).toMatch(/\/announce$/)
      expect(url).not.toMatch(/start_conversation/)
    }
  })
})
