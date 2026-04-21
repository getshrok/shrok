import { callMcpTool, resolveMcpBin } from '../sub-agents/mcp-stdio.js'
import type { ToolDefinition } from '../types/llm.js'
import { DESCRIPTION_PARAM_SPEC } from '../tool-description.js'

// ─── Definitions ──────────────────────────────────────────────────────────────

export const WEB_SEARCH_DEF: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for current information. Returns titles, URLs, and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      max_results: { type: 'number', description: 'Maximum results to return (default 5, max 10).' },
    },
    required: ['query'],
  },
}

export const WEB_FETCH_DEF: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its content as clean readable text.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
      url: { type: 'string', description: 'The URL to fetch.' },
    },
    required: ['description', 'url'],
  },
}

// ─── Executors ────────────────────────────────────────────────────────────────

export async function executeWebSearch(input: Record<string, unknown>): Promise<string> {
  const query = input['query'] as string
  const maxResults = Math.min(Number(input['max_results'] ?? 5), 10)
  const provider = (process.env['SEARCH_PROVIDER'] ?? 'tavily').toLowerCase()

  if (provider === 'brave') {
    const key = process.env['BRAVE_API_KEY']
    if (!key) throw new Error('BRAVE_API_KEY is not set')
    const serverPath = resolveMcpBin('@brave/brave-search-mcp-server', 'dist/index.js')
    return callMcpTool(serverPath, { BRAVE_API_KEY: key }, 'brave_web_search', { query, count: maxResults })
  }

  if (provider === 'tavily') {
    const key = process.env['TAVILY_API_KEY']
    if (!key) throw new Error('TAVILY_API_KEY is not set')
    const serverPath = resolveMcpBin('tavily-mcp', 'build/index.js')
    return callMcpTool(serverPath, { TAVILY_API_KEY: key }, 'tavily_search', { query, max_results: maxResults })
  }

  throw new Error(`Unknown SEARCH_PROVIDER: ${provider}. Supported: tavily, brave`)
}

export async function executeWebFetch(input: Record<string, unknown>): Promise<string> {
  const url = input['url'] as string

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`web_fetch: invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`web_fetch: unsupported scheme "${parsed.protocol}" — only http and https are allowed`)
  }

  const MAX_CHARS = 50_000
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`web_fetch HTTP ${res.status} for ${url}`)
  const text = await res.text()
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n\n[truncated]' : text
}
