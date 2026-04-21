import * as fs from 'node:fs'
import { z } from 'zod'
import type { AgentToolEntry, AgentContext } from '../types/agent.js'
import type { ToolDefinition } from '../types/llm.js'
import { listMcpTools, callMcpToolStdio, parseStdioCommand } from '../sub-agents/mcp-stdio.js'

// ─── mcp.json schema ──────────────────────────────────────────────────────────

const McpHttpEntry = z.object({
  url: z.string().url(),
})

const McpStdioEntry = z.object({
  command: z.string().min(1),
  env: z.record(z.string()).optional(),
})

const McpEntry = z.union([McpHttpEntry, McpStdioEntry])

const McpConfigFile = z.record(z.string(), McpEntry)

export type McpConfig = z.infer<typeof McpConfigFile>

// ─── McpRegistry ──────────────────────────────────────────────────────────────

export interface McpRegistry {
  /** Load all tools for a capability as AgentToolEntry[]. Throws on error. */
  loadTools(capability: string): Promise<AgentToolEntry[]>
  listCapabilities(): string[]
}

export class McpRegistryImpl implements McpRegistry {
  private config: McpConfig
  private timeoutMs: number

  constructor(config: McpConfig, timeoutMs = 30_000) {
    this.config = config
    this.timeoutMs = timeoutMs
  }

  static fromFile(filePath: string, timeoutMs = 30_000): McpRegistryImpl {
    if (!fs.existsSync(filePath)) return new McpRegistryImpl({}, timeoutMs)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
      throw new Error(`[mcp] Failed to parse ${filePath}: ${(err as Error).message}`)
    }
    const result = McpConfigFile.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      throw new Error(`[mcp] Invalid mcp.json:\n${issues}`)
    }
    return new McpRegistryImpl(result.data, timeoutMs)
  }

  listCapabilities(): string[] {
    return Object.keys(this.config)
  }

  async loadTools(capability: string): Promise<AgentToolEntry[]> {
    const entry = this.config[capability]
    if (!entry) throw new Error(`[mcp] Unknown capability: ${capability}`)

    if ('url' in entry) {
      return fetchMcpToolsHttp(entry.url, capability)
    } else {
      return fetchMcpToolsStdio(parseStdioCommand(entry.command, entry.env), capability, this.timeoutMs)
    }
  }
}

// ─── HTTP transport ───────────────────────────────────────────────────────────

interface McpJsonRpcResponse {
  result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
  error?: { message: string }
}

async function fetchMcpToolsHttp(endpoint: string, capability: string): Promise<AgentToolEntry[]> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new Error(`[mcp] Failed to connect to ${capability} at ${endpoint}: ${(err as Error).message}`)
  }

  if (!response.ok) {
    throw new Error(`[mcp] ${capability} returned HTTP ${response.status} at ${endpoint}`)
  }

  let body: McpJsonRpcResponse
  try {
    body = await response.json() as McpJsonRpcResponse
  } catch {
    throw new Error(`[mcp] ${capability} returned non-JSON response`)
  }

  if (body.error) throw new Error(`[mcp] ${capability} tools/list error: ${body.error.message}`)

  const tools = body.result?.tools ?? []

  return tools.map(tool => {
    const prefixedName = `${capability}__${tool.name}`
    const definition: ToolDefinition = {
      name: prefixedName,
      description: tool.description ?? `${capability} tool: ${tool.name}`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }
    const execute = async (input: Record<string, unknown>, _ctx: AgentContext): Promise<string> => {
      let callResponse: Response
      try {
        callResponse = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: tool.name, arguments: input }, id: 1 }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        throw new Error(`[mcp] ${capability}__${tool.name} call failed: ${(err as Error).message}`)
      }
      if (!callResponse.ok) throw new Error(`[mcp] ${capability}__${tool.name} returned HTTP ${callResponse.status}`)
      interface CallResponse {
        result?: { content?: Array<{ type: string; text?: string }> }
        error?: { message: string }
      }
      const callBody = await callResponse.json() as CallResponse
      if (callBody.error) throw new Error(`[mcp] ${capability}__${tool.name} error: ${callBody.error.message}`)
      const content = callBody.result?.content ?? []
      return content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text!).join('\n') || JSON.stringify(callBody.result)
    }
    return { definition, execute }
  })
}

// ─── Stdio transport ──────────────────────────────────────────────────────────

import type { McpStdioConfig } from '../sub-agents/mcp-stdio.js'

async function fetchMcpToolsStdio(cfg: McpStdioConfig, capability: string, timeoutMs: number): Promise<AgentToolEntry[]> {
  const tools = await listMcpTools(cfg, timeoutMs)

  return tools.map(tool => {
    const prefixedName = `${capability}__${tool.name}`
    const definition: ToolDefinition = {
      name: prefixedName,
      description: tool.description ?? `${capability} tool: ${tool.name}`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }
    const execute = async (input: Record<string, unknown>, _ctx: AgentContext): Promise<string> => {
      return callMcpToolStdio(cfg, tool.name, input, timeoutMs)
    }
    return { definition, execute }
  })
}

// ─── Legacy export (used by mcp.test.ts) ─────────────────────────────────────

/** @deprecated Use McpRegistryImpl.fromFile() instead. */
export async function fetchMcpTools(endpoint: string, capability: string): Promise<AgentToolEntry[]> {
  return fetchMcpToolsHttp(endpoint, capability)
}
