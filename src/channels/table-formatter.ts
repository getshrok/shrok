/**
 * Converts markdown pipe tables to box-drawing tables wrapped in triple backticks.
 * Non-table text is preserved verbatim.
 *
 * Exports:
 *   stripMarkdownInline   — removes **bold**, __underline__, ~~strike~~, `code` markers
 *   formatTablesForChat   — Unicode box-drawing (Discord/Telegram), markdown stripped from cells
 *   formatTablesForWhatsApp — ASCII box-drawing (+/-/|/=), markdown stripped from cells
 *   formatTablesForSlack  — 2-col tables as Slack section blocks; 3+ col as code blocks
 */

// ---------------------------------------------------------------------------
// Minimal Slack block types (no @slack/bolt import)
// ---------------------------------------------------------------------------
type SlackTextField = { type: string; text: string }
type SlackBlock =
  | { type: 'section'; text: SlackTextField; fields?: never }
  | { type: 'section'; fields: SlackTextField[]; text?: never }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if a line is a markdown table separator row (e.g. | --- | :--: |) */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim())
}

/** Returns true if a line looks like a pipe-table row */
function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|')
}

/** Parse a pipe-delimited row into an array of trimmed cell strings */
function parseCells(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.slice(1, trimmed.length - 1)
  return inner.split('|').map(c => c.trim())
}

/**
 * Remove inline markdown decorators from a string.
 * Strips: **bold**, __underline__, ~~strikethrough~~, `code spans`.
 * Does NOT strip single * or _ (Slack uses these for italic).
 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]*)\*\*/g, '$1')   // **bold**
    .replace(/__([^_]*)__/g, '$1')         // __underline__
    .replace(/~~([^~]*)~~/g, '$1')         // ~~strike~~
    .replace(/`([^`]*)`/g, '$1')           // `code`
}

// ---------------------------------------------------------------------------
// Box-drawing character sets
// ---------------------------------------------------------------------------

interface CharSet {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  topSep: string       // top inner column join
  bottomSep: string    // bottom inner column join
  headerLeft: string
  headerRight: string
  headerSep: string    // inner column join on header separator
  rowLeft: string
  rowRight: string
  rowSep: string       // inner column join on row separator
  hOuter: string       // fill for top/bottom borders
  hHeader: string      // fill for header separator
  hLight: string       // fill for row separators
  wall: string         // vertical cell wall
}

const UNICODE_CHARS: CharSet = {
  topLeft:     '╔',
  topRight:    '╗',
  bottomLeft:  '╚',
  bottomRight: '╝',
  topSep:      '╦',
  bottomSep:   '╩',
  headerLeft:  '╠',
  headerRight: '╣',
  headerSep:   '╬',
  rowLeft:     '╟',
  rowRight:    '╢',
  rowSep:      '╫',
  hOuter:      '═',
  hHeader:     '═',
  hLight:      '─',
  wall:        '║',
}

const ASCII_CHARS: CharSet = {
  topLeft:     '+',
  topRight:    '+',
  bottomLeft:  '+',
  bottomRight: '+',
  topSep:      '+',
  bottomSep:   '+',
  headerLeft:  '+',
  headerRight: '+',
  headerSep:   '+',
  rowLeft:     '+',
  rowRight:    '+',
  rowSep:      '+',
  hOuter:      '-',   // top border, bottom border: +-----+
  hHeader:     '=',   // header separator: +=====+
  hLight:      '-',   // row separators: +-----+
  wall:        '|',
}

// ---------------------------------------------------------------------------
// Core table renderer
// ---------------------------------------------------------------------------

interface RenderOptions {
  chars: CharSet
  stripMd: boolean
  /** Wrap output in <pre>...</pre> instead of triple backticks */
  preTag?: boolean
}

/** Render a single markdown table block (array of consecutive lines) into a box-drawing string */
function renderTable(tableLines: string[], opts: RenderOptions): string {
  const { chars, stripMd } = opts

  const sepIdx = tableLines.findIndex(isSeparatorRow)
  if (sepIdx === -1) {
    return tableLines.join('\n')
  }

  const firstLine = tableLines[0]
  if (firstLine === undefined) return tableLines.join('\n')

  const rawHeaderCells = parseCells(firstLine)
  const headerCells = stripMd ? rawHeaderCells.map(stripMarkdownInline) : rawHeaderCells

  const dataLines = tableLines.filter((_, i) => i !== 0 && i !== sepIdx)
  const rawDataRows = dataLines.map(parseCells)
  const dataRows = rawDataRows.map(row =>
    stripMd ? row.map(stripMarkdownInline) : row,
  )

  const colCount = headerCells.length

  const normalizeRow = (row: string[]): string[] => {
    const result = [...row]
    while (result.length < colCount) result.push('')
    return result.slice(0, colCount)
  }

  const normalizedData = dataRows.map(normalizeRow)

  const colWidths = headerCells.map((h, ci) => {
    let max = h.length
    for (const row of normalizedData) {
      const cell = row[ci]
      if (cell !== undefined && cell.length > max) max = cell.length
    }
    return max
  })

  const outerSeg = (w: number): string => chars.hOuter.repeat(w + 2)
  const headerSegFill = (w: number): string => chars.hHeader.repeat(w + 2)
  const lightSeg = (w: number): string => chars.hLight.repeat(w + 2)

  const topBorder = (): string =>
    chars.topLeft + colWidths.map(outerSeg).join(chars.topSep) + chars.topRight

  const headerSep = (): string =>
    chars.headerLeft + colWidths.map(headerSegFill).join(chars.headerSep) + chars.headerRight

  const rowSepLine = (): string =>
    chars.rowLeft + colWidths.map(lightSeg).join(chars.rowSep) + chars.rowRight

  const bottomBorder = (): string =>
    chars.bottomLeft + colWidths.map(outerSeg).join(chars.bottomSep) + chars.bottomRight

  const dataRow = (cells: string[]): string => {
    const paddedCells = colWidths.map((w, ci) => {
      const cell = cells[ci] ?? ''
      return ` ${cell.padEnd(w)} `
    })
    return chars.wall + paddedCells.join(chars.wall) + chars.wall
  }

  const outputLines: string[] = []
  outputLines.push(topBorder())
  outputLines.push(dataRow(headerCells))
  outputLines.push(headerSep())

  for (let i = 0; i < normalizedData.length; i++) {
    if (i > 0) outputLines.push(rowSepLine())
    const row = normalizedData[i]
    if (row !== undefined) outputLines.push(dataRow(row))
  }

  outputLines.push(bottomBorder())

  const body = outputLines.join('\n')
  return opts.preTag ? `<pre>${body}</pre>` : '```\n' + body + '\n```'
}

// ---------------------------------------------------------------------------
// Generic text scanner — collects table blocks, calls renderFn on each
// ---------------------------------------------------------------------------

function scanAndReplace(text: string, renderFn: (tableLines: string[]) => string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line !== undefined && isTableRow(line)) {
      const collected: string[] = []
      while (i < lines.length) {
        const l = lines[i]
        if (l !== undefined && isTableRow(l)) {
          collected.push(l)
          i++
        } else {
          break
        }
      }
      if (collected.some(isSeparatorRow)) {
        result.push(renderFn(collected))
      } else {
        result.push(...collected)
      }
    } else {
      if (line !== undefined) result.push(line)
      i++
    }
  }

  return result.join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `text` for markdown pipe tables. Each table is replaced with a
 * Unicode box-drawing version wrapped in triple backticks.
 * Markdown is stripped from cell content.
 */
export function formatTablesForChat(text: string): string {
  return scanAndReplace(text, lines => renderTable(lines, { chars: UNICODE_CHARS, stripMd: true }))
}

/**
 * Same as formatTablesForChat but wraps in <pre> tags instead of backtick fences.
 * For Telegram HTML parse mode.
 */
export function formatTablesForTelegram(text: string): string {
  return scanAndReplace(text, lines => renderTable(lines, { chars: UNICODE_CHARS, stripMd: true, preTag: true }))
}

/**
 * Same as formatTablesForChat but using ASCII box chars (+, -, |, =).
 * For WhatsApp where Unicode box-drawing glyphs don't render correctly.
 */
export function formatTablesForWhatsApp(text: string): string {
  return scanAndReplace(text, lines => renderTable(lines, { chars: ASCII_CHARS, stripMd: true }))
}

/**
 * Format tables for Slack.
 *
 * - 2-column tables become Slack section blocks with mrkdwn fields (one per row).
 *   Markdown in cells is preserved — Slack renders mrkdwn natively.
 * - 3+ column tables fall back to Unicode code blocks (same as Discord).
 * - Non-table text segments become section blocks with mrkdwn text.
 * - Returns { text: fallbackText, blocks?: SlackBlock[] }
 *   `text` is always the full Unicode-formatted fallback.
 *   `blocks` is present only when at least one 2-column table exists.
 */
export function formatTablesForSlack(text: string): { text: string; blocks?: SlackBlock[] } {
  // Build the plain-text fallback (Unicode code block, markdown stripped)
  const fallbackText = scanAndReplace(text, lines =>
    renderTable(lines, { chars: UNICODE_CHARS, stripMd: true }),
  )

  // Now scan to build blocks
  const lines = text.split('\n')
  const blocks: SlackBlock[] = []
  let hasAny2ColTable = false
  let i = 0

  // Buffer for accumulating non-table lines
  const pendingText: string[] = []

  const flushText = (): void => {
    if (pendingText.length === 0) return
    const t = pendingText.join('\n').trim()
    if (t) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t } })
    }
    pendingText.length = 0
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line !== undefined && isTableRow(line)) {
      const collected: string[] = []
      while (i < lines.length) {
        const l = lines[i]
        if (l !== undefined && isTableRow(l)) {
          collected.push(l)
          i++
        } else {
          break
        }
      }

      if (!collected.some(isSeparatorRow)) {
        // Not a valid table — treat as regular text
        pendingText.push(...collected)
        continue
      }

      const sepIdx = collected.findIndex(isSeparatorRow)
      const firstLine = collected[0]
      if (firstLine === undefined) {
        pendingText.push(...collected)
        continue
      }

      const headerCells = parseCells(firstLine)
      const colCount = headerCells.length

      if (colCount === 2) {
        // 2-column table → section blocks with fields
        hasAny2ColTable = true
        flushText()

        const dataLines = collected.filter((_, idx) => idx !== 0 && idx !== sepIdx)
        const allRows = [headerCells, ...dataLines.map(parseCells)]

        for (const row of allRows) {
          const normalizedRow = row.length >= 2 ? row.slice(0, 2) : [...row, '']
          const field0 = normalizedRow[0] ?? ''
          const field1 = normalizedRow[1] ?? ''

          // Mark header row cells with bold (only the first row = header)
          const isHeader = row === headerCells
          const textA = isHeader ? `*${field0}*` : field0
          const textB = isHeader ? `*${field1}*` : field1

          blocks.push({
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: textA },
              { type: 'mrkdwn', text: textB },
            ],
          })
        }
      } else {
        // 3+ column table → code block fallback text as section block
        flushText()
        const codeBlock = renderTable(collected, { chars: UNICODE_CHARS, stripMd: true })
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: codeBlock } })
      }
    } else {
      if (line !== undefined) pendingText.push(line)
      i++
    }
  }

  flushText()

  if (!hasAny2ColTable) {
    // No 2-col tables — return text-only result without blocks
    return { text: fallbackText }
  }

  return { text: fallbackText, blocks }
}
