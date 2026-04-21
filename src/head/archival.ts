/**
 * Core archival logic, extracted from ActivationLoop so it can be
 * called from both the live activation loop and the eval framework.
 *
 * Lock acquisition/release stays in the caller (ActivationLoop.maybeArchive).
 */

import * as fs from 'node:fs/promises'
import { log } from '../logger.js'
import type { Message } from '../types/core.js'
import type { Memory } from '../memory/index.js'
import { toMemoryMessages } from '../memory/index.js'
import type { MessageStore } from '../db/messages.js'
import type { Topic } from '../icw/index.js'
import { generateId, now } from '../llm/util.js'

export interface ArchivalDeps {
  topicMemory: Memory
  messages: MessageStore
}

export interface ArchivalResult {
  touchedTopics: Topic[]
  archivedMessageIds: string[]
}

export async function archiveMessages(
  allMessages: Message[],
  deps: ArchivalDeps,
  fraction = 0.3,
): Promise<ArchivalResult | null> {
  // Snapshot oldest N% of messages (default 30%)
  const cutoff = Math.floor(allMessages.length * fraction)
  if (cutoff < 1) return null

  const toArchive = allMessages.slice(0, cutoff)
  if (toArchive.length === 0) return null

  // Archive messages into topic memory before deletion
  const archivalStartTime = now()
  await deps.topicMemory.chunk(toMemoryMessages(toArchive))

  // Identify topics touched during this archival pass
  const touchedTopics = (await deps.topicMemory.getTopics())
    .filter(t => t.lastUpdatedAt >= archivalStartTime)

  // Inject a continuation hint so the next archival batch knows which topics were active
  if (touchedTopics.length > 0) {
    const labels = touchedTopics.map(t => `"${t.label}"`).join(', ')
    deps.messages.append({
      kind: 'text',
      role: 'user',
      id: generateId('msg'),
      content: `[Archival note: the preceding conversation was discussing the following topics: ${labels}]`,
      injected: true,
      createdAt: now(),
    })
  }

  // Delete media files for archived messages — metadata is preserved in topic
  // memory as text, so the files on disk are no longer needed.
  for (const msg of toArchive) {
    if (msg.kind === 'text' && msg.attachments) {
      for (const att of msg.attachments) {
        if (att.path) await fs.unlink(att.path).catch(() => {})
      }
    }
  }

  // Delete the archived messages — topic memory is the source of truth for
  // this content now. No summary is written back to the live store; the
  // archival note above is the only in-context trace of the archived content.
  const ids = toArchive.map(m => m.id)
  deps.messages.deleteByIds(ids)
  log.info(`[archival] Archived ${ids.length} messages.`)

  return { touchedTopics, archivedMessageIds: ids }
}
