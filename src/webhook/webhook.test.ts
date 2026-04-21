import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as crypto from 'node:crypto'
import { WebhookListenerImpl } from './index.js'
import type { QueueStore } from '../db/queue.js'
import { PRIORITY } from '../types/core.js'

function makeQueueStore(): QueueStore {
  return {
    enqueue: vi.fn(),
    claimNext: vi.fn(),
    ack: vi.fn(),
    fail: vi.fn(),
    requeueStale: vi.fn(),
  } as unknown as QueueStore
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
}

async function post(
  port: number,
  source: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  const resp = await fetch(`http://127.0.0.1:${port}/webhook/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })
  const data = await resp.json()
  return { status: resp.status, data }
}

/** Find a free port by binding to :0 */
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

describe('WebhookListenerImpl', () => {
  let queueStore: QueueStore
  let listener: WebhookListenerImpl
  let port: number
  const SECRET = 'test-secret-key'

  beforeEach(async () => {
    port = await getFreePort()
    queueStore = makeQueueStore()
  })

  afterEach(async () => {
    await listener?.stop()
  })

  it('returns 503 when no secret is configured', async () => {
    listener = new WebhookListenerImpl(queueStore, port, undefined, 60)
    await listener.start()

    const body = JSON.stringify({ event: 'push', repo: 'shrok' })
    const { status } = await post(port, 'github', body)

    expect(status).toBe(503)
    expect(queueStore.enqueue).not.toHaveBeenCalled()
  })

  it('returns 200 and enqueues a webhook event (with secret)', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const body = JSON.stringify({ event: 'push', repo: 'shrok' })
    const sig = sign(SECRET, body)
    const { status, data } = await post(port, 'github', body, { 'x-hub-signature-256': sig })

    expect(status).toBe(200)
    expect(data).toMatchObject({ ok: true })
    expect(queueStore.enqueue).toHaveBeenCalledOnce()
    const [event, priority] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect(event.type).toBe('webhook')
    expect((event as { source: string }).source).toBe('github')
    expect(priority).toBe(PRIORITY.WEBHOOK)
  })

  it('returns 200 with valid HMAC signature', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const body = JSON.stringify({ event: 'deploy' })
    const sig = sign(SECRET, body)
    const { status } = await post(port, 'ci', body, { 'x-hub-signature-256': sig })

    expect(status).toBe(200)
    expect(queueStore.enqueue).toHaveBeenCalled()
  })

  it('returns 401 with wrong signature', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const body = JSON.stringify({ event: 'deploy' })
    const { status } = await post(port, 'ci', body, { 'x-hub-signature-256': 'sha256=deadbeef' })

    expect(status).toBe(401)
    expect(queueStore.enqueue).not.toHaveBeenCalled()
  })

  it('returns 401 with missing signature when secret is configured', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const { status } = await post(port, 'ci', '{}')
    expect(status).toBe(401)
    expect(queueStore.enqueue).not.toHaveBeenCalled()
  })

  it('returns 429 when rate limit exceeded', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 2)
    await listener.start()

    const body = '{}'
    const sig = sign(SECRET, body)
    const headers = { 'x-hub-signature-256': sig }
    await post(port, 'flaky', body, headers)
    await post(port, 'flaky', body, headers)
    const { status } = await post(port, 'flaky', body, headers)

    expect(status).toBe(429)
  })

  it('rate limit is per-source', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 1)
    await listener.start()

    const body = '{}'
    const sig = sign(SECRET, body)
    const headers = { 'x-hub-signature-256': sig }

    // Source A hits limit
    await post(port, 'source-a', body, headers)
    const a2 = await post(port, 'source-a', body, headers)
    expect(a2.status).toBe(429)

    // Source B is independent
    const b1 = await post(port, 'source-b', body, headers)
    expect(b1.status).toBe(200)
  })

  it('extracts event from query param', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const body = '{}'
    const sig = sign(SECRET, body)
    const resp = await fetch(`http://127.0.0.1:${port}/webhook/myapp?event=custom_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body,
    })
    expect(resp.status).toBe(200)
    const [event] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect((event as { event: string }).event).toBe('custom_event')
  })

  it('defaults event to "webhook" when not specified', async () => {
    listener = new WebhookListenerImpl(queueStore, port, SECRET, 60)
    await listener.start()

    const body = '{}'
    const sig = sign(SECRET, body)
    await post(port, 'x', body, { 'x-hub-signature-256': sig })
    const [event] = vi.mocked(queueStore.enqueue).mock.calls[0]!
    expect((event as { event: string }).event).toBe('webhook')
  })
})
