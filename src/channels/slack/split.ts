/**
 * Block-aware Slack message normalizer.
 *
 * splitSlackBlocks: normalize a blocks array so every block satisfies Slack's
 *   per-block limits (section text ≤3000 chars, section fields ≤10, each field
 *   text ≤2000 chars). Oversized blocks are split/truncated into compliant ones.
 *
 * batchSlackBlocks: group a (normalized) blocks array into batches of ≤maxPerMsg
 *   blocks each, for use in sequential chat.postMessage calls.
 */

import { splitMessage } from '../chunker.js'
import type { SlackBlock, SlackTextField } from '../table-formatter.js'

const SLACK_SECTION_TEXT_MAX = 3000
const SLACK_FIELDS_MAX = 10
const SLACK_FIELD_TEXT_MAX = 2000
export const SLACK_BLOCKS_PER_MSG = 50

/**
 * Normalize a single text-variant section block that exceeds the 3000-char limit.
 *
 * Code-block detection: if text.text starts with ``` after optional whitespace,
 * it is a fenced code block. We delegate to splitMessage (fence-aware) so each
 * output chunk is its own valid ``` fence. For non-code text we split on the last
 * newline boundary before 3000; hard-cut when no usable newline is found.
 *
 * Each output block preserves the original text.type ('mrkdwn' typically).
 */
function splitTextSection(block: { type: 'section'; text: SlackTextField; fields?: never }): SlackBlock[] {
  const { text } = block
  if (text.text.length <= SLACK_SECTION_TEXT_MAX) return [block]

  const isCodeBlock = text.text.trimStart().startsWith('```')

  if (isCodeBlock) {
    // splitMessage is fence-aware: it re-opens/closes the fence with the lang tag.
    // The closing/reopening fence markers add up to ~20 extra chars per boundary
    // (e.g. '\n```' = 4 chars to close + '```lang\n' = up to 16 chars to reopen).
    // We pass a reduced limit so each output chunk stays comfortably within 3000.
    const pieces = splitMessage(text.text, SLACK_SECTION_TEXT_MAX - 20)
    return pieces.map(piece => ({
      type: 'section' as const,
      text: { type: text.type, text: piece },
    }))
  }

  // Non-code: split on '\n' boundaries, hard-cut when necessary
  const result: SlackBlock[] = []
  let remaining = text.text
  while (remaining.length > SLACK_SECTION_TEXT_MAX) {
    const slice = remaining.slice(0, SLACK_SECTION_TEXT_MAX)
    const lastNl = slice.lastIndexOf('\n')
    const cutAt = lastNl > 0 ? lastNl : SLACK_SECTION_TEXT_MAX
    const piece = remaining.slice(0, cutAt)
    result.push({ type: 'section', text: { type: text.type, text: piece } })
    remaining = remaining.slice(cutAt).replace(/^\n/, '')
  }
  if (remaining.length > 0) {
    result.push({ type: 'section', text: { type: text.type, text: remaining } })
  }
  return result
}

/**
 * Normalize a fields-variant section block.
 *
 * Per-field truncation: a single field's text is capped at SLACK_FIELD_TEXT_MAX
 * (2000 chars). We truncate rather than split because a Slack field is a single
 * cell in a 2-column layout — splitting one cell across blocks would corrupt the
 * table alignment.
 *
 * Per-section field cap: after truncation, the fields array is chunked into
 * groups of ≤SLACK_FIELDS_MAX (10).
 */
function splitFieldsSection(block: { type: 'section'; fields: SlackTextField[]; text?: never }): SlackBlock[] {
  // 1. Truncate individual fields
  const truncated: SlackTextField[] = block.fields.map(field => {
    if (field.text.length <= SLACK_FIELD_TEXT_MAX) return field
    return { type: field.type, text: field.text.slice(0, SLACK_FIELD_TEXT_MAX) }
  })

  // 2. Chunk into groups of ≤SLACK_FIELDS_MAX
  const result: SlackBlock[] = []
  for (let i = 0; i < truncated.length; i += SLACK_FIELDS_MAX) {
    const group = truncated.slice(i, i + SLACK_FIELDS_MAX)
    result.push({ type: 'section', fields: group })
  }
  return result
}

/**
 * Normalize all blocks in the array against Slack's per-block limits.
 * Blocks that are within limits are returned unchanged (same object reference).
 * The overall block order is preserved.
 */
export function splitSlackBlocks(blocks: SlackBlock[]): SlackBlock[] {
  const result: SlackBlock[] = []
  for (const block of blocks) {
    if (block.type !== 'section') {
      result.push(block)
      continue
    }
    if (block.fields !== undefined) {
      // fields-variant
      const expanded = splitFieldsSection(block as { type: 'section'; fields: SlackTextField[]; text?: never })
      result.push(...expanded)
    } else {
      // text-variant (text must be present since the discriminated union has text?: never on fields side)
      const textBlock = block as { type: 'section'; text: SlackTextField; fields?: never }
      const expanded = splitTextSection(textBlock)
      result.push(...expanded)
    }
  }
  return result
}

/**
 * Group a normalized blocks array into batches of at most maxPerMsg blocks each.
 * When blocks.length ≤ maxPerMsg, returns a single batch (the array contents unchanged).
 * Block order within and across batches is preserved.
 */
export function batchSlackBlocks(blocks: SlackBlock[], maxPerMsg = SLACK_BLOCKS_PER_MSG): SlackBlock[][] {
  if (blocks.length <= maxPerMsg) return [blocks]
  const batches: SlackBlock[][] = []
  for (let i = 0; i < blocks.length; i += maxPerMsg) {
    batches.push(blocks.slice(i, i + maxPerMsg))
  }
  return batches
}
