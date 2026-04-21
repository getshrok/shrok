/**
 * Code-fence-aware message chunker.
 *
 * Splits long text into chunks that fit within a character limit while
 * respecting triple-backtick code fences — a fence is never split
 * mid-block.
 *
 * Two strategies when a split point lands inside an open fence:
 *   Case A (fence opens after midpoint): split before the opening line.
 *   Case B (fence opens before midpoint): close the fence at the split
 *           point and reopen it with the same language tag in the next chunk.
 *
 * When no fence is involved: paragraph → newline → space → hard-cut.
 */

interface FenceState {
  inside: boolean
  /** Index in text where the opening ``` line begins (if inside). */
  openStart: number
  /** Language tag from the opening line, e.g. "typescript" or "". */
  lang: string
}

/**
 * Determine whether `position` falls inside an open code fence by
 * scanning `text[0..position)` for triple-backtick markers at line starts.
 */
function fenceStateAt(text: string, position: number): FenceState {
  let inside = false
  let openStart = -1
  let lang = ''
  let i = 0

  while (i < position) {
    const atLineStart = i === 0 || text[i - 1] === '\n'
    if (atLineStart && text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      if (!inside) {
        inside = true
        openStart = i
        const lineEnd = text.indexOf('\n', i + 3)
        lang = (lineEnd === -1 ? text.slice(i + 3) : text.slice(i + 3, lineEnd)).trim()
        i = lineEnd === -1 ? text.length : lineEnd + 1
      } else {
        inside = false
        openStart = -1
        lang = ''
        i += 3
        if (i < text.length && text[i] === '\n') i++
      }
    } else {
      i++
    }
  }

  return { inside, openStart, lang }
}

/** Split `text` into chunks of at most `maxLen` characters. */
export function splitMessage(text: string, maxLen = 2000): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen)
    const fence = fenceStateAt(remaining, maxLen)

    if (fence.inside) {
      if (fence.openStart > maxLen * 0.5) {
        // Case A: fence opens in the back half — split before the opening line
        const lastNl = remaining.lastIndexOf('\n', fence.openStart - 1)
        const cut = lastNl > maxLen * 0.3 ? lastNl : fence.openStart
        chunks.push(remaining.slice(0, cut).trimEnd())
        remaining = remaining.slice(cut).trimStart()
      } else {
        // Case B: fence opens in the front half — close it here and reopen
        chunks.push(slice.trimEnd() + '\n```')
        remaining = '```' + fence.lang + '\n' + remaining.slice(maxLen).replace(/^\n/, '')
      }
    } else {
      // Normal boundary split
      const lastNewline = slice.lastIndexOf('\n')
      const lastSpace = slice.lastIndexOf(' ')
      const splitAt =
        lastNewline > maxLen * 0.5 ? lastNewline
        : lastSpace > maxLen * 0.5 ? lastSpace
        : maxLen
      chunks.push(remaining.slice(0, splitAt).trimEnd())
      remaining = remaining.slice(splitAt).trimStart()
    }
  }

  if (remaining) chunks.push(remaining)
  return chunks
}
