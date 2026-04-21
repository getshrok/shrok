import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

export function resolveMcpBin(packageName: string, binPath: string): string {
  return _require.resolve(`${packageName}/${binPath}`)
}

export interface McpStdioConfig {
  /** The executable to run, e.g. 'node', 'npx', 'python'. */
  command: string
  /** Arguments passed to the executable. */
  args: string[]
  /** Extra environment variables merged on top of process.env. */
  env?: Record<string, string>
}

/** Parse a command string like "npx -y @mcp/server" into McpStdioConfig. */
export function parseStdioCommand(commandStr: string, env?: Record<string, string>): McpStdioConfig {
  const parts = commandStr.trim().split(/\s+/)
  const cfg: McpStdioConfig = { command: parts[0]!, args: parts.slice(1) }
  if (env !== undefined) cfg.env = env
  return cfg
}

/** Build a McpStdioConfig for an already-resolved node binary path. */
export function nodeServer(serverPath: string, env?: Record<string, string>): McpStdioConfig {
  const cfg: McpStdioConfig = { command: 'node', args: [serverPath] }
  if (env !== undefined) cfg.env = env
  return cfg
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP ${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

async function withMcpClient<T>(cfg: McpStdioConfig, fn: (client: Client) => Promise<T>, timeoutMs: number): Promise<T> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'shrok', version: '1.0.0' }, { capabilities: {} })
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'connect')
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

export interface McpToolSchema {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export async function listMcpTools(cfg: McpStdioConfig, timeoutMs = 30_000): Promise<McpToolSchema[]> {
  return withMcpClient(cfg, async client => {
    const result = await withTimeout(client.listTools(), timeoutMs, 'listTools')
    return (result.tools ?? []) as McpToolSchema[]
  }, timeoutMs)
}

export async function callMcpToolStdio(
  cfg: McpStdioConfig,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<string> {
  return withMcpClient(cfg, async client => {
    const result = await client.callTool(
      { name: toolName, arguments: toolArgs },
      undefined,
      { timeout: timeoutMs },
    )
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>
    return content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n') || JSON.stringify(result)
  }, timeoutMs)
}

// ─── Backward-compat wrapper used by registry.ts search tools ─────────────────

export async function callMcpTool(
  serverPath: string,
  env: Record<string, string>,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<string> {
  return callMcpToolStdio(nodeServer(serverPath, env), toolName, toolArgs, timeoutMs)
}
