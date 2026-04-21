import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileSystemIdentityLoader } from './loader.js'

describe('FileSystemIdentityLoader', () => {
  let workspaceDir: string
  let defaultsDir: string
  let loader: FileSystemIdentityLoader

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-workspace-'))
    defaultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-defaults-'))
    loader = new FileSystemIdentityLoader(workspaceDir, defaultsDir)
  })

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(defaultsDir, { recursive: true, force: true })
  })

  function writeWorkspace(filename: string, content: string) {
    fs.writeFileSync(path.join(workspaceDir, filename), content, 'utf8')
  }

  function writeDefaults(filename: string, content: string) {
    fs.writeFileSync(path.join(defaultsDir, filename), content, 'utf8')
  }

  it('returns a single file contents as-is', () => {
    writeWorkspace('SYSTEM.md', 'You are a helpful assistant.')
    expect(loader.loadSystemPrompt()).toBe('You are a helpful assistant.')
  })

  it('concatenates multiple .md files in alphabetical order', () => {
    writeWorkspace('A.md', 'first')
    writeWorkspace('B.md', 'second')
    writeWorkspace('C.md', 'third')
    const result = loader.loadSystemPrompt()
    expect(result.indexOf('first')).toBeLessThan(result.indexOf('second'))
    expect(result.indexOf('second')).toBeLessThan(result.indexOf('third'))
  })

  it('separates files with --- dividers', () => {
    writeWorkspace('A.md', 'first')
    writeWorkspace('B.md', 'second')
    const result = loader.loadSystemPrompt()
    expect(result).toContain('---')
    expect(result.indexOf('---')).toBeGreaterThan(result.indexOf('first'))
    expect(result.indexOf('---')).toBeLessThan(result.indexOf('second'))
  })

  it('ignores non-.md files', () => {
    writeWorkspace('SYSTEM.md', 'keep this')
    writeWorkspace('notes.txt', 'ignore this')
    writeWorkspace('config.json', '{}')
    const result = loader.loadSystemPrompt()
    expect(result).toBe('keep this')
    expect(result).not.toContain('ignore this')
  })

  it('returns empty string when directory has no .md files', () => {
    expect(loader.loadSystemPrompt()).toBe('')
  })

  it('returns empty string when both directories do not exist', () => {
    const missing = new FileSystemIdentityLoader('/tmp/no-workspace-shrok-test', '/tmp/no-defaults-shrok-test')
    expect(missing.loadSystemPrompt()).toBe('')
  })

  it('reads files fresh on each call (live-editable)', () => {
    writeWorkspace('SYSTEM.md', 'Version 1')
    expect(loader.loadSystemPrompt()).toBe('Version 1')
    writeWorkspace('SYSTEM.md', 'Version 2')
    expect(loader.loadSystemPrompt()).toBe('Version 2')
  })

  it('picks up new files added between calls', () => {
    writeWorkspace('SYSTEM.md', 'base')
    const r1 = loader.loadSystemPrompt()
    expect(r1).not.toContain('soul')

    writeWorkspace('SOUL.md', 'soul')
    const r2 = loader.loadSystemPrompt()
    expect(r2).toContain('soul')
  })

  it('defaults files are included when workspace has none', () => {
    writeDefaults('SYSTEM.md', 'default system prompt')
    expect(loader.loadSystemPrompt()).toBe('default system prompt')
  })

  it('workspace file overrides defaults file of the same name', () => {
    writeDefaults('SYSTEM.md', 'default')
    writeWorkspace('SYSTEM.md', 'override')
    expect(loader.loadSystemPrompt()).toBe('override')
  })

  it('merges defaults and workspace files when names differ', () => {
    writeDefaults('A.md', 'from defaults')
    writeWorkspace('B.md', 'from workspace')
    const result = loader.loadSystemPrompt()
    expect(result).toContain('from defaults')
    expect(result).toContain('from workspace')
  })

  it('listFiles returns merged file list', () => {
    writeDefaults('A.md', 'a')
    writeWorkspace('B.md', 'b')
    expect(loader.listFiles()).toEqual(['A.md', 'B.md'])
  })

  it('readFile returns workspace version when present', () => {
    writeDefaults('SYSTEM.md', 'default')
    writeWorkspace('SYSTEM.md', 'workspace')
    expect(loader.readFile('SYSTEM.md')).toBe('workspace')
  })

  it('readFile falls back to defaults', () => {
    writeDefaults('SYSTEM.md', 'default')
    expect(loader.readFile('SYSTEM.md')).toBe('default')
  })

  it('readFile returns null when file exists in neither', () => {
    expect(loader.readFile('MISSING.md')).toBeNull()
  })
})
