/** Generate a short unique ID, optionally with a prefix. */
export function generateId(prefix: string = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** Slugify a name for use as an ID prefix: lowercase, dashes, alphanumeric only. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent'
}

/** Generate a human-readable agent ID. Format: {slug}_{6-char base36 suffix}. */
export function generateAgentId(name: string): string {
  const slug = slugify(name)
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `${slug}_${suffix}`
}

/** Take the slug prefix of an agent ID (everything before the last underscore).
 *  For new IDs ({slug}_{suffix}) this is the human-readable slug.
 *  For old IDs (tent_xxx_yyy) the prefix is "tent_xxx" — still unique, just ugly. */
export function shortAgentId(id: string): string {
  const lastUnderscore = id.lastIndexOf('_')
  if (lastUnderscore <= 0) return id.slice(0, 30)
  return id.slice(0, lastUnderscore).slice(0, 30)
}

/** Current time as ISO 8601 string. */
export function now(): string {
  return new Date().toISOString()
}

export type LLMErrorType = 'auth' | 'rate_limit' | 'server_error' | 'unknown'

export class LLMApiError extends Error {
  readonly type: LLMErrorType
  readonly status: number | undefined
  readonly provider: string
  readonly retryAfterMs: number | undefined

  constructor(message: string, type: LLMErrorType, status: number | undefined, provider: string, retryAfterMs?: number) {
    super(message)
    this.name = 'LLMApiError'
    this.type = type
    this.status = status
    this.provider = provider
    this.retryAfterMs = retryAfterMs
  }
}

export function classifyLLMStatus(status: number | undefined): LLMErrorType {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 500 || status === 502 || status === 503 || status === 529) return 'server_error'
  return 'unknown'
}

/**
 * Parse a Retry-After header value (seconds or HTTP-date) into milliseconds.
 * Returns undefined if the value can't be parsed.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const secs = parseFloat(value)
  if (!isNaN(secs) && secs >= 0) return Math.ceil(secs) * 1000
  const date = new Date(value)
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now())
  return undefined
}

/**
 * Extract and parse the first JSON object from a model response.
 * Handles markdown fences (```json ... ```) and leading/trailing prose.
 */
export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return JSON.parse(fenced[1].trim())
  const braced = content.match(/\{[\s\S]*\}/)
  if (braced) return JSON.parse(braced[0])
  return JSON.parse(content.trim())
}

/** Exponential backoff retry. Retries on errors whose `.status` matches retryableStatuses. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryableStatuses: number[],
  maxRetries = 3
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { status?: number }).status
      if (attempt === maxRetries || !retryableStatuses.includes(status ?? -1)) throw err
      const delayMs = Math.pow(2, attempt) * 1000
      await new Promise(resolve => setTimeout(resolve, delayMs))
      lastErr = err
    }
  }
  throw lastErr
}
