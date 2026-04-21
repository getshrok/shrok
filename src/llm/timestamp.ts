/**
 * Formats a message's createdAt timestamp for display in LLM conversation context.
 *
 * - Under 60 min: [12m ago]
 * - 1–24 hours:   [3h ago]
 * - Over 24 hours: [Apr 3, 2:15 PM] (absolute)
 *
 * Returns empty string if createdAt is missing or invalid.
 */
export function formatMessageTimestamp(createdAt: string | undefined): string {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  if (isNaN(date.getTime())) return ''

  const now = Date.now()
  const ageMs = now - date.getTime()
  const ageMin = Math.round(ageMs / 60_000)

  if (ageMin < 60) {
    return `[${ageMin}m ago]`
  }
  if (ageMin < 1440) {
    return `[${Math.round(ageMin / 60)}h ago]`
  }
  // Absolute format for older messages
  const month = date.toLocaleString('en-US', { month: 'short' })
  const day = date.getDate()
  const time = date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `[${month} ${day}, ${time}]`
}

/**
 * Prefix message content with a formatted timestamp.
 * Returns the original content unchanged if timestamp is unavailable.
 */
export function prefixTimestamp(content: string, createdAt: string | undefined): string {
  const ts = formatMessageTimestamp(createdAt)
  return ts ? `${ts} ${content}` : content
}
