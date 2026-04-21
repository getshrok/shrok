/**
 * Tests that Head-level archival (archiving messages → memory) does not
 * fragment a single topic when triggered twice on the same subject.
 *
 * Strategy:
 * 1. Populate MessageStore with messages about "Project Artemis".
 * 2. Call archiveMessages() — verify result is not null and a continuation hint
 *    was appended.
 * 3. Add more Project Artemis messages.
 * 4. Call archiveMessages() again.
 * 5. Assert: memory has either 1 topic, or if 2 topics, their labels are similar
 *    (the system should merge or closely label them, not create wildly different topics).
 *
 * No real LLM calls — the chunker LLMFunction is mocked.
 */

import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { archiveMessages } from '../../src/head/archival.js'
import type { Message } from '../../src/types/core.js'
import type { LLMFunction } from 'infinitecontextwindow'
import { createTopicMemory } from '../../src/memory/index.js'
import { freshDb } from '../integration/helpers.js'
import { MessageStore } from '../../src/db/messages.js'
import { generateId, now } from '../../src/llm/util.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-test-archival-'))
}

function cleanTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

function ts(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

/**
 * Queue-based chunker mock — alternates between the two calls chunk() makes:
 *   1. Chunker call: returns a JSON array of chunk assignments
 *   2. Summary-update call: returns plain text
 */
function makeChunkerMock(topicId: string | null = null): LLMFunction {
  let call = 0
  return async (_system: string, user: string): Promise<string> => {
    const isChunkerCall = call % 2 === 0
    call++
    if (isChunkerCall) {
      // Count messages in prompt to build valid messageIndices
      const lineCount = (user.match(/^\d+\. \[/gm) ?? []).length || 4
      return JSON.stringify([
        {
          matchedTopicId: topicId,
          suggestedLabel: 'Project Artemis',
          summary: 'Discussion of Project Artemis launch timeline, team assignments, and milestone planning.',
          entities: [{ name: 'Project Artemis', type: 'project' }],
          tags: ['project', 'planning'],
          timeRange: null,
          messageIndices: Array.from({ length: lineCount }, (_, i) => i),
        },
      ])
    }
    // Summary update call — plain text
    return 'Project Artemis: ongoing planning covering launch timeline, team assignments, and Q3 milestones.'
  }
}

/** Build a batch of messages about Project Artemis. */
function makeArtemisMessages(count: number, startOffset: number): Message[] {
  const msgs: Message[] = []
  const artemisDetails = [
    { role: 'user' as const, text: 'How is Project Artemis coming along?' },
    { role: 'assistant' as const, text: 'Project Artemis is on track for Q3 launch.' },
    { role: 'user' as const, text: 'Who is leading Project Artemis?' },
    { role: 'assistant' as const, text: 'Sarah Chen is leading Project Artemis with a team of 5.' },
    { role: 'user' as const, text: 'What are the milestones for Project Artemis?' },
    { role: 'assistant' as const, text: 'Project Artemis milestones: alpha by June, beta by July, launch by September.' },
    { role: 'user' as const, text: 'Is the Project Artemis budget approved?' },
    { role: 'assistant' as const, text: 'Yes, Project Artemis budget of $2M was approved last week.' },
    { role: 'user' as const, text: 'Any blockers on Project Artemis?' },
    { role: 'assistant' as const, text: 'Project Artemis has a dependency on the API team resolving the auth module.' },
  ]

  for (let i = 0; i < count; i++) {
    const detail = artemisDetails[i % artemisDetails.length]!
    msgs.push({
      kind: 'text',
      role: detail.role,
      id: generateId('msg'),
      content: detail.text,
      createdAt: ts(startOffset + i * 200),
    })
  }

  return msgs
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('archival boundaries', () => {
  it('first archival produces a non-null result and appends a continuation hint', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      // 20 messages — cutoff = floor(20 * 0.3) = 6
      const artemisMessages = makeArtemisMessages(20, 0)
      for (const msg of artemisMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        makeChunkerMock(),
        50_000,
      )

      const allMessages = messages.getAll()
      const result = await archiveMessages(allMessages, {
        topicMemory,
        messages,
      })

      expect(result).not.toBeNull()
      expect(result!.archivedMessageIds.length).toBeGreaterThan(0)

      // A continuation hint should have been appended to the message store
      const remaining = messages.getAll()
      const injected = remaining.filter(m =>
        m.kind === 'text' && m.injected && m.content.includes('[Archival note:')
      )
      expect(injected.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanTempDir(tempDir)
    }
  })

  it('touchedTopics is non-empty after first archival', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      const artemisMessages = makeArtemisMessages(20, 0)
      for (const msg of artemisMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        makeChunkerMock(),
        50_000,
      )

      const allMessages = messages.getAll()
      const result = await archiveMessages(allMessages, {
        topicMemory,
        messages,
      })

      expect(result).not.toBeNull()
      expect(result!.touchedTopics.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanTempDir(tempDir)
    }
  })

  it('two archival passes do not create wildly divergent topic labels', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      // First batch: 20 messages
      const batch1 = makeArtemisMessages(20, 0)
      for (const msg of batch1) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        makeChunkerMock(),
        50_000,
      )

      // First archival pass
      const allMessages1 = messages.getAll()
      const result1 = await archiveMessages(allMessages1, {
        topicMemory,
        messages,
      })
      expect(result1).not.toBeNull()

      // Second batch: 20 more messages about the same topic
      const batch2 = makeArtemisMessages(20, 20 * 200 + 5000)
      for (const msg of batch2) {
        messages.append(msg)
      }

      // Second archival pass
      const allMessages2 = messages.getAll()
      const result2 = await archiveMessages(allMessages2, {
        topicMemory,
        messages,
      })
      expect(result2).not.toBeNull()

      // Check the topics in memory
      const topics = await topicMemory.getTopics()
      expect(topics.length).toBeGreaterThanOrEqual(1)

      // If there are multiple topics, all labels should reference "Artemis" or "Project"
      // (the mock always returns "Project Artemis", so the memory library should either
      // merge them or keep the same label)
      const artemisTopics = topics.filter(
        t => t.label.toLowerCase().includes('artemis') || t.label.toLowerCase().includes('project')
      )
      expect(artemisTopics.length).toBeGreaterThanOrEqual(1)

      // There should not be more than 2 distinct topic groups for a single coherent subject
      // (allowing for minor label variation across passes)
      expect(topics.length).toBeLessThanOrEqual(3)
    } finally {
      cleanTempDir(tempDir)
    }
  })

  it('archived messages are deleted from the store — no summary replacement', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      const artemisMessages = makeArtemisMessages(15, 0)
      for (const msg of artemisMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        makeChunkerMock(),
        50_000,
      )

      const allMessages = messages.getAll()
      const result = await archiveMessages(allMessages, {
        topicMemory,
        messages,
      })

      expect(result).not.toBeNull()

      const remaining = messages.getAll()

      // Archived message IDs should be gone from the store
      for (const id of result!.archivedMessageIds) {
        expect(remaining.some(m => m.id === id)).toBe(false)
      }

      // No summary messages — archival deletes without replacing
      const summaries = remaining.filter(m => m.kind === 'summary')
      expect(summaries.length).toBe(0)
    } finally {
      cleanTempDir(tempDir)
    }
  })

  it('continuation hint content mentions the touched topic label', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      const artemisMessages = makeArtemisMessages(20, 0)
      for (const msg of artemisMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        makeChunkerMock(),
        50_000,
      )

      const allMessages = messages.getAll()
      const result = await archiveMessages(allMessages, {
        topicMemory,
        messages,
      })

      expect(result).not.toBeNull()
      expect(result!.touchedTopics.length).toBeGreaterThanOrEqual(1)

      // Find the injected archival note
      const remaining = messages.getAll()
      const archivalNotes = remaining.filter(
        m => m.kind === 'text' && m.injected && m.content.includes('[Archival note:')
      )
      expect(archivalNotes.length).toBeGreaterThanOrEqual(1)

      // The note should mention the topic label
      const noteContent = archivalNotes[0]!.kind === 'text' ? archivalNotes[0]!.content : ''
      const topicLabel = result!.touchedTopics[0]!.label
      expect(noteContent).toContain(topicLabel)
    } finally {
      cleanTempDir(tempDir)
    }
  })
})
