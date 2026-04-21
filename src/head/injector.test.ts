import { describe, it, expect } from 'vitest'
import { formatWorkForSummary } from './injector.js'
import type { Message } from '../types/core.js'

function text(content: string): Message {
  return { id: 'm', role: 'assistant', kind: 'text', content, createdAt: '' } as Message
}
function call(name: string, input: Record<string, unknown>): Message {
  return {
    id: 'm', role: 'assistant', kind: 'tool_call', createdAt: '', content: '',
    toolCalls: [{ id: 'tc', name, input }],
  } as Message
}
function result(name: string, content: string): Message {
  return {
    id: 'm', role: 'user', kind: 'tool_result', createdAt: '',
    toolResults: [{ toolCallId: 'tc', name, content }],
  } as Message
}

describe('formatWorkForSummary', () => {
  it('includes text, tool_call, and tool_result lines in order', () => {
    const out = formatWorkForSummary([
      text('hi'),
      call('bash', { command: 'ls' }),
      result('bash', 'file1\nfile2'),
    ])
    expect(out).toBe('[text] hi\n[tool_call] bash: {"command":"ls"}\n[tool_result] bash: file1\nfile2')
  })

  it('returns everything unchanged when under total cap', () => {
    const out = formatWorkForSummary([text('a'), text('b')], { totalChars: 1000 })
    expect(out).not.toContain('elided')
    expect(out).toBe('[text] a\n[text] b')
  })

  it('preserves failed tool_results when a verbose success would otherwise evict them', () => {
    // Two small failures followed by one giant success. Under old newest-wins
    // eviction, the failures would get crowded out. They must survive now.
    const hugeBody = 'x'.repeat(900)
    const msgs: Message[] = [
      result('browser', '{"error":"Timed out waiting for browser sidecar to start"}'),
      result('browser', '{"error":"Timed out waiting for browser sidecar to start"}'),
      result('web_fetch', hugeBody),
    ]
    const out = formatWorkForSummary(msgs, { totalChars: 500, toolResultChars: 900 })
    // Both failures kept.
    const failureHits = out.match(/Timed out/g) ?? []
    expect(failureHits.length).toBe(2)
    // The verbose success got evicted.
    expect(out).not.toContain('xxxxxxxx')
    expect(out).toContain('failures preserved')
  })

  it('detects common failure signatures (exit code, stderr, thrown errors, timeout)', () => {
    const msgs: Message[] = [
      text('padding'.repeat(200)),  // non-failure
      result('bash', 'Exit code: 1\nStderr: permission denied'),
      result('python', 'Traceback (most recent call last):\n  File "x.py"'),
      result('node', 'Error: ENOENT: no such file or directory'),
    ]
    const out = formatWorkForSummary(msgs, { totalChars: 300, textChars: 2000 })
    expect(out).toContain('Exit code: 1')
    expect(out).toContain('Traceback')
    expect(out).toContain('ENOENT')
    // padding text was non-failure and got evicted to make room.
    expect(out).not.toContain('paddingpadding')
  })

  it('does not flag benign successes as failures', () => {
    // Strings that contain "error" in an unrelated context shouldn't be flagged.
    const msgs: Message[] = [
      result('bash', 'search results: 3 matches for "error handling"'),
      result('bash', 'ok'),
    ]
    // Force cap pressure — if neither is a failure, both get kept newest-first.
    const out = formatWorkForSummary(msgs, { totalChars: 50 })
    // The most recent entry fits; the earlier one is evicted. No "failures preserved" tag.
    expect(out).not.toContain('failures preserved')
    expect(out).toContain('[tool_result] bash: ok')
  })

  it('keeps newest failures when failure total alone exceeds cap', () => {
    const body = 'Error: something went wrong. '.repeat(20)  // each ~600 chars
    const msgs: Message[] = [
      result('t', body),
      result('t', body),
      result('t', body),
    ]
    const out = formatWorkForSummary(msgs, { totalChars: 700, toolResultChars: 2000 })
    // Only one fits in 700 chars; the eviction pass should skip the ones that
    // don't fit instead of bailing out entirely.
    const hits = out.match(/something went wrong/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(1)
    // "failures preserved" note only appears when successes were evicted to
    // make room — here every entry is a failure, so no note.
    expect(out).toContain('earlier entries elided')
  })
})
