import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Dynamically import after calling setters so we can test isolated state
import {
  loadMemoryPromptOverrides,
  listMemoryPrompts,
  setMemoryPromptsWorkspaceDir,
  __resetMemoryPromptsWorkspaceDirForTests,
} from './prompts.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-memprompts-'))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('loadMemoryPromptOverrides', () => {
  let tmpDir: string

  afterEach(() => {
    __resetMemoryPromptsWorkspaceDirForTests()
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns undefined when no files have content', () => {
    // Write all four MEMORY-*.md files to workspace with empty content.
    // Per implementation: workspace wins over defaults, empty content → excluded.
    // So all four fields are excluded → function returns undefined.
    tmpDir = makeTmpDir()
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), '')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ROUTER.md'), '')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ARCHIVER.md'), '')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-SUMMARY-UPDATE.md'), '')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const result = loadMemoryPromptOverrides()
    expect(result).toBeUndefined()
  })

  it('reads default file content into matching field', () => {
    tmpDir = makeTmpDir()
    // Do NOT set workspace dir — use defaults only
    __resetMemoryPromptsWorkspaceDirForTests()

    // The defaults from src/identity/memory-prompts/ contain actual ICW prompt text
    const result = loadMemoryPromptOverrides()
    // chunker.md content starts with "You are a conversation memory chunker"
    expect(result).toBeDefined()
    expect(result?.chunker).toContain('chunker')
  })

  it('workspace overrides default for matching field', () => {
    tmpDir = makeTmpDir()
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ROUTER.md'), 'WS-ROUTER-OVERRIDE')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const result = loadMemoryPromptOverrides()
    expect(result).toBeDefined()
    expect(result?.router).toBe('WS-ROUTER-OVERRIDE')
    // Other fields still come from defaults
    expect(result?.chunker).toBeDefined()
  })

  it('excludes file with empty/whitespace-only content', () => {
    tmpDir = makeTmpDir()
    // Write whitespace-only content for archiver in workspace — should be excluded
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ARCHIVER.md'), '   \n')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const result = loadMemoryPromptOverrides()
    // archiver key must be absent because workspace file is whitespace-only
    // (workspace wins per D-12 — but whitespace = not-set)
    expect(result).toBeDefined()
    expect('archiver' in (result ?? {})).toBe(false)
    // Other fields from defaults still present
    expect(result?.chunker).toBeDefined()
  })

  it('returns full PromptOverrides when all four files have content', () => {
    tmpDir = makeTmpDir()
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'MY-CHUNKER')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ROUTER.md'), 'MY-ROUTER')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-ARCHIVER.md'), 'MY-ARCHIVER')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-SUMMARY-UPDATE.md'), 'MY-SUMMARY-UPDATE')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const result = loadMemoryPromptOverrides()
    expect(result).toBeDefined()
    expect(result?.chunker).toBe('MY-CHUNKER')
    expect(result?.router).toBe('MY-ROUTER')
    expect(result?.archiver).toBe('MY-ARCHIVER')
    expect(result?.summaryUpdate).toBe('MY-SUMMARY-UPDATE')
  })

  it('loader is not cached — re-reads on every call', () => {
    tmpDir = makeTmpDir()
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'v1')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const first = loadMemoryPromptOverrides()
    expect(first?.chunker).toBe('v1')

    // Mutate workspace file
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'v2')

    const second = loadMemoryPromptOverrides()
    expect(second?.chunker).toBe('v2')
  })
})

describe('listMemoryPrompts', () => {
  let tmpDir: string

  afterEach(() => {
    __resetMemoryPromptsWorkspaceDirForTests()
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns merged list with isWorkspace flag', () => {
    tmpDir = makeTmpDir()
    // Override MEMORY-CHUNKER.md in workspace
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'WS-CHUNKER')
    setMemoryPromptsWorkspaceDir(tmpDir)

    const entries = listMemoryPrompts()
    // All four defaults should appear
    expect(entries.length).toBeGreaterThanOrEqual(4)

    const chunkerEntry = entries.find(e => e.filename === 'MEMORY-CHUNKER.md')
    expect(chunkerEntry).toBeDefined()
    expect(chunkerEntry?.isWorkspace).toBe(true)

    const routerEntry = entries.find(e => e.filename === 'MEMORY-ROUTER.md')
    expect(routerEntry).toBeDefined()
    expect(routerEntry?.isWorkspace).toBe(false)

    // Result is sorted alphabetically
    const filenames = entries.map(e => e.filename)
    const sorted = [...filenames].sort((a, b) => a.localeCompare(b))
    expect(filenames).toEqual(sorted)
  })

  it('handles missing workspace dir gracefully', () => {
    __resetMemoryPromptsWorkspaceDirForTests()
    // No workspace dir set at all — still returns all four defaults

    const entries = listMemoryPrompts()
    expect(entries.length).toBe(4)
    for (const entry of entries) {
      expect(entry.isWorkspace).toBe(false)
    }
  })

  it('handles nonexistent workspace dir path gracefully', () => {
    setMemoryPromptsWorkspaceDir('/nonexistent/path/that/does/not/exist')

    const entries = listMemoryPrompts()
    expect(entries.length).toBeGreaterThanOrEqual(4)
    for (const entry of entries) {
      expect(entry.isWorkspace).toBe(false)
    }
  })
})
