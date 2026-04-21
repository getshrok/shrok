import fs from 'node:fs'
import path from 'node:path'
import type { Message, ToolCall, ToolResult } from './types/core.js'
import type { LLMResponse } from './types/llm.js'
import { estimateTokens } from './db/token.js'

const MAX_FILES_PER_TYPE = 50
const TRUNC_MSG    = 4000
const TRUNC_TOOL   = 4000
const TRUNC_SYSTEM = 50_000

let traceDir = ''
let historyTokenBudget = 2000

// ─── Initialisation ───────────────────────────────────────────────────────────

export function initTracer(dirPath: string, traceHistoryTokens?: number): void {
  traceDir = dirPath
  if (traceHistoryTokens !== undefined) historyTokenBudget = traceHistoryTokens
  try { fs.mkdirSync(dirPath, { recursive: true }) } catch { /* dir may already exist */ }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function trunc(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `…[+${s.length - max}]`
}

function formatMessage(msg: Message): string {
  switch (msg.kind) {
    case 'text':
      return `  [${msg.role}] ${trunc(msg.content, TRUNC_MSG)}`

    case 'tool_call': {
      const lines: string[] = []
      if (msg.content) lines.push(`  [assistant] ${trunc(msg.content, TRUNC_MSG)}`)
      for (const tc of msg.toolCalls) {
        lines.push(`  → ${tc.name} ${trunc(JSON.stringify(tc.input), TRUNC_TOOL)}`)
      }
      return lines.join('\n')
    }

    case 'tool_result': {
      const lines: string[] = []
      for (const tr of msg.toolResults) {
        lines.push(`  ← ${tr.name}: ${trunc(tr.content, TRUNC_TOOL)}`)
      }
      return lines.join('\n')
    }

    case 'summary':
      return `  [summary] ${trunc(msg.content, TRUNC_MSG)}`
  }
}

/** Update (or create) a `{sourceType}-latest.log` symlink pointing to filename. */
function updateSymlink(dir: string, sourceType: string, filename: string): void {
  const linkPath = path.join(dir, `${sourceType}-latest.log`)
  try { fs.unlinkSync(linkPath) } catch { /* ignore if missing */ }
  try { fs.symlinkSync(filename, linkPath) } catch { /* ignore on unsupported fs */ }
}

/** Delete oldest activation files for this sourceType, keeping MAX_FILES_PER_TYPE. */
function pruneFiles(dir: string, sourceType: string): void {
  try {
    const prefix = `${sourceType}-`
    const suffix = '.log'
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith(suffix) && !f.endsWith('-latest.log'))
      .sort()  // timestamp in name → lexicographic = chronological
    const excess = files.length - MAX_FILES_PER_TYPE
    if (excess > 0) {
      for (const f of files.slice(0, excess)) {
        try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ─── ActiveTrace ──────────────────────────────────────────────────────────────

export interface ActiveTrace {
  llmResponse(round: number, response: LLMResponse): void
  toolResult(call: ToolCall, result: ToolResult): void
  end(rounds: number, response: LLMResponse): void
}

class FileTrace implements ActiveTrace {
  private readonly startMs = Date.now()

  constructor(private readonly filePath: string) {}

  private write(text: string): void {
    try { fs.appendFileSync(this.filePath, text) } catch { /* ignore */ }
  }

  llmResponse(round: number, response: LLMResponse): void {
    this.write(`\n-- round ${round} --\n`)
    if (response.content) {
      this.write(`RESPONSE: ${trunc(response.content, TRUNC_MSG)}\n`)
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      this.write(`TOOL CALLS:\n`)
      for (const tc of response.toolCalls) {
        this.write(`  → ${tc.name} ${trunc(JSON.stringify(tc.input), TRUNC_TOOL)}\n`)
      }
    }
  }

  toolResult(call: ToolCall, result: ToolResult): void {
    this.write(`  ← ${call.name}: ${trunc(result.content, TRUNC_TOOL)}\n`)
  }

  end(rounds: number, response: LLMResponse): void {
    const elapsedMs = Date.now() - this.startMs
    const elapsedStr = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`
    this.write(`STOP: ${response.stopReason} | ${response.model} | ${elapsedStr} | ${response.inputTokens} in / ${response.outputTokens} out | rounds: ${rounds}\n`)
    this.write(`${'─'.repeat(72)}\n`)
  }
}

/** No-op trace used when tracing is not initialised. */
const nullTrace: ActiveTrace = {
  llmResponse() {},
  toolResult() {},
  end() {},
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const trace = {
  begin(
    sourceType: string,
    sourceId: string,
    model: string,
    systemPrompt: string,
    history: Message[],
    tools?: string[],
  ): ActiveTrace {
    if (!traceDir) return nullTrace

    // e.g. "head-20260326T105445-abc12345.log"
    const ts = new Date().toISOString().replace(/:/g, '-').slice(0, 19).replace('T', 'T')
    // Use last 12 alphanumeric chars — the suffix is the unique part of IDs
    // (e.g. tent_1775229760442_hlkv3bt → 0442hlkv3bt)
    const shortId = sourceId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)
    const filename = `${sourceType}-${ts}-${shortId}.log`
    const filePath = path.join(traceDir, filename)

    const separator = sourceType === 'head' ? '═' : '─'
    const header = `${separator.repeat(72)}\n${sourceType.toUpperCase()} ${sourceId}  ${new Date().toISOString()}  [${model}]\n${separator.repeat(72)}`
    let out = `${header}\n`
    out += `SYSTEM: ${trunc(systemPrompt, TRUNC_SYSTEM)}\n`
    if (tools && tools.length > 0) {
      out += `TOOLS: ${tools.join(', ')}\n`
    }
    if (history.length > 0) {
      // Take messages from the end until we hit the token budget
      const shown: Message[] = []
      let tokens = 0
      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens([history[i]!])
        if (tokens + msgTokens > historyTokenBudget && shown.length > 0) break
        shown.unshift(history[i]!)
        tokens += msgTokens
      }
      out += `HISTORY: ${history.length} msg${history.length === 1 ? '' : 's'}${shown.length < history.length ? ` (last ${shown.length} shown, ~${tokens} tokens)` : ''}:\n`
      for (const msg of shown) {
        out += formatMessage(msg) + '\n'
      }
    }

    try { fs.writeFileSync(filePath, out) } catch { return nullTrace }

    updateSymlink(traceDir, sourceType, filename)
    pruneFiles(traceDir, sourceType)

    return new FileTrace(filePath)
  },
}
