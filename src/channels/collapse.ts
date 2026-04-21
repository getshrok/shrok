/**
 * Collapse formatting helpers for Discord agent tool call messages.
 *
 * Agent tool calls arrive as verbose multi-line messages via sendDebug().
 * These helpers parse those messages and produce compact one-liner displays
 * for the collapsed state, plus manage the expand/collapse text.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedVerboseMessage {
  direction: 'call' | 'result'
  toolName: string
  /** Everything after the first newline in the parsed tool line */
  detail: string
  /** Agent prefix like "🔵 [agent-name]" if present in the original message */
  agentPrefix: string | null
}

// ─── Parse verbose message ────────────────────────────────────────────────────

/**
 * Parse a verbose debug message to detect if it's a tool call or result.
 *
 * Handles two formats:
 * - Raw: `→ toolName (desc)\n{json}` or `← toolName\ncontent`
 * - Agent-wrapped: `` ```\n🔵 [agent-name] → toolName (desc)\n{preview}\n``` ``
 *
 * Returns null for non-tool messages (plain text, thinking, system events).
 */
export function parseVerboseMessage(text: string): ParsedVerboseMessage | null {
  const trimmed = text.trim()

  // Strip agent-wrapped triple-backtick code blocks
  // Format: ```\n{circle} [{name}] → toolName ...\n{detail}\n```
  let inner = trimmed
  let agentPrefix: string | null = null
  if (inner.startsWith('```')) {
    // Remove leading ``` and trailing ```
    inner = inner.replace(/^```\n?/, '').replace(/\n?```$/, '').trim()
    // Capture and strip the colored circle + agent name prefix: "🔵 [agent-name] "
    const prefixMatch = inner.match(/^([\u{1F300}-\u{1FFFF}]\s*\[[^\]]*\])\s*/u)
    if (prefixMatch) {
      agentPrefix = prefixMatch[1]!
      inner = inner.slice(prefixMatch[0].length)
    }
  }

  // Now look for → (call) or ← (result) at the start of the line
  // → is U+2192, ← is U+2190
  const callMatch = inner.match(/^→\s+([\w-]+)(?: \([^)]*\))?\s*\n?([\s\S]*)$/)
  if (callMatch) {
    return {
      direction: 'call',
      toolName: callMatch[1]!,
      detail: callMatch[2]?.trim() ?? '',
      agentPrefix,
    }
  }

  const resultMatch = inner.match(/^←\s+([\w-]+)\s*\n?([\s\S]*)$/)
  if (resultMatch) {
    return {
      direction: 'result',
      toolName: resultMatch[1]!,
      detail: resultMatch[2]?.trim() ?? '',
      agentPrefix,
    }
  }

  return null
}

// ─── Collapse formatting ──────────────────────────────────────────────────────

/**
 * Format a collapsed one-liner for a tool call.
 *
 * Extracts a meaningful brief from the input when possible:
 * - file_path for read_file/write_file/edit_file
 * - url for web_search/fetch
 * - first arg for bash (not exposed in brief — too noisy)
 *
 * Format: `▸ toolName (brief) ...` or `▸ toolName ...` if no brief available.
 */
export function collapseToolCall(toolName: string, input?: unknown): string {
  const brief = extractInputBrief(toolName, input)
  if (brief) {
    return `\`▸ ${toolName} (${brief}) ...\``
  }
  return `\`▸ ${toolName} ...\``
}

/**
 * Format a collapsed one-liner for a tool result.
 *
 * Parses content for status indicators:
 * - `"error":true` → ERROR
 * - bash JSON with exit_code → `exit N`
 * - otherwise → OK
 *
 * Format: `▸ toolName → OK` or `▸ toolName (exit 0)` etc.
 */
export function collapseToolResult(toolName: string, content: string): string {
  const status = extractResultStatus(toolName, content)
  if (status.startsWith('exit ')) {
    return `\`▸ ${toolName} (${status})\``
  }
  return `\`▸ ${toolName} → ${status}\``
}

/**
 * Format the expanded (full) version of a verbose message.
 * Truncates to `limit` chars (default 1900 for Discord's 2000 char limit).
 * Pass 3900 for Telegram (4096 char limit minus HTML wrapper overhead).
 */
export function expandVerboseMessage(text: string, limit = 1900): string {
  if (text.length <= limit) return text
  return text.slice(0, limit)
}

/**
 * Escape HTML special characters for use in Telegram HTML parse mode.
 * Must be applied to ALL text content before wrapping in HTML tags.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Attempt to JSON.parse the detail portion of a verbose message.
 * The detail is everything after the first newline in the tool call line.
 */
export function tryParseInput(detail: string): unknown {
  const firstNewline = detail.indexOf('\n')
  const jsonPart = firstNewline >= 0 ? detail.slice(firstNewline + 1) : detail
  try {
    return JSON.parse(jsonPart)
  } catch {
    return undefined
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function extractInputBrief(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>

  // File-path tools
  if ('file_path' in obj && typeof obj['file_path'] === 'string') {
    return obj['file_path']
  }

  // URL tools
  if ('url' in obj && typeof obj['url'] === 'string') {
    return obj['url']
  }

  // Web search
  if ('query' in obj && typeof obj['query'] === 'string') {
    return obj['query']
  }

  return null
}

function extractResultStatus(toolName: string, content: string): string {
  // Check for error indicator in JSON
  if (content.includes('"error":true') || content.includes('"error": true')) {
    return 'ERROR'
  }

  // Bash JSON exit code
  if (toolName === 'bash') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      if ('exit_code' in parsed && typeof parsed['exit_code'] === 'number') {
        return `exit ${parsed['exit_code']}`
      }
    } catch {
      // Not JSON — fall through to OK
    }
  }

  return 'OK'
}
