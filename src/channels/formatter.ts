/**
 * Per-platform markdown formatters.
 *
 * Each formatter converts standard markdown (as produced by LLMs) to the
 * syntax expected by a specific platform. Shared helpers handle code-fence
 * protection and ASCII table conversion, which applies universally since no
 * platform renders markdown tables natively.
 */

// ─── Segment ──────────────────────────────────────────────────────────────────

type Segment = { kind: 'code'; lang: string; body: string } | { kind: 'text'; body: string }

/**
 * Split text into alternating text/code segments so formatters never process
 * content inside triple-backtick code blocks.
 */
function segment(text: string): Segment[] {
  const result: Segment[] = []
  const re = /^```(\w*)\r?\n([\s\S]*?)^```/gm
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) result.push({ kind: 'text', body: text.slice(last, m.index) })
    result.push({ kind: 'code', lang: m[1]!, body: m[2]! })
    last = m.index + m[0]!.length
    // consume trailing newline after closing ```
    if (text[last] === '\n') last++
  }
  if (last < text.length) result.push({ kind: 'text', body: text.slice(last) })
  return result
}

// ─── ASCII table conversion ───────────────────────────────────────────────────

function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return null
  const sep = lines[1]!
  if (!/^\|[-: |]+\|$/.test(sep.trim())) return null
  const parseRow = (line: string) => line.split('|').slice(1, -1).map(c => c.trim())
  const headers = parseRow(lines[0]!)
  const rows = lines.slice(2).map(parseRow)
  return { headers, rows }
}

function renderAsciiTable(parsed: { headers: string[]; rows: string[][] }): string {
  const cols = parsed.headers.length
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(parsed.headers[i]!.length, ...parsed.rows.map(r => (r[i] ?? '').length), 1)
  )
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+'
  const fmt = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |'
  return [sep, fmt(parsed.headers), sep, ...parsed.rows.map(fmt), sep].join('\n')
}

/** Replace markdown table blocks with ASCII art wrapped in a code fence. */
function convertTables(text: string): string {
  return text.replace(/(?:^\|.+\|\r?\n)+/gm, match => {
    const parsed = parseMarkdownTable(match.trimEnd())
    if (!parsed) return match
    return '```\n' + renderAsciiTable(parsed) + '\n```\n'
  })
}

// ─── Discord ──────────────────────────────────────────────────────────────────

/**
 * Discord renders standard markdown natively (bold, italic, code blocks,
 * headers). Only tables need converting to ASCII art.
 */
export function formatForDiscord(text: string): string {
  return convertTables(text)
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

/**
 * Telegram HTML mode: convert markdown to HTML tags so Telegram renders it.
 * Code fences become <pre> blocks; inline text gets bold/italic/code/links.
 * Must use parse_mode: 'HTML' when sending.
 */
export function formatForTelegram(text: string): string {
  const segs = segment(convertTables(text))
  return segs.map(s => {
    if (s.kind === 'code') {
      const escaped = escapeHtml(s.body.replace(/\n$/, ''))
      return s.lang
        ? `<pre><code class="language-${s.lang}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`
    }
    // Escape HTML entities first, then convert markdown syntax
    let t = escapeHtml(s.body)
    t = t.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    t = t.replace(/\*(.+?)\*/gs, '<i>$1</i>')
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    t = t.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>')
    return t
  }).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Slack ────────────────────────────────────────────────────────────────────

/**
 * Slack mrkdwn syntax: **bold** → *bold*, *italic* → _italic_,
 * headers → *bold*, links → <url|text>, escape &<>.
 */
export function formatForSlack(text: string): string {
  const segs = segment(convertTables(text))
  return segs.map(s => {
    if (s.kind === 'code') return '```' + s.body + '```'
    let t = s.body
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    t = t.replace(/\*\*(.+?)\*\*/gs, '*$1*')
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '_$1_')
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    return t
  }).join('')
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

/**
 * WhatsApp formatting: **bold** → *bold*, *italic* → _italic_,
 * headers → *bold*, links become bare URLs (WhatsApp previews them).
 */
export function formatForWhatsApp(text: string): string {
  const segs = segment(convertTables(text))
  return segs.map(s => {
    if (s.kind === 'code') return '```' + s.body + '```'
    let t = s.body
    t = t.replace(/\*\*(.+?)\*\*/gs, '*$1*')
    t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '_$1_')
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2')
    return t
  }).join('')
}
