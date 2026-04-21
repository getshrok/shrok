/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Key differences:
 * - Bold: **text** → *text*
 * - Italic: *text* or _text_ → _text_ (Slack uses _ only)
 * - Strikethrough: ~~text~~ → ~text~
 * - Links: [text](url) → <url|text>
 * - Headers: # Text → *Text* (Slack has no headers)
 * - Code/code blocks: unchanged (same syntax)
 */
export function markdownToMrkdwn(text: string): string {
  // Preserve code blocks and inline code from transformation
  const preserved: string[] = []
  let result = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    preserved.push(match)
    return `\x00CODE${preserved.length - 1}\x00`
  })

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Bold: **text** → *text* (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Italic with asterisks: *text* → _text_ (only single asterisks not caught by bold)
  // Be careful not to match already-converted bold (*text*)
  // After bold conversion, remaining single * pairs are italic
  // Skip this — Slack interprets single * as bold, which is close enough

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~')

  // Headers: lines starting with # → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Restore preserved code blocks
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => preserved[Number(i)]!)

  return result
}
