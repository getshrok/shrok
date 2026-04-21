/**
 * Tool-output truncation cap.
 *
 * When raw tool output exceeds `maxChars`, middle-truncate it and insert a
 * distinctive marker that tells the agent exactly how much was elided and how
 * to retry narrower. Framework-internal JSON control responses (spawn_agent,
 * message_agent, etc.) MUST NOT flow through this helper — it's intended only
 * for agent-visible tool OUTPUT (bash dumps, MCP tool results, file reads).
 *
 * The bracketed phrase `[truncated N chars — ...]` is the uniqueness anchor
 * and must not appear anywhere else in src/.
 */

export const DEFAULT_TRUNCATION_HINT =
  're-run with a narrower command (head/tail/grep/jq) or write to a file and read in chunks'

function buildMarker(elided: number, hint: string): string {
  return `…[truncated ${elided} chars — ${hint}]…`
}

export function truncateToolOutput(
  raw: string,
  maxChars: number,
  hint: string = DEFAULT_TRUNCATION_HINT,
): string {
  if (maxChars <= 0) return raw
  if (raw.length <= maxChars) return raw

  // Fixed-point: marker length depends on the digit count of `elided`, which
  // in turn depends on `keep = maxChars - markerLen`. Iterate up to 4 times —
  // enough to cross any single digit boundary (e.g. 9999 ↔ 10000).
  let elided = raw.length - maxChars
  for (let i = 0; i < 4; i++) {
    const m = buildMarker(elided, hint)
    const keep = maxChars - m.length
    if (keep <= 0) return m // degenerate: cap smaller than marker
    const next = raw.length - keep
    if (next === elided) break
    elided = next
  }

  const marker = buildMarker(elided, hint)
  const keep = maxChars - marker.length
  if (keep <= 0) return marker

  const head = Math.floor(keep / 2)
  const tail = keep - head
  return raw.slice(0, head) + marker + raw.slice(raw.length - tail)
}
