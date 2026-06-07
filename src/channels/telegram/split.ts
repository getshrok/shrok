/**
 * Pure text-splitting helper for Telegram's 4096-character hard limit.
 *
 * Strategy: split SOURCE markdown into chunks, let the caller render each
 * chunk independently. The caller supplies a `render` function so this helper
 * can measure the *real* output length (table expansion + HTML conversion)
 * without knowing about Telegram's HTML format.
 *
 * Atomic blocks that are never split internally:
 *   - Fenced code blocks (``` … ```)
 *   - Markdown pipe-table runs (contiguous pipe-table rows)
 *
 * Over-cap atomic blocks are hard-split on line boundaries, and fenced blocks
 * are re-wrapped so every emitted piece is a valid standalone fenced block.
 */

/** Returns true if a line is a markdown table separator row (e.g. | --- | :--: |) */
const isSeparatorRow = (line: string): boolean => /^\|[\s\-:|]+\|$/.test(line.trim())

/** Returns true if a line looks like a pipe-table row */
const isTableRow = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|')
}

// ---------------------------------------------------------------------------
// Atomic block types
// ---------------------------------------------------------------------------

type PlainBlock = { kind: 'plain'; lines: string[] }
type FenceBlock = { kind: 'fence'; openLine: string; innerLines: string[]; closeLine: string }
type TableBlock = { kind: 'table'; lines: string[] }
type AtomicBlock = PlainBlock | FenceBlock | TableBlock

// ---------------------------------------------------------------------------
// Parse input text into atomic blocks
// ---------------------------------------------------------------------------

function parseBlocks(text: string): AtomicBlock[] {
  const lines = text.split('\n')
  const blocks: AtomicBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const openLine = line
      const innerLines: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        const inner = lines[i]!
        if (inner.trimStart().startsWith('```')) {
          // Closing fence
          blocks.push({ kind: 'fence', openLine, innerLines, closeLine: inner })
          i++
          closed = true
          break
        }
        innerLines.push(inner)
        i++
      }
      if (!closed) {
        // Unterminated fence — treat rest as block with empty close
        blocks.push({ kind: 'fence', openLine, innerLines, closeLine: '```' })
      }
      continue
    }

    // Pipe-table run
    if (isTableRow(line)) {
      const tableLines: string[] = []
      while (i < lines.length) {
        const l = lines[i]!
        if (isTableRow(l)) {
          tableLines.push(l)
          i++
        } else {
          break
        }
      }
      // Only treat as table block if it has a separator row (real table)
      if (tableLines.some(isSeparatorRow)) {
        blocks.push({ kind: 'table', lines: tableLines })
      } else {
        // Not a real table — treat each line as plain
        blocks.push({ kind: 'plain', lines: tableLines })
      }
      continue
    }

    // Plain line — collect consecutive plain lines
    const plainLines: string[] = []
    while (i < lines.length) {
      const l = lines[i]!
      if (l.trimStart().startsWith('```') || isTableRow(l)) break
      plainLines.push(l)
      i++
    }
    if (plainLines.length > 0) {
      blocks.push({ kind: 'plain', lines: plainLines })
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Rebuild source text from accumulated lines
// ---------------------------------------------------------------------------

function joinLines(lines: string[]): string {
  return lines.join('\n')
}

function blockToSource(block: AtomicBlock): string {
  switch (block.kind) {
    case 'plain':
      return joinLines(block.lines)
    case 'fence':
      return [block.openLine, ...block.innerLines, block.closeLine].join('\n')
    case 'table':
      return joinLines(block.lines)
  }
}

// ---------------------------------------------------------------------------
// Char-boundary fallback: slice a single line into pieces that render under limit
// ---------------------------------------------------------------------------

function sliceLineToChunks(line: string, render: (s: string) => string, limit: number): string[] {
  const result: string[] = []
  let remaining = line
  while (remaining.length > 0) {
    // Binary-search for the largest prefix whose render fits
    let lo = 1
    let hi = remaining.length
    // Check if the whole remainder fits
    if (render(remaining).length <= limit) {
      result.push(remaining)
      break
    }
    // Find largest fitting prefix
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2)
      if (render(remaining.slice(0, mid)).length <= limit) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    if (lo === 0) {
      // Single character still exceeds limit — force at least 1 char to avoid infinite loop
      lo = 1
    }
    result.push(remaining.slice(0, lo))
    remaining = remaining.slice(lo)
  }
  return result
}

// ---------------------------------------------------------------------------
// Hard-split a list of source lines (plain or table rows) on line boundaries,
// then char boundaries for over-cap single lines. Returns array of text chunks.
// ---------------------------------------------------------------------------

function hardSplitLines(lines: string[], render: (s: string) => string, limit: number): string[] {
  const output: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length > 0) {
      output.push(joinLines(current))
      current = []
    }
  }

  for (const line of lines) {
    const candidate = current.length > 0 ? joinLines(current) + '\n' + line : line
    if (render(candidate).length <= limit) {
      current.push(line)
    } else {
      flush()
      // Check if the single line itself fits
      if (render(line).length <= limit) {
        current.push(line)
      } else {
        // Must char-split this line
        const pieces = sliceLineToChunks(line, render, limit)
        for (const piece of pieces) {
          output.push(piece)
        }
      }
    }
  }

  flush()
  return output
}

// ---------------------------------------------------------------------------
// Hard-split a fenced code block — each piece gets the same open fence + close
// ---------------------------------------------------------------------------

function hardSplitFence(block: FenceBlock, render: (s: string) => string, limit: number): string[] {
  const openLine = block.openLine
  const closeLine = block.closeLine
  const innerLines = block.innerLines

  // Overhead of wrapping: openLine + '\n' + closeLine
  const overhead = openLine + '\n' + closeLine

  // If inner is empty, just return the block as-is
  if (innerLines.length === 0) {
    const full = blockToSource(block)
    if (render(full).length <= limit) return [full]
    // Can't do anything — return as-is
    return [full]
  }

  // Build a render function that wraps the candidate lines in fences
  const fenceRender = (lines: string[]): string => {
    const inner = joinLines(lines)
    const fenced = openLine + '\n' + inner + '\n' + closeLine
    return render(fenced)
  }

  const output: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length > 0) {
      output.push(openLine + '\n' + joinLines(current) + '\n' + closeLine)
      current = []
    }
  }

  for (const line of innerLines) {
    const candidate = [...current, line]
    if (fenceRender(candidate).length <= limit) {
      current.push(line)
    } else {
      flush()
      // Check if the single line fits in a fence
      if (fenceRender([line]).length <= limit) {
        current.push(line)
      } else {
        // Char-split the line (measuring within fence context)
        const lineFenceRender = (s: string): string => render(openLine + '\n' + s + '\n' + closeLine)
        // First check if overhead alone fits
        if (render(overhead).length >= limit) {
          // Pathological case — just emit the line raw inside fences
          output.push(openLine + '\n' + line + '\n' + closeLine)
          continue
        }
        const pieces = sliceLineToChunks(line, lineFenceRender, limit)
        for (const piece of pieces) {
          output.push(openLine + '\n' + piece + '\n' + closeLine)
        }
      }
    }
  }

  flush()

  // If we produced nothing (shouldn't happen), return block as-is
  if (output.length === 0) {
    return [blockToSource(block)]
  }

  return output
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Split `text` into chunks such that `render(chunk).length <= limit` for each.
 *
 * @param text   Source markdown text (NOT pre-rendered).
 * @param render Caller-supplied render function (e.g. markdownToTelegramHtml ∘ formatTablesForChat).
 * @param limit  Character limit (default 4096, Telegram's hard cap).
 * @returns      Array of SOURCE chunks. Caller renders each before sending.
 *               If the whole input fits, returns `[text]` so render(chunk) is byte-identical.
 */
export function splitMessageForTelegram(
  text: string,
  render: (s: string) => string,
  limit = 4096,
): string[] {
  // Early-exit: whole input fits — return the original string unchanged
  if (render(text).length <= limit) {
    return [text]
  }

  const blocks = parseBlocks(text)
  const output: string[] = []
  let current: string[] = [] // accumulated source lines for the in-progress chunk

  const flushCurrent = (): void => {
    if (current.length > 0) {
      output.push(joinLines(current))
      current = []
    }
  }

  for (const block of blocks) {
    const blockSource = blockToSource(block)
    const blockLines = block.kind === 'fence'
      ? [block.openLine, ...block.innerLines, block.closeLine]
      : block.lines

    // Try appending block to current chunk
    const candidate =
      current.length > 0
        ? joinLines(current) + '\n' + blockSource
        : blockSource

    if (render(candidate).length <= limit) {
      // Fits — append block's lines to current
      if (current.length > 0) {
        current.push(...blockLines)
      } else {
        current.push(...blockLines)
      }
      continue
    }

    // Block doesn't fit into current chunk. Flush current first.
    flushCurrent()

    // Does the block fit on its own?
    if (render(blockSource).length <= limit) {
      // Start a fresh chunk with this block
      current.push(...blockLines)
      continue
    }

    // Block alone exceeds the limit — hard-split it
    let pieces: string[]

    if (block.kind === 'fence') {
      pieces = hardSplitFence(block, render, limit)
    } else {
      // plain or table: hard-split on line boundaries
      pieces = hardSplitLines(block.lines, render, limit)
    }

    for (const piece of pieces) {
      output.push(piece)
    }
  }

  flushCurrent()

  // Edge case: if we produced nothing (empty input edge case), return ['']
  if (output.length === 0) {
    return [text]
  }

  return output
}
