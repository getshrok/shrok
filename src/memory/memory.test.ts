import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { LLMFunction } from '../icw/index.js'
import { Memory } from '../icw/index.js'
import { createTopicMemory, toMemoryMessages } from './index.js'
import type { Message } from '../types/core.js'

// ─── Stub LLM ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sat-mem-test-'))
}

function makeStubLlm(response: string): LLMFunction {
  return async (_system: string, _user: string) => response
}

// A stub LLM that returns a valid chunker response assigning messages to a new topic.
// The chunker formats the conversation as "0: User: ...\n1: Assistant: ..." so we
// count lines matching that pattern to get valid indices.
function makeChunkingLlm(label: string): LLMFunction {
  return async (_system: string, user: string) => {
    const matches = user.match(/^\d+: (?:User|Assistant):/gm) ?? []
    const indices = matches.map((_, i) => i)
    if (indices.length === 0) return '[]'
    return JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: label,
      summary: `Summary for ${label}.`,
      entities: [],
      tags: [label.toLowerCase().replace(/\s+/g, '-')],
      timeRange: null,
      messageIndices: indices,
    }])
  }
}

// A retrieval stub LLM that returns a simple ranking
function makeRetrievalLlm(): LLMFunction {
  return async (_system: string, _user: string) => JSON.stringify([])
}

// ─── toMemoryMessages ─────────────────────────────────────────────────────────

describe('toMemoryMessages', () => {
  it('keeps user and assistant text messages', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: 'hello', createdAt: '2025-01-01' },
      { kind: 'text', id: 'm2', role: 'assistant', content: 'hi there', createdAt: '2025-01-01' },
    ]
    const result = toMemoryMessages(msgs)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', content: 'hello' })
    expect(result[1]).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('filters out tool_call messages', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: 'run it', createdAt: '2025-01-01' },
      { kind: 'tool_call', id: 'm2', content: '', toolCalls: [{ id: 'tc1', name: 'bash', input: {} }], createdAt: '2025-01-01' },
      { kind: 'tool_result', id: 'm3', toolResults: [{ toolCallId: 'tc1', name: 'bash', content: 'output' }], createdAt: '2025-01-01' },
    ]
    const result = toMemoryMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('run it')
  })

  it('filters out summary messages', () => {
    const msgs: Message[] = [
      { kind: 'summary', id: 'm1', content: 'old stuff', summarySpan: ['2025-01-01', '2025-01-02'], createdAt: '2025-01-01' },
      { kind: 'text', id: 'm2', role: 'user', content: 'new message', createdAt: '2025-01-02' },
    ]
    const result = toMemoryMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('new message')
  })

  it('returns empty array for empty input', () => {
    expect(toMemoryMessages([])).toEqual([])
  })

  it('appends attachment footer to user message with attachments', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: 'check this out', createdAt: '2025-01-01',
        attachments: [{ type: 'image', mediaType: 'image/jpeg', filename: 'photo.jpg' }] },
    ]
    const result = toMemoryMessages(msgs)
    expect(result[0]!.content).toBe('check this out\n[Attachments: photo.jpg (image/jpeg)]')
  })

  it('just attachment line when content is empty string', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: '', createdAt: '2025-01-01',
        attachments: [{ type: 'image', mediaType: 'image/png', filename: 'img.png' }] },
    ]
    const result = toMemoryMessages(msgs)
    expect(result[0]!.content).toBe('[Attachments: img.png (image/png)]')
  })

  it('multiple attachments → comma-separated in footer', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: 'see attached', createdAt: '2025-01-01',
        attachments: [
          { type: 'image', mediaType: 'image/jpeg', filename: 'a.jpg' },
          { type: 'document', mediaType: 'application/pdf', filename: 'b.pdf' },
        ] },
    ]
    const result = toMemoryMessages(msgs)
    expect(result[0]!.content).toBe('see attached\n[Attachments: a.jpg (image/jpeg), b.pdf (application/pdf)]')
  })

  it('falls back to att.type when no filename', () => {
    const msgs: Message[] = [
      { kind: 'text', id: 'm1', role: 'user', content: 'hello', createdAt: '2025-01-01',
        attachments: [{ type: 'audio', mediaType: 'audio/ogg' }] },
    ]
    const result = toMemoryMessages(msgs)
    expect(result[0]!.content).toContain('[Attachments: audio (audio/ogg)]')
  })
})

// ─── Memory class ─────────────────────────────────────────────────────────────

describe('Memory.chunk and getTopics', () => {
  it('chunk() stores messages into a topic', async () => {
    const tmpDir = makeTmpDir()
    try {
      const llm = makeChunkingLlm('Test Topic')
      const mem = createTopicMemory(tmpDir, llm, 200_000)
      await mem.chunk([
        { role: 'user', content: 'I like TypeScript' },
        { role: 'assistant', content: 'TypeScript is great' },
      ])
      const topics = await mem.getTopics()
      expect(topics.length).toBeGreaterThan(0)
      expect(topics[0]!.label).toBe('Test Topic')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('topics persist across Memory instances at the same path', async () => {
    const tmpDir = makeTmpDir()
    try {
      const llm = makeChunkingLlm('Persistent Topic')
      const mem1 = createTopicMemory(tmpDir, llm, 200_000)
      await mem1.chunk([
        { role: 'user', content: 'remember this' },
        { role: 'assistant', content: 'remembered' },
      ])

      const mem2 = createTopicMemory(tmpDir, makeRetrievalLlm(), 200_000)
      const topics = await mem2.getTopics()
      expect(topics.length).toBeGreaterThan(0)
      expect(topics[0]!.label).toBe('Persistent Topic')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('chunk() does nothing with empty conversation', async () => {
    const tmpDir = makeTmpDir()
    try {
      const llm = makeChunkingLlm('Never')
      const mem = createTopicMemory(tmpDir, llm, 200_000)
      await mem.chunk([])
      const topics = await mem.getTopics()
      expect(topics).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Memory.retrieve', () => {
  it('returns an array (may be empty when no topics exist)', async () => {
    const tmpDir = makeTmpDir()
    try {
      const mem = createTopicMemory(tmpDir, makeRetrievalLlm(), 200_000)
      const results = await mem.retrieve('anything')
      expect(Array.isArray(results)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('createTopicMemory', () => {
  it('returns a Memory instance', () => {
    const tmpDir = makeTmpDir()
    try {
      const mem = createTopicMemory(tmpDir, makeStubLlm("{}"), 200_000)
      expect(mem).toBeInstanceOf(Memory)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
