import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LLMApiError, classifyLLMStatus, parseRetryAfter } from './util.js'
import type { LLMProvider, LLMOptions, LLMResponse, ToolDefinition } from '../types/llm.js'
import type { Message, ToolCall } from '../types/core.js'

// ─── OAuth constants ──────────────────────────────────────────────────────────
// Sourced from badlogic/pi-mono (the OAuth library OpenClaw uses):
// packages/ai/src/utils/oauth/openai-codex.ts
//
// The redirect URI and port (1455) are fixed by the OAuth client registration
// with OpenAI — changing them requires registering a new client ID. If running
// behind an SSH tunnel, forward port 1455 alongside the dashboard port.
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OPENAI_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_OAUTH_SCOPES = 'openid profile email offline_access'

// ─── Codex endpoint ───────────────────────────────────────────────────────────

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses'

// ─── Token persistence ────────────────────────────────────────────────────────

/** Atomically write updated OAuth tokens back to $SHROK_WORKSPACE_PATH/.env */
function persistOAuthTokens(accessToken: string, refreshToken: string, expiresAt: number): void {
  const ws = process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'] ?? path.join(os.homedir(), '.shrok', 'workspace')
  const envFile = process.env['SHROK_ENV_FILE'] ?? path.join(ws, '.env')

  let lines: string[] = []
  try {
    lines = fs.readFileSync(envFile, 'utf8').split('\n')
  } catch {
    fs.mkdirSync(path.dirname(envFile), { recursive: true })
  }

  const updates: Record<string, string> = {
    OPENAI_OAUTH_ACCESS_TOKEN: accessToken,
    OPENAI_OAUTH_REFRESH_TOKEN: refreshToken,
    OPENAI_OAUTH_EXPIRES_AT: String(expiresAt),
  }
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(`${key}=`))
    if (idx !== -1) {
      lines[idx] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
  }

  const tmp = `${envFile}.tmp.${process.pid}`
  fs.writeFileSync(tmp, lines.join('\n').trimEnd() + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, envFile)
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────

/** Extract the chatgpt_account_id from the OAuth access token JWT. */
function extractAccountId(accessToken: string): string {
  try {
    const part = accessToken.split('.')[1]
    if (!part) return ''
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return (payload['https://api.openai.com/auth'] as Record<string, string>)?.chatgpt_account_id ?? ''
  } catch {
    return ''
  }
}

// ─── Message translation ─────────────────────────────────────────────────────

type CodexContentItem = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' } | { type: 'output_text'; text: string }

type CodexInputItem =
  | { type: 'message'; role: 'user'; content: string | CodexContentItem[] }
  | { type: 'message'; role: 'assistant'; content: string | CodexContentItem[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

function toCodexInput(messages: Message[]): CodexInputItem[] {
  const result: CodexInputItem[] = []

  for (const msg of messages) {
    switch (msg.kind) {
      case 'text':
        if (msg.role === 'user') {
          if (msg.attachments?.length) {
            result.push({ type: 'message', role: 'user', content: msg.content })
          } else {
            result.push({ type: 'message', role: 'user', content: msg.content })
          }
        } else {
          result.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
        }
        break

      case 'tool_call':
        if (msg.content) {
          result.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
        }
        for (const tc of msg.toolCalls) {
          result.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) })
        }
        break

      case 'tool_result':
        for (const tr of msg.toolResults) {
          result.push({ type: 'function_call_output', call_id: tr.toolCallId, output: tr.content })
        }
        break

      case 'summary':
        result.push({
          type: 'message',
          role: 'user',
          content: `[Summary of conversation from ${msg.summarySpan[0]} to ${msg.summarySpan[1]}]:\n${msg.content}`,
        })
        break
    }
  }

  return result
}

function toCodexTools(tools: ToolDefinition[]) {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

interface CodexResponseOutput {
  type: string
  call_id?: string
  name?: string
  arguments?: string
  content?: { type: string; text: string }[]
}

interface CodexCompletedResponse {
  model: string
  output: CodexResponseOutput[]
  usage: { input_tokens: number; output_tokens: number }
  status: string
  incomplete_details?: { reason?: string } | null
}

/** Read the SSE stream and return the completed response object. */
async function readCodexStream(response: Response): Promise<CodexCompletedResponse> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw) continue

      let event: { type: string; response?: CodexCompletedResponse }
      try { event = JSON.parse(raw) } catch { continue }

      if (event.type === 'response.completed' && event.response) {
        reader.cancel()
        return event.response
      }
    }
  }

  throw new LLMApiError('Codex stream ended without response.completed', 'unknown', undefined, 'openai-oauth')
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OpenAIOAuthProvider implements LLMProvider {
  readonly name = 'openai'

  private accessToken: string
  private refreshToken: string
  private expiresAt: number  // unix epoch seconds
  private accountId: string

  constructor(accessToken: string, refreshToken: string, expiresAt: number) {
    this.accessToken = accessToken
    this.refreshToken = refreshToken
    this.expiresAt = expiresAt
    this.accountId = extractAccountId(accessToken)
  }

  private isExpired(): boolean {
    return Math.floor(Date.now() / 1000) >= this.expiresAt - 60  // 60s buffer
  }

  private async doRefresh(): Promise<void> {
    const resp = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OPENAI_OAUTH_CLIENT_ID,
        refresh_token: this.refreshToken,
      }),
    })
    if (!resp.ok) {
      throw new LLMApiError(`OpenAI OAuth token refresh failed (${resp.status})`, 'auth', resp.status, 'openai-oauth')
    }
    const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number }
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token
    this.expiresAt = Math.floor(Date.now() / 1000) + data.expires_in
    this.accountId = extractAccountId(this.accessToken)
    persistOAuthTokens(this.accessToken, this.refreshToken, this.expiresAt)
  }

  private async refreshIfNeeded(): Promise<void> {
    if (this.isExpired()) await this.doRefresh()
  }

  private makeHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'chatgpt-account-id': this.accountId,
      'OpenAI-Beta': 'responses=experimental',
      'originator': 'codex_cli_rs',
      'Content-Type': 'application/json',
    }
  }

  private async callCodex(input: CodexInputItem[], tools: ReturnType<typeof toCodexTools>, options: LLMOptions): Promise<CodexCompletedResponse> {
    const body = {
      model: options.model,
      instructions: options.systemPrompt ?? 'You are a helpful assistant.',
      input,
      store: false,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
    }

    const resp = await fetch(CODEX_API_URL, {
      method: 'POST',
      headers: this.makeHeaders(),
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errorBody = await resp.json().catch(() => ({})) as {
        detail?: string
        error?: { type?: string; message?: string; resets_in_seconds?: number }
      }
      const detail = errorBody.error?.message ?? errorBody.detail ?? `HTTP ${resp.status}`
      // Prefer resets_in_seconds from the quota error body; fall back to Retry-After header
      const retryAfterMs = resp.status === 429
        ? (errorBody.error?.resets_in_seconds != null
            ? errorBody.error.resets_in_seconds * 1000
            : parseRetryAfter(resp.headers.get('retry-after')))
        : undefined
      throw new LLMApiError(detail, classifyLLMStatus(resp.status), resp.status, 'openai-oauth', retryAfterMs)
    }

    return readCodexStream(resp)
  }

  async complete(messages: Message[], tools: ToolDefinition[], options: LLMOptions): Promise<LLMResponse> {
    await this.refreshIfNeeded()

    const input = toCodexInput(messages)
    const codexTools = toCodexTools(tools)

    try {
      const completed = await this.callCodex(input, codexTools, options)
      return parseCodexResponse(completed)
    } catch (err) {
      if (err instanceof LLMApiError) throw err

      // On 401, attempt one token refresh and retry
      const status = (err as { status?: number }).status
      if (status === 401) {
        try {
          await this.doRefresh()
          const completed = await this.callCodex(input, codexTools, options)
          return parseCodexResponse(completed)
        } catch (retryErr) {
          if (retryErr instanceof LLMApiError) throw retryErr
          const retryStatus = (retryErr as { status?: number }).status
          throw new LLMApiError((retryErr as Error).message, classifyLLMStatus(retryStatus), retryStatus, 'openai-oauth')
        }
      }

      throw new LLMApiError((err as Error).message, classifyLLMStatus(status), status, 'openai-oauth')
    }
  }
}

function parseCodexResponse(resp: CodexCompletedResponse): LLMResponse {
  let content = ''
  const toolCalls: ToolCall[] = []

  for (const item of resp.output) {
    if (item.type === 'message' && item.content) {
      content = item.content
        .filter(c => c.type === 'output_text')
        .map(c => c.text)
        .join('')
    } else if (item.type === 'function_call' && item.call_id && item.name && item.arguments != null) {
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        input: JSON.parse(item.arguments) as Record<string, unknown>,
      })
    }
  }

  const stopReason: LLMResponse['stopReason'] =
    toolCalls.length > 0 ? 'tool_use'
    : resp.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens'
    : 'end_turn'

  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    stopReason,
    model: resp.model,
  }
}
