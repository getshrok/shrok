/** Max display length for a normalized sender name before truncation+ellipsis. */
const MAX_SENDER_NAME_LEN = 40

/**
 * Normalize an adapter-supplied display name into a safe prefix segment.
 * Locked rules (per Phase 36 D-07):
 *  - strip '[', ']', ':' characters (defends prefix shape against forgery — T-36-01)
 *  - collapse runs of any Unicode whitespace into a single ASCII space (T-36-03)
 *  - trim leading/trailing whitespace
 *  - truncate to MAX_SENDER_NAME_LEN chars and append '…' when strictly longer (T-36-02)
 *  - emojis (and other non-ASCII non-whitespace) pass through untouched
 * Returns '' for undefined / empty / fully-stripped inputs — caller treats '' as
 * "no senderName known" and skips the prefix entirely (D-02).
 */
export function normalizeSenderName(input: string | undefined): string {
  if (!input) return ''
  // Order: strip forbidden chars first, then collapse whitespace, then trim, then truncate.
  let out = input.replace(/[\[\]:]/g, '')
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > MAX_SENDER_NAME_LEN) {
    out = out.slice(0, MAX_SENDER_NAME_LEN) + '…'
  }
  return out
}

/**
 * Build the prefixed inbound text per Phase 36 D-01 / D-02 / D-04.
 * - senderName undefined or normalized-empty → return rawText unchanged (no '[]:' placeholder).
 * - senderName non-empty + non-empty body → '[Name]: body'
 * - senderName non-empty + empty body → '[Name]:' (no trailing space, attachment-only case)
 */
export function buildPrefixedText(rawText: string, senderName: string | undefined): string {
  const name = normalizeSenderName(senderName)
  if (!name) return rawText
  if (rawText === '') return `[${name}]:`
  return `[${name}]: ${rawText}`
}
