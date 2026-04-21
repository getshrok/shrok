import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { McpRegistryImpl, fetchMcpTools } from './registry.js'

// ─── McpRegistryImpl ──────────────────────────────────────────────────────────

describe('McpRegistryImpl', () => {
  it('listCapabilities returns all registered capability names', () => {
    const reg = new McpRegistryImpl({
      email: { url: 'http://mcp-email:3100' },
      transactions: { url: 'http://mcp-tx:3101' },
    })
    expect(reg.listCapabilities().sort()).toEqual(['email', 'transactions'])
  })

  it('listCapabilities returns empty array for empty registry', () => {
    const reg = new McpRegistryImpl({})
    expect(reg.listCapabilities()).toEqual([])
  })

  it('loadTools rejects for unknown capability', async () => {
    const reg = new McpRegistryImpl({})
    await expect(reg.loadTools('nope')).rejects.toThrow('Unknown capability')
  })
})

// ─── fetchMcpTools ────────────────────────────────────────────────────────────

/** Start a minimal MCP-like HTTP server for testing. */
function startMcpServer(tools: Array<{ name: string; description?: string; inputSchema?: object }>) {
  let server: Server
  let port: number

  return {
    async start(): Promise<string> {
      const app = express()
      app.use(express.json())
      app.post('/', (req, res) => {
        const { method } = req.body as { method: string }
        if (method === 'tools/list') {
          res.json({ jsonrpc: '2.0', id: 1, result: { tools } })
        } else if (method === 'tools/call') {
          const { params } = req.body as { params: { name: string; arguments: unknown } }
          res.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{ type: 'text', text: `called ${params.name} with ${JSON.stringify(params.arguments)}` }],
            },
          })
        } else {
          res.status(400).json({ jsonrpc: '2.0', id: 1, error: { message: 'unknown method' } })
        }
      })
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, '127.0.0.1', () => resolve())
        server.once('error', reject)
      })
      port = (server!.address() as { port: number }).port
      return `http://127.0.0.1:${port}`
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    },
  }
}

describe('fetchMcpTools', () => {
  const mcpServer = startMcpServer([
    { name: 'list_unread', description: 'List unread emails', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_email', description: 'Send an email' },
  ])
  let endpoint: string

  beforeEach(async () => {
    endpoint = await mcpServer.start()
  })

  afterEach(async () => {
    await mcpServer.stop()
  })

  it('returns one AgentToolEntry per tool', async () => {
    const entries = await fetchMcpTools(endpoint, 'email')
    expect(entries).toHaveLength(2)
  })

  it('prefixes tool names with capability__', async () => {
    const entries = await fetchMcpTools(endpoint, 'email')
    const names = entries.map(e => e.definition.name)
    expect(names).toContain('email__list_unread')
    expect(names).toContain('email__send_email')
  })

  it('preserves descriptions', async () => {
    const entries = await fetchMcpTools(endpoint, 'email')
    const entry = entries.find(e => e.definition.name === 'email__list_unread')!
    expect(entry.definition.description).toBe('List unread emails')
  })

  it('sets a default description when missing', async () => {
    const server2 = startMcpServer([{ name: 'nodesc' }])
    const ep = await server2.start()
    try {
      const entries = await fetchMcpTools(ep, 'x')
      expect(entries[0]!.definition.description).toContain('nodesc')
    } finally {
      await server2.stop()
    }
  })

  it('execute calls tools/call and returns text content', async () => {
    const entries = await fetchMcpTools(endpoint, 'email')
    const entry = entries.find(e => e.definition.name === 'email__list_unread')!
    const result = await entry.execute(
      { folder: 'inbox' },
      { agentId: 't1', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() },
    )
    expect(result).toContain('list_unread')
    expect(result).toContain('inbox')
  })

  it('throws when the server is unreachable', async () => {
    await expect(fetchMcpTools('http://127.0.0.1:1', 'email')).rejects.toThrow()
  })

  it('throws when server returns HTTP error', async () => {
    const app = express()
    let errServer: Server
    const errApp = express()
    errApp.post('/', (_req, res) => res.status(500).send('Internal Error'))
    await new Promise<void>((resolve, reject) => {
      errServer = errApp.listen(0, '127.0.0.1', () => resolve())
      errServer.once('error', reject)
    })
    const errPort = (errServer!.address() as { port: number }).port
    try {
      await expect(fetchMcpTools(`http://127.0.0.1:${errPort}`, 'x')).rejects.toThrow('HTTP 500')
    } finally {
      await new Promise<void>(resolve => errServer.close(() => resolve()))
    }
    void app
  })

  it('throws when server returns JSON-RPC error', async () => {
    const errApp = express()
    errApp.use(express.json())
    errApp.post('/', (_req, res) => {
      res.json({ jsonrpc: '2.0', id: 1, error: { message: 'method not found' } })
    })
    let errServer: Server
    await new Promise<void>((resolve, reject) => {
      errServer = errApp.listen(0, '127.0.0.1', () => resolve())
      errServer.once('error', reject)
    })
    const errPort = (errServer!.address() as { port: number }).port
    try {
      await expect(fetchMcpTools(`http://127.0.0.1:${errPort}`, 'x')).rejects.toThrow('method not found')
    } finally {
      await new Promise<void>(resolve => errServer.close(() => resolve()))
    }
  })

  it('returns empty array when tools/list returns no tools', async () => {
    const emptyServer = startMcpServer([])
    const ep = await emptyServer.start()
    try {
      const entries = await fetchMcpTools(ep, 'empty')
      expect(entries).toEqual([])
    } finally {
      await emptyServer.stop()
    }
  })
})
