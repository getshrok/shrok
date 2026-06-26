// src/apps/adapter.test.ts
// Tests for the Express<->web-Fetch bridge (D-06/D-07).
// toWebRequest(req, body) builds a web Request from a parsed body string.
// sendWeb(webRes, res) copies the web Response back onto an Express response mock.
import { describe, it, expect, vi } from 'vitest'
import { toWebRequest, sendWeb } from './adapter.js'

// ── helpers: minimal Express req/res mocks ────────────────────────────────────

type MockReq = {
  method: string
  originalUrl: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

type MockRes = {
  status: (code: number) => MockRes
  setHeader: (k: string, v: string) => MockRes
  send: (body: string) => MockRes
  _status: number
  _headers: Record<string, string>
  _body: string
}

function makeReq(overrides?: Partial<MockReq>): MockReq {
  return {
    method: 'POST',
    originalUrl: '/apps/notes/api/action',
    headers: {
      'content-type': 'application/json',
      'x-custom': 'value',
    },
    body: { name: 'test-action', state: {} },
    ...overrides,
  }
}

function makeRes(): MockRes {
  const res: MockRes = {
    _status: 200,
    _headers: {},
    _body: '',
    status(code: number) {
      res._status = code
      return res
    },
    setHeader(k: string, v: string) {
      res._headers[k] = v
      return res
    },
    send(body: string) {
      res._body = body
      return res
    },
  }
  return res
}

// ── toWebRequest ─────────────────────────────────────────────────────────────

describe('toWebRequest', () => {
  it('produces a global Request with the correct method', () => {
    const req = makeReq({ method: 'POST' })
    const body = JSON.stringify(req.body)
    const webReq = toWebRequest(req as never, body)
    expect(webReq.method).toBe('POST')
  })

  it('constructs the URL from originalUrl', () => {
    const req = makeReq({ originalUrl: '/apps/notes/api/action' })
    const webReq = toWebRequest(req as never, 'null')
    expect(webReq.url).toContain('/apps/notes/api/action')
  })

  it('round-trips a {name,state} JSON body', async () => {
    const payload = { name: 'save', state: { title: 'hello' } }
    const req = makeReq({ body: payload })
    const body = JSON.stringify(payload)
    const webReq = toWebRequest(req as never, body)
    const parsed = await webReq.json() as typeof payload
    expect(parsed.name).toBe('save')
    expect(parsed.state.title).toBe('hello')
  })

  it('copies content-type from req.headers', () => {
    const req = makeReq()
    const webReq = toWebRequest(req as never, '{}')
    expect(webReq.headers.get('content-type')).toBe('application/json')
  })

  it('copies arbitrary headers like x-custom', () => {
    const req = makeReq()
    const webReq = toWebRequest(req as never, '{}')
    expect(webReq.headers.get('x-custom')).toBe('value')
  })

  it('omits content-length (let fetch recompute)', () => {
    const req = makeReq({
      headers: { 'content-type': 'application/json', 'content-length': '42' },
    })
    const webReq = toWebRequest(req as never, '{}')
    expect(webReq.headers.get('content-length')).toBeNull()
  })

  it('omits host (let fetch recompute)', () => {
    const req = makeReq({
      headers: { 'content-type': 'application/json', host: 'example.com' },
    })
    const webReq = toWebRequest(req as never, '{}')
    expect(webReq.headers.get('host')).toBeNull()
  })

  it('skips header values that are arrays (express multi-value fallback)', () => {
    const req = makeReq({
      headers: {
        'content-type': 'application/json',
        // Express may return string[] for headers with multiple values
        'x-multi': ['a', 'b'],
      },
    })
    // Should not throw, multi-value headers are skipped or handled gracefully
    expect(() => toWebRequest(req as never, '{}')).not.toThrow()
  })
})

// ── sendWeb ───────────────────────────────────────────────────────────────────

describe('sendWeb', () => {
  it('copies status code to res', async () => {
    const webRes = new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
    const res = makeRes()
    await sendWeb(webRes, res as never)
    expect(res._status).toBe(201)
  })

  it('copies response body text to res', async () => {
    const webRes = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const res = makeRes()
    await sendWeb(webRes, res as never)
    expect(res._body).toBe('{"ok":true}')
  })

  it('copies content-type header to res', async () => {
    const webRes = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    const res = makeRes()
    await sendWeb(webRes, res as never)
    expect(res._headers['content-type']).toContain('application/json')
  })

  it('handles a 400 error response correctly', async () => {
    const webRes = new Response(JSON.stringify({ ok: false, errors: [] }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
    const res = makeRes()
    await sendWeb(webRes, res as never)
    expect(res._status).toBe(400)
    expect(res._body).toContain('errors')
  })
})
