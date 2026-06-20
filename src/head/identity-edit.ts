/**
 * Pure, targeted-edit applier for head identity files.
 *
 * `write_identity` is edits-only: the head replaces exact passages rather than
 * re-sending an entire file. This keeps each write small in conversation context
 * (only the diff lands in history), so a single identity write can never grow large
 * enough to truncate the head's recent-conversation window — the failure mode that
 * a whole-file overwrite caused.
 *
 * This module is deliberately filesystem-free so it is fully unit-testable and so the
 * caller can apply edits to an in-memory copy and only write to disk when EVERY edit
 * succeeds (all-or-nothing). A simpler/stricter cousin of the agent `edit_file`
 * executor: exact-substring matching only (no whitespace-normalized fallback — that is
 * meant for source code and would silently mis-match prose), and each oldText must
 * match exactly once.
 */

export interface IdentityEdit {
  oldText: string
  newText: string
}

export interface IdentityEditResult {
  /** The full file content after all edits are applied. */
  content: string
  /** Compact, length-capped unified-ish diff of the changes, for the tool result. */
  diff: string
}

// Cap each rendered diff side so a head that passes a huge edit can't re-wall history
// via the tool *result* (the same way a huge tool *call* did originally).
const MAX_DIFF_SIDE_CHARS = 2000
const MAX_DIFF_SIDE_LINES = 40

const normalize = (s: string): string => s.replace(/\r\n/g, '\n')

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** Render one side of a diff (`-` old / `+` new), truncated to the caps above. */
function diffSide(prefix: '-' | '+', text: string): string {
  const lines = text.split('\n')
  const limited = lines.length > MAX_DIFF_SIDE_LINES
    ? [...lines.slice(0, MAX_DIFF_SIDE_LINES), '…(truncated)']
    : lines
  let joined = limited.map(l => `${prefix} ${l}`).join('\n')
  if (joined.length > MAX_DIFF_SIDE_CHARS) {
    joined = `${joined.slice(0, MAX_DIFF_SIDE_CHARS)}…(truncated)`
  }
  return joined
}

/**
 * Apply targeted edits to `content`, returning the new content and a compact diff.
 *
 * Edits are applied sequentially to a progressively-modified copy — edit N sees the
 * result of edits 1..N-1, and uniqueness is checked against that working copy. Throws
 * (without producing partial output) on the first edit that does not match exactly once,
 * so the caller can treat the whole call as all-or-nothing.
 */
export function applyIdentityEdits(content: string, edits: IdentityEdit[]): IdentityEditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('No edits provided — pass at least one { oldText, newText } edit.')
  }

  let working = normalize(content)
  const diffParts: string[] = []

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!
    const oldText = normalize(edit?.oldText ?? '')
    const newText = normalize(edit?.newText ?? '')

    if (oldText === '') {
      throw new Error(`edit ${i + 1}: oldText is empty — provide the exact text to replace (to clear a file, set oldText to its full current contents and newText to "").`)
    }

    const occurrences = countOccurrences(working, oldText)
    if (occurrences === 0) {
      throw new Error(`edit ${i + 1}: oldText not found — copy the exact text to replace from the file as it appears in your context.`)
    }
    if (occurrences > 1) {
      throw new Error(`edit ${i + 1}: oldText matched ${occurrences} times — include more surrounding context so it matches exactly once.`)
    }

    working = working.replace(oldText, newText)
    diffParts.push(`@@ edit ${i + 1} @@`, diffSide('-', oldText), diffSide('+', newText))
  }

  return { content: working, diff: diffParts.join('\n') }
}
