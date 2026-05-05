import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { archiveMessages } from './archival.js'
import {
  setMemoryPromptsWorkspaceDir,
  __resetMemoryPromptsWorkspaceDirForTests,
} from '../memory/prompts.js'
import type { Memory } from '../memory/index.js'
import type { Message } from '../types/core.js'
import type { MessageStore } from '../db/messages.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockMemory(chunkSpy: (args: unknown[]) => void): Memory {
  return {
    chunk: async (...args: unknown[]) => { chunkSpy(args) },
    getTopics: async () => [],
    retrieve: async () => [],
    retrieveByEntity: async () => [],
    retrieveByIds: async () => [],
    compact: async () => {},
    deleteTopic: async () => {},
  } as unknown as Memory
}

function makeMockMessageStore(): MessageStore {
  return {
    append: () => {},
    deleteByIds: () => {},
    getAll: () => [],
    getByIds: () => [],
    countTokens: () => 0,
  } as unknown as MessageStore
}

function makeMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'text' as const,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    id: `msg-${i}`,
    content: `message ${i}`,
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
  }))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('archiveMessages + loadMemoryPromptOverrides wiring', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archival-test-'))
    setMemoryPromptsWorkspaceDir(tmpDir)
  })

  afterEach(() => {
    __resetMemoryPromptsWorkspaceDirForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('chunk receives prompts from loadMemoryPromptOverrides when workspace files exist', async () => {
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'WS-CHUNKER')
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-SUMMARY-UPDATE.md'), 'WS-SUM')

    let capturedArgs: unknown[] = []
    const memory = makeMockMemory(args => { capturedArgs = args })
    const messages = makeMockMessageStore()

    await archiveMessages(makeMessages(4), { topicMemory: memory, messages }, 0.5)

    expect(capturedArgs.length).toBe(2)
    const promptsArg = capturedArgs[1] as { chunker?: string; summaryUpdate?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(promptsArg?.chunker).toBe('WS-CHUNKER')
    expect(promptsArg?.summaryUpdate).toBe('WS-SUM')
  })

  it('chunk receives loaded defaults when no workspace overrides exist', async () => {
    // No workspace MEMORY-*.md files — loader falls through to shipped defaults.
    // Shipped defaults have non-empty content, so the second arg must be a defined object.
    let capturedArgs: unknown[] = []
    const memory = makeMockMemory(args => { capturedArgs = args })
    const messages = makeMockMessageStore()

    await archiveMessages(makeMessages(4), { topicMemory: memory, messages }, 0.5)

    expect(capturedArgs.length).toBe(2)
    // Shipped defaults exist — second arg should be a PromptOverrides object, not undefined.
    const promptsArg = capturedArgs[1] as { chunker?: string } | undefined
    expect(promptsArg).toBeDefined()
    expect(typeof promptsArg?.chunker).toBe('string')
    expect((promptsArg?.chunker?.length ?? 0)).toBeGreaterThan(0)
  })

  it('loader is re-invoked on every archiveMessages call (read-on-every-call, D-11)', async () => {
    // V1 chunker prompt
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'V1')

    let firstArgs: unknown[] = []
    const m1 = makeMockMemory(args => { firstArgs = args })
    await archiveMessages(makeMessages(4), { topicMemory: m1, messages: makeMockMessageStore() }, 0.5)
    expect((firstArgs[1] as { chunker?: string }).chunker).toBe('V1')

    // Mutate workspace file between calls
    fs.writeFileSync(path.join(tmpDir, 'MEMORY-CHUNKER.md'), 'V2')

    let secondArgs: unknown[] = []
    const m2 = makeMockMemory(args => { secondArgs = args })
    await archiveMessages(makeMessages(4), { topicMemory: m2, messages: makeMockMessageStore() }, 0.5)
    expect((secondArgs[1] as { chunker?: string }).chunker).toBe('V2')
  })
})
