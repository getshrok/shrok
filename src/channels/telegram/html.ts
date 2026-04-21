/**
 * Convert standard Markdown to Telegram HTML format.
 *
 * Telegram's HTML subset supports:
 *   <b>, <i>, <s>, <u>, <code>, <pre>, <a href="">, <blockquote>, <tg-spoiler>
 *
 * Key conversions:
 *   **bold** or __bold__ → <b>bold</b>
 *   *italic* or _italic_ → <i>italic</i>
 *   ~~strike~~ → <s>strike</s>
 *   `code` → <code>code</code>
 *   ```block``` → <pre>block</pre>
 *   [text](url) → <a href="url">text</a>
 *   # Header → <b>Header</b>
 *
 * All other text is HTML-escaped to prevent injection.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function markdownToTelegramHtml(text: string): string {
  // Preserve code blocks and inline code from transformation
  const preserved: string[] = []

  // Extract code blocks first (``` ... ```)
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, content) => {
    preserved.push(`<pre>${escapeHtml(content.trimEnd())}</pre>`)
    return `\x00CODE${preserved.length - 1}\x00`
  })

  // Extract inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_match, content) => {
    preserved.push(`<code>${escapeHtml(content)}</code>`)
    return `\x00CODE${preserved.length - 1}\x00`
  })

  // Now escape the remaining HTML-sensitive chars in the body
  result = escapeHtml(result)

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Bold: **text** or __text__→ <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* → <i>text</i> (single asterisks after bold conversion)
  // Be careful — single * at start of line could be a list item
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>')

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Headers: lines starting with # → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Restore preserved code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => preserved[Number(i)]!)

  return result
}
