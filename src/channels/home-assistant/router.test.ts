// src/channels/home-assistant/router.test.ts
//
// Standalone Express integration suite — no DashboardServer, no live HA device.
// Drives adapter.send() directly to simulate the head's reply.
// Covers HACV-01..05, SC4, D-04.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { HomeAssistantChannelAdapter } from './adapter.js'
import { createHomeAssistantRouter, REPLY_DEADLINE_MS } from './router.js'

const TEST_API_KEY = 'test-bearer-key-12345'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find a free ephemeral port by binding to :0 (mirrors webhook.test.ts pattern). */
async function getFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

/**
 * POST to /v1/chat/completions on the test server.
 * When bearerKey is omitted the Authorization header is not sent (tests 401 path).
 * Returns status, body, and the raw Response for header inspection.
 */
async function postCompletions(
  port: number,
  body: unknown,
  bearerKey?: string,
): Promise<{ status: number; body: unknown; rawResponse: Response }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearerKey !== undefined) headers['Authorization'] = `Bearer ${bearerKey}`
  const rawResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const responseBody: unknown = await rawResponse.json().catch(() => null)
  return { status: rawResponse.status, body: responseBody, rawResponse }
}

/**
 * Send `text` via the adapter once the pendingReply slot has been set.
 * Spies on dispatchInbound (called AFTER setPendingReply in the route handler) to
 * detect when the slot is ready, then calls adapter.send() on the next event-loop
 * tick to guarantee the route handler's void replyText.then() chain is registered.
 */
function setupSend(adapter: HomeAssistantChannelAdapter, text: string): void {
  const orig = adapter.dispatchInbound.bind(adapter)
  const spy = vi.spyOn(adapter, 'dispatchInbound').mockImplementation((inText, convId) => {
    orig(inText, convId)
    spy.mockRestore()
    // Use setImmediate to ensure the route handler's .then() is registered before
    // we resolve the slot (avoids calling resolve() before .then() is attached)
    setImmediate(() => { void adapter.send(text) })
  })
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

interface Fx {
  server: Server
  port: number
  adapter: HomeAssistantChannelAdapter
}

async function startServer(): Promise<Fx> {
  const adapter = new HomeAssistantChannelAdapter()
  const app = express()
  // Mount global JSON body parser (mirrors dashboard server.ts:142)
  app.use(express.json())
  // No CSRF middleware — testing the router directly, not DashboardServer
  app.use('/v1', createHomeAssistantRouter(adapter, TEST_API_KEY))
  const port = await getFreePort()
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  return { server, port, adapter }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('POST /v1/chat/completions', () => {
  let fx: Fx

  beforeEach(() => {
    process.env['HA_INBOUND_API_KEY'] = TEST_API_KEY
  })

  afterEach(async () => {
    if (fx?.server) await new Promise<void>(r => fx.server.close(() => r()))
    delete process.env['HA_INBOUND_API_KEY']
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── HACV-01: happy path ───────────────────────────────────────────────────

  describe('HACV-01 — valid bearer + user turn → OpenAI-compat body', () => {
    it('returns 200 with choices[0].message.content equal to the head reply', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'on it')
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        TEST_API_KEY,
      )
      expect(result.status).toBe(200)
      const body = result.body as Record<string, unknown>
      const choices = body['choices'] as Array<Record<string, unknown>>
      const choice = choices[0]
      expect(choice).toBeDefined()
      if (choice) {
        const message = choice['message'] as Record<string, unknown>
        expect(message['content']).toBe('on it')
      }
    })

    it('response has finish_reason: stop', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'done')
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      const choices = body['choices'] as Array<Record<string, unknown>>
      const choice = choices[0]
      expect(choice).toBeDefined()
      if (choice) {
        expect(choice['finish_reason']).toBe('stop')
      }
    })

    it('response has zeroed usage', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'done')
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      expect(body['usage']).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      })
    })

    it('response has object: chat.completion', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'done')
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })
  })

  // ── HACV-02: bearer auth failures ────────────────────────────────────────

  describe('HACV-02 — missing/invalid bearer → JSON 401 (no WWW-Authenticate)', () => {
    it('POST with NO Authorization header → status 401, body { error: Unauthorized }', async () => {
      fx = await startServer()
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        // no bearerKey
      )
      expect(result.status).toBe(401)
      expect(result.body).toEqual({ error: 'Unauthorized' })
    })

    it('response has NO www-authenticate header (Shrok JSON 401, not Apache Basic 401)', async () => {
      fx = await startServer()
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
      )
      // Assert the header is absent (HACV-02 / T-41-08)
      expect(result.rawResponse.headers.get('www-authenticate')).toBeNull()
    })

    it('POST with wrong bearer → status 401', async () => {
      fx = await startServer()
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hello' }] },
        'wrong-key-zzzz',
      )
      expect(result.status).toBe(401)
      expect(result.body).toEqual({ error: 'Unauthorized' })
    })

    it('CR-01: empty configured key rejects `Authorization: Bearer ` (empty token) — self-contained auth boundary', async () => {
      // Simulate the prior server.ts `?? ''` fallback reaching the router with an
      // empty key. The router must reject ALL requests rather than letting a
      // Bearer-with-empty-token through. (adapter ctor passes — env key is set in beforeEach.)
      const adapter = new HomeAssistantChannelAdapter()
      const app = express()
      app.use(express.json())
      app.use('/v1', createHomeAssistantRouter(adapter, ''))
      const port = await getFreePort()
      const server = await new Promise<Server>((resolve, reject) => {
        const s = app.listen(port, '127.0.0.1', () => resolve(s))
        s.once('error', reject)
      })
      fx = { server, port, adapter } // let afterEach close it
      const result = await postCompletions(
        port,
        { messages: [{ role: 'user', content: 'pwn' }] },
        '', // sends literal `Authorization: Bearer ` with an empty token
      )
      expect(result.status).toBe(401)
      expect(result.body).toEqual({ error: 'Unauthorized' })
    })
  })

  // ── HACV-03: last user turn extraction ───────────────────────────────────

  describe('HACV-03 — last role:user extracted; no-user-turn → 400', () => {
    it('only the LAST user turn text is dispatched (HACV-03)', async () => {
      fx = await startServer()
      const dispatched: string[] = []
      // Spy BEFORE setupSend so we can capture the text
      const origDispatch = fx.adapter.dispatchInbound.bind(fx.adapter)
      vi.spyOn(fx.adapter, 'dispatchInbound').mockImplementation((text, conversationId) => {
        dispatched.push(text)
        origDispatch(text, conversationId)
        vi.restoreAllMocks()
        setImmediate(() => { void fx.adapter.send('response') })
      })

      const result = await postCompletions(
        fx.port,
        {
          messages: [
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'newest' },
          ],
        },
        TEST_API_KEY,
      )

      expect(result.status).toBe(200)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]).toBe('newest')
    })

    it('messages[] with no role:user → 400', async () => {
      fx = await startServer()
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'assistant', content: 'hi' }] },
        TEST_API_KEY,
      )
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ error: expect.stringContaining('No user message') })
    })

    it('empty messages[] → 400', async () => {
      fx = await startServer()
      const result = await postCompletions(
        fx.port,
        { messages: [] },
        TEST_API_KEY,
      )
      expect(result.status).toBe(400)
    })
  })

  // ── HACV-05: conversation_id echo / generate ──────────────────────────────

  describe('HACV-05 — conversation_id echoed or server-generated', () => {
    it('echoes conversation_id from request body', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'reply')
      const result = await postCompletions(
        fx.port,
        {
          messages: [{ role: 'user', content: 'hi' }],
          conversation_id: 'conv-xyz',
        },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      expect(body['conversation_id']).toBe('conv-xyz')
    })

    it('generates a server-side UUID when conversation_id is missing', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'reply')
      const result = await postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'hi' }] },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      const convId = body['conversation_id'] as string
      expect(typeof convId).toBe('string')
      expect(convId.length).toBeGreaterThan(0)
      // Should be UUID-shaped
      expect(convId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('generates a server-side UUID when conversation_id is empty string', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'reply')
      const result = await postCompletions(
        fx.port,
        {
          messages: [{ role: 'user', content: 'hi' }],
          conversation_id: '',
        },
        TEST_API_KEY,
      )
      const body = result.body as Record<string, unknown>
      const convId = body['conversation_id'] as string
      expect(convId.length).toBeGreaterThan(0)
    })
  })

  // ── HACV-04 / D-01: deadline lapse ───────────────────────────────────────

  describe('HACV-04 / D-01 — deadline lapse sends no body; slot is cleared', () => {
    it('after deadline, adapter slot is cleared and a subsequent send() hits the null-slot path', async () => {
      vi.useFakeTimers()
      fx = await startServer()

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Detect when the slot is ready
      let slotReady = false
      const origSet = fx.adapter.setPendingReply.bind(fx.adapter)
      const setSpy = vi.spyOn(fx.adapter, 'setPendingReply').mockImplementation((pending) => {
        origSet(pending)
        setSpy.mockRestore()
        slotReady = true
      })

      // AbortController to avoid hanging the test runner after the deadline fires
      const controller = new AbortController()
      const postFetch = fetch(`http://127.0.0.1:${fx.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'slow' }] }),
        signal: controller.signal,
      })
      void postFetch.catch(() => {}) // swallow AbortError

      // Wait for the slot to be registered
      await vi.runAllTimersAsync()
      // Poll until slotReady (the setPendingReply spy fired)
      while (!slotReady) {
        await vi.runAllTimersAsync()
      }

      // Advance past the deadline to trigger the timer rejection
      vi.advanceTimersByTime(REPLY_DEADLINE_MS + 100)
      await vi.runAllTimersAsync()

      // Abort the pending fetch
      controller.abort()
      await vi.runAllTimersAsync()

      // After the deadline, the slot is cleared — send() hits null-slot announce path (Phase 42)
      vi.useRealTimers()
      process.env['HA_ACCESS_TOKEN'] = 'test-ha-token-deadlinetest'
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }))
      vi.stubGlobal('fetch', mockFetch)
      await fx.adapter.send('too late')
      // fetch was called once for the announce
      expect(mockFetch).toHaveBeenCalledTimes(1)
      delete process.env['HA_ACCESS_TOKEN']
      vi.unstubAllGlobals()

      warnSpy.mockRestore()
    })
  })

  // ── SC4: req.on('close') cleanup ─────────────────────────────────────────

  describe('SC4 — close event clears timer + slot on client abort', () => {
    it('after aborting, adapter.send() hits the null-slot path without throwing', async () => {
      fx = await startServer()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Detect when slot is ready
      let slotReady = false
      const origSet = fx.adapter.setPendingReply.bind(fx.adapter)
      const setSpy = vi.spyOn(fx.adapter, 'setPendingReply').mockImplementation((pending) => {
        origSet(pending)
        setSpy.mockRestore()
        slotReady = true
      })

      const controller = new AbortController()
      const postFetch = fetch(`http://127.0.0.1:${fx.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'abort me' }] }),
        signal: controller.signal,
      })
      void postFetch.catch(() => {}) // swallow AbortError

      // Poll until slot is ready
      while (!slotReady) {
        await new Promise<void>(r => setTimeout(r, 5))
      }

      // Abort the client connection
      controller.abort()

      // Give the server time to process the 'close' event
      await new Promise<void>(r => setTimeout(r, 100))

      // After close, slot should be cleared — send hits null-slot announce path (Phase 42)
      process.env['HA_ACCESS_TOKEN'] = 'test-ha-token-sc4test'
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }))
      vi.stubGlobal('fetch', mockFetch)
      await expect(fx.adapter.send('x')).resolves.toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(1)
      delete process.env['HA_ACCESS_TOKEN']
      vi.unstubAllGlobals()

      warnSpy.mockRestore()
    })
  })

  // ── D-04: concurrent turn replaces slot ──────────────────────────────────

  describe('D-04 — concurrent turn replaces slot (latest wins)', () => {
    it('second request resolves; first request lapses without producing a body', async () => {
      fx = await startServer()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Track setPendingReply calls to detect when each slot is registered
      let setCallCount = 0
      const origSet = fx.adapter.setPendingReply.bind(fx.adapter)
      const setSpy = vi.spyOn(fx.adapter, 'setPendingReply').mockImplementation((pending) => {
        origSet(pending)
        setCallCount++
      })

      const firstController = new AbortController()
      const firstFetch = fetch(`http://127.0.0.1:${fx.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] }),
        signal: firstController.signal,
      }).catch(() => null)

      // Wait for first slot to be registered
      while (setCallCount < 1) {
        await new Promise<void>(r => setTimeout(r, 5))
      }

      // Set up the second request's send before it starts
      // (we'll drive the second reply AFTER the second slot is set)
      let secondSlotReady = false
      setSpy.mockImplementation((pending) => {
        origSet(pending)
        setCallCount++
        secondSlotReady = true
        setSpy.mockRestore()
      })

      // Issue second POST (concurrent — replaces the first slot)
      const secondPostPromise = postCompletions(
        fx.port,
        { messages: [{ role: 'user', content: 'second' }] },
        TEST_API_KEY,
      )

      // Wait for second slot to be registered
      while (!secondSlotReady) {
        await new Promise<void>(r => setTimeout(r, 5))
      }

      // Drive the second slot's reply via a setImmediate to let everything settle
      await new Promise<void>(r => setImmediate(r))
      await fx.adapter.send('second response')

      const secondResult = await secondPostPromise
      expect(secondResult.status).toBe(200)
      const body = secondResult.body as Record<string, unknown>
      const choices = body['choices'] as Array<Record<string, unknown>>
      const choice = choices[0]
      expect(choice).toBeDefined()
      if (choice) {
        const message = choice['message'] as Record<string, unknown>
        expect(message['content']).toBe('second response')
      }

      // Clean up first fetch
      firstController.abort()
      await firstFetch

      warnSpy.mockRestore()
    })
  })

  // ── stream flag ignored (D-04 default) ────────────────────────────────────

  describe('stream: true flag is ignored (D-04 default)', () => {
    it('returns normal non-streaming JSON even when stream: true is set', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'non-streaming reply')
      const result = await postCompletions(
        fx.port,
        {
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
        TEST_API_KEY,
      )
      expect(result.status).toBe(200)
      const body = result.body as Record<string, unknown>
      expect(body['object']).toBe('chat.completion')
    })
  })

  // ── RING-08: Host/X-Forwarded-Proto base-URL capture ─────────────────────

  describe('RING-08 — Host header → adapter.cacheBaseUrl (non-loopback only)', () => {
    /**
     * POST helper that supports injecting arbitrary headers.
     * Unlike postCompletions() this allows the test to pass a Host header.
     */
    async function postWithHost(
      port: number,
      hostHeader: string,
      proto?: string,
    ): Promise<{ status: number; body: unknown }> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_API_KEY}`,
        'Host': hostHeader,
      }
      if (proto !== undefined) headers['X-Forwarded-Proto'] = proto
      const rawResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ring test' }] }),
      })
      const responseBody: unknown = await rawResponse.json().catch(() => null)
      return { status: rawResponse.status, body: responseBody }
    }

    it('non-loopback Host → caches http://<host>', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'ok')
      await postWithHost(fx.port, '192.168.111.69:8888')
      expect(fx.adapter.getDeviceReachableBaseUrl()).toBe('http://192.168.111.69:8888')
    })

    it('non-loopback Host + X-Forwarded-Proto: https → caches https://<host>', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'ok')
      await postWithHost(fx.port, 'jarvis.gigaashley.click', 'https')
      expect(fx.adapter.getDeviceReachableBaseUrl()).toBe('https://jarvis.gigaashley.click')
    })

    it('loopback Host 127.0.0.1 → cacheBaseUrl NOT called (getDeviceReachableBaseUrl stays null)', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'ok')
      await postWithHost(fx.port, '127.0.0.1:8888')
      expect(fx.adapter.getDeviceReachableBaseUrl()).toBeNull()
    })

    it('loopback Host localhost → cacheBaseUrl NOT called', async () => {
      fx = await startServer()
      setupSend(fx.adapter, 'ok')
      await postWithHost(fx.port, 'localhost:8888')
      expect(fx.adapter.getDeviceReachableBaseUrl()).toBeNull()
    })

    it('unauthenticated request with non-loopback Host → cacheBaseUrl NOT called', async () => {
      fx = await startServer()
      // No bearer token
      const res = await fetch(`http://127.0.0.1:${fx.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': '192.168.111.69:8888',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'pwn' }] }),
      })
      expect(res.status).toBe(401)
      expect(fx.adapter.getDeviceReachableBaseUrl()).toBeNull()
    })
  })
})
