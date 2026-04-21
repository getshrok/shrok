import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { injectSkillMemory, resolveToolPath } from '../../src/sub-agents/skill-memory.js'
import type { Message, ToolCallMessage, ToolResultMessage, ToolCall, ToolResult } from '../../src/types/core.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string

function setupSkillsDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-test-skills-'))
  const gmailDir = path.join(tmpDir, 'gmail')
  fs.mkdirSync(gmailDir)
  fs.writeFileSync(path.join(gmailDir, 'SKILL.md'), '---\nname: gmail\n---\nGmail instructions')
  fs.writeFileSync(path.join(gmailDir, 'MEMORY.md'), 'GMAIL_CLIENT_ID=test123\nGMAIL_REFRESH_TOKEN=tok456')

  // A skill without MEMORY.md
  const githubDir = path.join(tmpDir, 'github')
  fs.mkdirSync(githubDir)
  fs.writeFileSync(path.join(githubDir, 'SKILL.md'), '---\nname: github\n---\nGitHub instructions')

  return tmpDir
}

function makeToolCall(id: string, calls: { id: string; name: string; input: Record<string, unknown> }[]): ToolCallMessage {
  return {
    kind: 'tool_call', id, createdAt: new Date().toISOString(), content: '',
    toolCalls: calls as [ToolCall, ...ToolCall[]],
  } as ToolCallMessage
}

function makeToolResult(id: string, results: { toolCallId: string; name: string; content: string }[]): ToolResultMessage {
  return {
    kind: 'tool_result', id, createdAt: new Date().toISOString(),
    toolResults: results as [ToolResult, ...ToolResult[]],
  } as ToolResultMessage
}

// ─── resolveToolPath ─────────────────────────────────────────────────────────

describe('resolveToolPath', () => {
  it('resolves absolute paths as-is', () => {
    expect(resolveToolPath('/home/user/skills/gmail/SKILL.md')).toBe('/home/user/skills/gmail/SKILL.md')
  })

  it('expands $VAR env variables', () => {
    process.env['TEST_SKILLS_DIR'] = '/tmp/test-skills'
    expect(resolveToolPath('$TEST_SKILLS_DIR/gmail/SKILL.md')).toBe('/tmp/test-skills/gmail/SKILL.md')
    delete process.env['TEST_SKILLS_DIR']
  })

  it('expands ${VAR} env variables', () => {
    process.env['TEST_SKILLS_DIR'] = '/tmp/test-skills'
    expect(resolveToolPath('${TEST_SKILLS_DIR}/gmail/SKILL.md')).toBe('/tmp/test-skills/gmail/SKILL.md')
    delete process.env['TEST_SKILLS_DIR']
  })

  it('expands ~/ to home directory', () => {
    const result = resolveToolPath('~/skills/gmail/SKILL.md')
    expect(result).toBe(path.join(os.homedir(), 'skills/gmail/SKILL.md'))
  })

  it('resolves relative paths from cwd', () => {
    const result = resolveToolPath('./skills/gmail/SKILL.md')
    expect(result).toBe(path.resolve('./skills/gmail/SKILL.md'))
  })
})

// ─── injectSkillMemory ──────────────────────────────────────────────────────

describe('injectSkillMemory', () => {
  beforeEach(() => { setupSkillsDir() })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // ── read_file paths ────────────────────────────────────────────────────

  describe('read_file with various path formats', () => {
    function testReadFile(pathStr: string) {
      const tcId = 'tc1'
      const callMsg = makeToolCall('msg1', [{ id: tcId, name: 'read_file', input: { path: pathStr } }])
      const resultMsg = makeToolResult('msg2', [{ toolCallId: tcId, name: 'read_file', content: 'Gmail instructions' }])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      return history
    }

    it('injects MEMORY.md for absolute path to SKILL.md', () => {
      const history = testReadFile(path.join(tmpDir, 'gmail', 'SKILL.md'))
      expect(history).toHaveLength(4) // call, result, synthetic call, synthetic result
      const synResult = history[3] as ToolResultMessage
      expect(synResult.toolResults[0]!.content).toContain('GMAIL_CLIENT_ID=test123')
    })

    it('injects MEMORY.md for $SHROK_SKILLS_DIR path', () => {
      process.env['SHROK_SKILLS_DIR'] = tmpDir
      const history = testReadFile('$SHROK_SKILLS_DIR/gmail/SKILL.md')
      delete process.env['SHROK_SKILLS_DIR']
      expect(history).toHaveLength(4)
      const synResult = history[3] as ToolResultMessage
      expect(synResult.toolResults[0]!.content).toContain('GMAIL_REFRESH_TOKEN=tok456')
    })

    it('injects MEMORY.md for ${SHROK_SKILLS_DIR} path', () => {
      process.env['SHROK_SKILLS_DIR'] = tmpDir
      const history = testReadFile('${SHROK_SKILLS_DIR}/gmail/SKILL.md')
      delete process.env['SHROK_SKILLS_DIR']
      expect(history).toHaveLength(4)
    })

    it('does NOT inject for skill without MEMORY.md', () => {
      const history = testReadFile(path.join(tmpDir, 'github', 'SKILL.md'))
      expect(history).toHaveLength(2) // no injection
    })

    it('does NOT inject for SKILL.md outside skills directory', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-other-'))
      fs.mkdirSync(path.join(otherDir, 'fake'))
      fs.writeFileSync(path.join(otherDir, 'fake', 'SKILL.md'), 'fake skill')
      fs.writeFileSync(path.join(otherDir, 'fake', 'MEMORY.md'), 'fake memory')
      const history = testReadFile(path.join(otherDir, 'fake', 'SKILL.md'))
      expect(history).toHaveLength(2)
      fs.rmSync(otherDir, { recursive: true, force: true })
    })

    it('does NOT inject for non-SKILL.md files', () => {
      const history = testReadFile(path.join(tmpDir, 'gmail', 'MEMORY.md'))
      expect(history).toHaveLength(2)
    })
  })

  // ── read_multiple_files ────────────────────────────────────────────────

  describe('read_multiple_files', () => {
    it('injects MEMORY.md when SKILL.md is in a multi-read', () => {
      const skillPath = path.join(tmpDir, 'gmail', 'SKILL.md')
      const tcId = 'tc1'
      const callMsg = makeToolCall('msg1', [{
        id: tcId, name: 'read_multiple_files',
        input: { paths: [skillPath, '/some/other/file.txt'] },
      }])
      const resultMsg = makeToolResult('msg2', [{
        toolCallId: tcId, name: 'read_multiple_files',
        content: `=== ${skillPath} ===\nGmail instructions\n\n=== /some/other/file.txt ===\nother stuff`,
      }])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(4)
      const synResult = history[3] as ToolResultMessage
      expect(synResult.toolResults[0]!.content).toContain('GMAIL_CLIENT_ID=test123')
    })

    it('injects MEMORY.md for $SHROK_SKILLS_DIR in multi-read', () => {
      process.env['SHROK_SKILLS_DIR'] = tmpDir
      const tcId = 'tc1'
      const resolvedPath = path.join(tmpDir, 'gmail', 'SKILL.md')
      const callMsg = makeToolCall('msg1', [{
        id: tcId, name: 'read_multiple_files',
        input: { paths: ['$SHROK_SKILLS_DIR/gmail/SKILL.md'] },
      }])
      const resultMsg = makeToolResult('msg2', [{
        toolCallId: tcId, name: 'read_multiple_files',
        content: `=== ${resolvedPath} ===\nGmail instructions`,
      }])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      delete process.env['SHROK_SKILLS_DIR']
      expect(history).toHaveLength(4)
    })

    it('does NOT inject when SKILL.md read failed in multi-read', () => {
      const resolvedPath = path.join(tmpDir, 'gmail', 'SKILL.md')
      const tcId = 'tc1'
      const callMsg = makeToolCall('msg1', [{
        id: tcId, name: 'read_multiple_files',
        input: { paths: [resolvedPath] },
      }])
      const resultMsg = makeToolResult('msg2', [{
        toolCallId: tcId, name: 'read_multiple_files',
        content: `=== ${resolvedPath} ===\nError: ENOENT: no such file or directory`,
      }])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(2)
    })
  })

  // ── Dedup ──────────────────────────────────────────────────────────────

  describe('deduplication', () => {
    it('does NOT inject when agent already reads MEMORY.md via read_file in same batch', () => {
      const skillPath = path.join(tmpDir, 'gmail', 'SKILL.md')
      const memPath = path.join(tmpDir, 'gmail', 'MEMORY.md')
      const callMsg = makeToolCall('msg1', [
        { id: 'tc1', name: 'read_file', input: { path: skillPath } },
        { id: 'tc2', name: 'read_file', input: { path: memPath } },
      ])
      const resultMsg = makeToolResult('msg2', [
        { toolCallId: 'tc1', name: 'read_file', content: 'Gmail instructions' },
        { toolCallId: 'tc2', name: 'read_file', content: 'GMAIL_CLIENT_ID=test123' },
      ])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(2) // no injection — agent already read it
    })

    it('does NOT inject when agent reads MEMORY.md via read_multiple_files in same batch', () => {
      const skillPath = path.join(tmpDir, 'gmail', 'SKILL.md')
      const memPath = path.join(tmpDir, 'gmail', 'MEMORY.md')
      const tcId = 'tc1'
      const callMsg = makeToolCall('msg1', [{
        id: tcId, name: 'read_multiple_files',
        input: { paths: [skillPath, memPath] },
      }])
      const resultMsg = makeToolResult('msg2', [{
        toolCallId: tcId, name: 'read_multiple_files',
        content: `=== ${skillPath} ===\nGmail instructions\n\n=== ${memPath} ===\nGMAIL_CLIENT_ID=test123`,
      }])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(2)
    })

    it('does NOT inject when MEMORY.md read via $SHROK_SKILLS_DIR in same batch', () => {
      process.env['SHROK_SKILLS_DIR'] = tmpDir
      const callMsg = makeToolCall('msg1', [
        { id: 'tc1', name: 'read_file', input: { path: '$SHROK_SKILLS_DIR/gmail/SKILL.md' } },
        { id: 'tc2', name: 'read_file', input: { path: '$SHROK_SKILLS_DIR/gmail/MEMORY.md' } },
      ])
      const resultMsg = makeToolResult('msg2', [
        { toolCallId: 'tc1', name: 'read_file', content: 'Gmail instructions' },
        { toolCallId: 'tc2', name: 'read_file', content: 'credentials' },
      ])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      delete process.env['SHROK_SKILLS_DIR']
      expect(history).toHaveLength(2)
    })
  })

  // ── Multiple skills in one batch ───────────────────────────────────────

  describe('multiple skills', () => {
    it('injects MEMORY.md for multiple skills read in one batch', () => {
      // Add a second skill with MEMORY.md
      const zohoDir = path.join(tmpDir, 'zoho-mail')
      fs.mkdirSync(zohoDir)
      fs.writeFileSync(path.join(zohoDir, 'SKILL.md'), 'Zoho instructions')
      fs.writeFileSync(path.join(zohoDir, 'MEMORY.md'), 'ZOHO_TOKEN=abc')

      const callMsg = makeToolCall('msg1', [
        { id: 'tc1', name: 'read_file', input: { path: path.join(tmpDir, 'gmail', 'SKILL.md') } },
        { id: 'tc2', name: 'read_file', input: { path: path.join(tmpDir, 'zoho-mail', 'SKILL.md') } },
      ])
      const resultMsg = makeToolResult('msg2', [
        { toolCallId: 'tc1', name: 'read_file', content: 'Gmail instructions' },
        { toolCallId: 'tc2', name: 'read_file', content: 'Zoho instructions' },
      ])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(4)
      const synResult = history[3] as ToolResultMessage
      expect(synResult.toolResults).toHaveLength(2)
      expect(synResult.toolResults[0]!.content).toContain('GMAIL_CLIENT_ID')
      expect(synResult.toolResults[1]!.content).toContain('ZOHO_TOKEN')
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('no-ops when no tool_call message found in history', () => {
      const resultMsg = makeToolResult('msg1', [
        { toolCallId: 'tc1', name: 'read_file', content: 'stuff' },
      ])
      const history: Message[] = [resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(1)
    })

    it('no-ops for non-read_file tools', () => {
      const callMsg = makeToolCall('msg1', [
        { id: 'tc1', name: 'bash', input: { command: 'cat /tmp/SKILL.md' } },
      ])
      const resultMsg = makeToolResult('msg2', [
        { toolCallId: 'tc1', name: 'bash', content: 'skill content' },
      ])
      const history: Message[] = [callMsg, resultMsg]
      injectSkillMemory(tmpDir, resultMsg, history)
      expect(history).toHaveLength(2)
    })
  })
})
