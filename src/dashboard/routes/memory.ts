import { Router } from 'express'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { requireAuth } from '../auth.js'
import type { Memory } from '../../memory/index.js'
import type { ChunkRecord } from 'infinitecontextwindow'

function safeTopicId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(id)
}

function readChunks(storagePath: string, topicId: string): ChunkRecord[] {
  const filePath = path.join(storagePath, 'topics', topicId, 'history.jsonl')
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const chunks: ChunkRecord[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { chunks.push(JSON.parse(trimmed) as ChunkRecord) } catch { /* skip malformed */ }
  }
  return chunks
}

interface GraphRelation {
  source: string; relation: string; target: string
  topicIds: string[]; chunkIds: string[]
  firstSeen: string; lastSeen: string
}

function readGraph(storagePath: string): Record<string, GraphRelation[]> {
  try {
    const raw = fs.readFileSync(path.join(storagePath, 'graph.json'), 'utf8')
    return (JSON.parse(raw) as { entities: Record<string, GraphRelation[]> }).entities
  } catch { return {} }
}

export function createMemoryRouter(topicMemory: Memory, workspacePath: string): Router {
  const router = Router()
  const storagePath = path.join(workspacePath.replace(/^~/, os.homedir()), 'topics')

  router.get('/entities/:entityName/relations', requireAuth, (req: Request, res: Response): void => {
    const key = (req.params['entityName'] as string).trim().toLowerCase()
    const graph = readGraph(storagePath)
    res.json({ entity: key, relations: graph[key] ?? [] })
  })

  router.get('/', requireAuth, (_req: Request, res: Response): void => {
    void topicMemory.getTopics().then(topics => {
      const sorted = [...topics].sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))
      res.json({ topics: sorted })
    }).catch(() => res.status(500).json({ error: 'Failed to load topics' }))
  })

  router.get('/:topicId', requireAuth, (req: Request, res: Response): void => {
    const topicId = req.params['topicId'] as string
    if (!safeTopicId(topicId)) { res.status(400).json({ error: 'Invalid topic ID' }); return }

    void topicMemory.getTopics().then(topics => {
      const topic = topics.find(t => t.topicId === topicId)
      if (!topic) { res.status(404).json({ error: 'Topic not found' }); return }
      const chunks = readChunks(storagePath, topicId)
      res.json({ topic, chunks })
    }).catch(() => res.status(500).json({ error: 'Failed to load topic' }))
  })

  router.delete('/:topicId', requireAuth, (req: Request, res: Response): void => {
    const topicId = req.params['topicId'] as string
    if (!safeTopicId(topicId)) { res.status(400).json({ error: 'Invalid topic ID' }); return }

    void topicMemory.deleteTopic(topicId)
      .then(() => res.json({ ok: true }))
      .catch(() => res.status(500).json({ error: 'Failed to delete topic' }))
  })

  return router
}
