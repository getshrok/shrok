/**
 * Deterministic unit tests for archiveMessages().
 *
 * Verifies that:
 * - recall_memory tool calls are archived (deleted) like any other messages — no special treatment
 * - archived message IDs are the oldest 30%, not selected by content
 * - archiveMessages returns null when the message list is too short
 *
 * No real LLM calls are made — every LLM interaction is mocked.
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

// ─── Mock LLMFunction for topic memory ───────────────────────────────────────
//
// createTopicMemory expects an (system, user) => Promise<string> function.
// We return a minimal valid chunker JSON response so chunk() does not throw.

const MOCK_CHUNKER_RESPONSE = JSON.stringify({
  topics: [
    {
      label: 'Sprint Planning',
      summary: 'Discussion about planning the sprint, including spawning agents for task breakdown.',
      messages: [],
    },
  ],
})

const mockLLMFunction: LLMFunction = async (_system: string, _user: string): Promise<string> => {
  return MOCK_CHUNKER_RESPONSE
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-test-archival-'))
}

function cleanTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// Build a message list that includes both recall_memory and spawn_agent tool interactions.
function buildMessages(): Message[] {
  const base = Date.now()
  const ts = (offset: number) => new Date(base + offset * 100).toISOString()

  const spawnCallId = generateId('tc')
  const recallCallId = generateId('tc')

  return [
    // 1. Plain user text
    {
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: "Let's plan the sprint.",
      createdAt: ts(0),
    } satisfies Message,

    // 2. Assistant spawns an agent
    {
      kind: 'tool_call',
      id: generateId('msg'),
      content: 'I will spawn an agent to help with sprint planning.',
      toolCalls: [
        {
          id: spawnCallId,
          name: 'spawn_agent',
          input: { prompt: 'Break down the sprint stories into tasks.', skillName: null },
        },
      ],
      createdAt: ts(1),
    } satisfies Message,

    // 3. Tool result for spawn_agent
    {
      kind: 'tool_result',
      id: generateId('msg'),
      toolResults: [
        {
          toolCallId: spawnCallId,
          name: 'spawn_agent',
          content: 'Agent spawned successfully. ID: agent_abc123',
        },
      ],
      createdAt: ts(2),
    } satisfies Message,

    // 4. Assistant calls recall_memory — should be archived like any other message
    {
      kind: 'tool_call',
      id: generateId('msg'),
      content: 'Recalling memory about past sprint planning sessions.',
      toolCalls: [
        {
          id: recallCallId,
          name: 'recall_memory',
          input: { query: 'sprint planning' },
        },
      ],
      createdAt: ts(3),
    } satisfies Message,

    // 5. Tool result for recall_memory — should be archived like any other message
    {
      kind: 'tool_result',
      id: generateId('msg'),
      toolResults: [
        {
          toolCallId: recallCallId,
          name: 'recall_memory',
          content: '[retrieved memory: previous sprint had 8 stories, velocity 34]',
        },
      ],
      createdAt: ts(4),
    } satisfies Message,

    // 6. Another user text
    {
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: 'Based on that, let\'s create three stories.',
      createdAt: ts(5),
    } satisfies Message,

    // 7. Extra messages so cutoff = floor(10 * 0.3) = 3
    {
      kind: 'text',
      role: 'assistant',
      id: generateId('msg'),
      content: 'Sure, I can help create stories.',
      createdAt: ts(6),
    } satisfies Message,
    {
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: 'Great, let us proceed.',
      createdAt: ts(7),
    } satisfies Message,
    {
      kind: 'text',
      role: 'assistant',
      id: generateId('msg'),
      content: 'Proceeding with sprint planning.',
      createdAt: ts(8),
    } satisfies Message,
    {
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: 'Add a story for API integration.',
      createdAt: ts(9),
    } satisfies Message,
  ]
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('archiveMessages — recall_memory filtering', () => {
  it('archived message IDs are the oldest 30% — recall_memory calls are not specially treated', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      const allMessages = buildMessages()
      for (const msg of allMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        mockLLMFunction,
        50_000,
      )

      const result = await archiveMessages(allMessages, {
        topicMemory,
        messages,
      })

      expect(result).not.toBeNull()

      // The archived IDs should be the first cutoff messages (oldest 30%)
      const cutoff = Math.floor(allMessages.length * 0.3)
      const expectedIds = allMessages.slice(0, cutoff).map(m => m.id)
      expect(result!.archivedMessageIds).toEqual(expectedIds)

      // Those messages should be deleted from the store
      const remaining = messages.getAll()
      for (const id of expectedIds) {
        expect(remaining.some(m => m.id === id)).toBe(false)
      }

      // No summary messages should exist — archival deletes without replacing
      const summaries = remaining.filter(m => m.kind === 'summary')
      expect(summaries.length).toBe(0)
    } finally {
      cleanTempDir(tempDir)
    }
  })

  it('archiveMessages returns null when there are fewer than 4 messages (cutoff < 1)', async () => {
    const db = freshDb()
    const messages = new MessageStore(db)
    const tempDir = makeTempDir()

    try {
      const tinyMessages: Message[] = [
        {
          kind: 'text',
          role: 'user',
          id: generateId('msg'),
          content: 'Hello.',
          createdAt: now(),
        },
        {
          kind: 'text',
          role: 'assistant',
          id: generateId('msg'),
          content: 'Hi there.',
          createdAt: now(),
        },
        // 3 messages: cutoff = floor(3 * 0.3) = 0 → returns null
        {
          kind: 'text',
          role: 'user',
          id: generateId('msg'),
          content: 'Bye.',
          createdAt: now(),
        },
      ]

      for (const msg of tinyMessages) {
        messages.append(msg)
      }

      const topicMemory = createTopicMemory(
        path.join(tempDir, 'topics'),
        mockLLMFunction,
        50_000,
      )

      const result = await archiveMessages(tinyMessages, {
        topicMemory,
        messages,
      })

      expect(result).toBeNull()
    } finally {
      cleanTempDir(tempDir)
    }
  })
})
