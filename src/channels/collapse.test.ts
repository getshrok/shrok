import { describe, it, expect } from 'vitest'
import {
  collapseToolCall,
  collapseToolResult,
  parseVerboseMessage,
  expandVerboseMessage,
} from './collapse.js'

describe('collapseToolCall', () => {
  it('includes file_path brief for read_file', () => {
    const result = collapseToolCall('read_file', { file_path: 'src/foo.ts' })
    expect(result).toBe('`🔧 read_file (src/foo.ts) ...`')
  })

  it('includes first token of command for bash', () => {
    const result = collapseToolCall('bash', { command: 'ls' })
    expect(result).toBe('`🔧 bash ...`')
  })

  it('returns no-brief format when no meaningful input', () => {
    const result = collapseToolCall('bash', undefined)
    expect(result).toBe('`🔧 bash ...`')
  })

  it('returns no-brief format when input has no extractable info', () => {
    const result = collapseToolCall('think', { thought: 'some reasoning' })
    expect(result).toBe('`🔧 think ...`')
  })
})

describe('collapseToolResult', () => {
  it('returns OK for successful read_file', () => {
    const result = collapseToolResult('read_file', 'file contents here')
    expect(result).toBe('`🔧 read_file → OK`')
  })

  it('returns exit 0 for successful bash', () => {
    const result = collapseToolResult('bash', '{"exit_code":0,"stdout":"..."}')
    expect(result).toBe('`🔧 bash (exit 0)`')
  })

  it('returns exit 1 for failed bash', () => {
    const result = collapseToolResult('bash', '{"exit_code":1,"stderr":"..."}')
    expect(result).toBe('`🔧 bash (exit 1)`')
  })

  it('returns ERROR for error response', () => {
    const result = collapseToolResult('read_file', '{"error":true,"message":"not found"}')
    expect(result).toBe('`🔧 read_file → ERROR`')
  })

  it('returns OK for web_search with results', () => {
    const result = collapseToolResult('web_search', 'result1\nresult2\nresult3')
    expect(result).toBe('`🔧 web_search → OK`')
  })
})

describe('parseVerboseMessage', () => {
  it('parses raw tool call with arrow and file path', () => {
    const msg = '→ read_file (src/foo.ts)\n{"file_path":"src/foo.ts"}'
    const result = parseVerboseMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('call')
    expect(result!.toolName).toBe('read_file')
  })

  it('parses raw tool result with left arrow', () => {
    const msg = '← read_file\nfile content here'
    const result = parseVerboseMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('result')
    expect(result!.toolName).toBe('read_file')
  })

  it('parses agent-wrapped tool call', () => {
    const msg = '```\n[🔵 agent-name] → read_file (src/foo.ts)\n{"preview":"..."}\n```'
    const result = parseVerboseMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('call')
    expect(result!.toolName).toBe('read_file')
  })

  it('parses agent-wrapped tool result', () => {
    const msg = '```\n[🔵 agent-name] ← write_file\nresult content\n```'
    const result = parseVerboseMessage(msg)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('result')
    expect(result!.toolName).toBe('write_file')
  })

  it('returns null for plain text messages', () => {
    const result = parseVerboseMessage('This is just a plain message with no tool info.')
    expect(result).toBeNull()
  })

  it('returns null for thinking blocks', () => {
    const result = parseVerboseMessage('<thinking>Some reasoning here</thinking>')
    expect(result).toBeNull()
  })

  it('returns null for system events', () => {
    const result = parseVerboseMessage('🟡 [system] Agent started')
    expect(result).toBeNull()
  })
})

describe('expandVerboseMessage', () => {
  it('returns the message as-is if under 1900 chars', () => {
    const msg = 'Short message'
    expect(expandVerboseMessage(msg)).toBe('Short message')
  })

  it('truncates messages over 1900 chars', () => {
    const longMsg = 'x'.repeat(2000)
    const result = expandVerboseMessage(longMsg)
    expect(result.length).toBeLessThanOrEqual(1900)
  })
})
