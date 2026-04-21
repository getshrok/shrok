import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { MemoryTopic, MemoryChunk, MemoryEntity, MemoryRelation } from '../types/api'
import { formatInTz, useConfigTimezone } from '../lib/formatTime'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(iso: string, tz: string): string {
  return formatInTz(iso, tz, { includeZone: false })
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const ENTITY_COLORS: Record<MemoryEntity['type'], string> = {
  person:       'bg-blue-900/50 text-blue-300',
  project:      'bg-yellow-900/50 text-yellow-300',
  place:        'bg-green-900/50 text-green-300',
  organization: 'bg-purple-900/50 text-purple-300',
  other:        'bg-zinc-800 text-zinc-400',
}

function entityKey(e: MemoryEntity): string {
  return e.name.toLowerCase()
}

function EntityBadge({ entity, onClick }: { entity: MemoryEntity; onClick?: () => void }) {
  return (
    <span
      onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${ENTITY_COLORS[entity.type]} ${onClick ? 'cursor-pointer hover:ring-1 hover:ring-zinc-600' : ''}`}
    >
      {entity.name}
    </span>
  )
}

// ─── Relations panel ─────────────────────────────────────────────────────────

function RelationsPanel({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['entity-relations', entity.name],
    queryFn: () => api.memory.entityRelations(entity.name),
    staleTime: 60_000,
  })
  const relations = data?.relations ?? []

  return (
    <div className="border border-zinc-800 rounded-lg px-4 py-3 mb-4 bg-zinc-900/50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <EntityBadge entity={entity} />
          <span className="text-xs text-zinc-400">relations</span>
        </div>
        <button onClick={onClose} className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">clear</button>
      </div>
      {isLoading && <div className="text-xs text-zinc-500">Loading…</div>}
      {relations.length === 0 && !isLoading && <div className="text-xs text-zinc-600">No relations found</div>}
      {relations.length > 0 && (
        <div className="space-y-1">
          {relations.map((r, i) => <RelationRow key={i} relation={r} />)}
        </div>
      )}
    </div>
  )
}

function RelationRow({ relation: r }: { relation: MemoryRelation }) {
  const tz = useConfigTimezone()
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-300">{r.source}</span>
      <span className="text-zinc-600">→</span>
      <span className="text-zinc-400 italic">{r.relation}</span>
      <span className="text-zinc-600">→</span>
      <span className="text-zinc-300">{r.target}</span>
      <span className="text-zinc-700 ml-auto text-[11px]">{formatTs(r.lastSeen, tz)}</span>
    </div>
  )
}

// ─── Chunk detail ─────────────────────────────────────────────────────────────

function ChunkRow({ chunk, onEntityClick }: { chunk: MemoryChunk; onEntityClick: (e: MemoryEntity) => void }) {
  const [showMessages, setShowMessages] = useState(false)
  const tz = useConfigTimezone()
  const isArchival = !!chunk.archived || !!chunk.archivalLevel

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-zinc-900/50">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-zinc-300 leading-relaxed flex-1">{chunk.summary}</p>
          <div className="flex items-center gap-1.5 shrink-0">
            {isArchival && (
              <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                chunk.archivalLevel === 'heavy' ? 'bg-red-900/50 text-red-400' : 'bg-orange-900/50 text-orange-400'
              }`}>
                {chunk.archivalLevel ?? 'archived'}
              </span>
            )}
            {chunk.timeRange && (
              <span className="text-[11px] text-zinc-500">
                {formatTs(chunk.timeRange.start, tz)}–{formatTs(chunk.timeRange.end, tz)}
              </span>
            )}
            <span className="text-[11px] text-zinc-700">{formatTs(chunk.appendedAt, tz)}</span>
          </div>
        </div>

        {chunk.entities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {chunk.entities.map(e => <EntityBadge key={`${e.type}-${e.name}`} entity={e} onClick={() => onEntityClick(e)} />)}
          </div>
        )}

        {chunk.messages.length > 0 && (
          <button
            onClick={() => setShowMessages(v => !v)}
            className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors"
          >
            {showMessages ? '▲ hide messages' : `▼ ${chunk.messages.length} message${chunk.messages.length !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      {showMessages && (
        <div className="border-t border-zinc-800 divide-y divide-zinc-800/60">
          {chunk.messages.map((m, i) => (
            <div key={i} className={`px-4 py-2.5 text-xs ${m.role === 'user' ? 'bg-zinc-900' : 'bg-zinc-950'}`}>
              <span className={`font-medium mr-2 ${m.role === 'user' ? 'text-blue-400' : 'text-zinc-400'}`}>
                {m.role}
              </span>
              <span className="text-zinc-400 whitespace-pre-wrap">{m.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Topic row ────────────────────────────────────────────────────────────────

function TopicRow({ topic, topics, onDelete, onEntityClick }: {
  topic: MemoryTopic
  topics: MemoryTopic[]
  onDelete: (id: string) => void
  onEntityClick: (e: MemoryEntity) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const tz = useConfigTimezone()

  const chunksQuery = useQuery({
    queryKey: ['memory-topic', topic.topicId],
    queryFn: () => api.memory.topic(topic.topicId),
    enabled: expanded,
    staleTime: 30_000,
  })

  const chunks = chunksQuery.data?.chunks ?? []
  const sortedChunks = [...chunks].sort((a, b) => b.appendedAt.localeCompare(a.appendedAt))

  const relatedTopics = useMemo(() => {
    if (!expanded) return []
    const entityNames = new Set(topic.entities.map(entityKey))
    return topics
      .filter(t => t.topicId !== topic.topicId && t.entities.some(e => entityNames.has(entityKey(e))))
      .slice(0, 5)
  }, [expanded, topic, topics])

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-3.5 hover:bg-zinc-800/30 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-zinc-100">{topic.label}</span>
              <span className="text-[11px] text-zinc-500">{topic.chunkCount} chunk{topic.chunkCount !== 1 ? 's' : ''}</span>
              <span className="text-[11px] text-zinc-700">{formatTokens(topic.estimatedTokens)} tok</span>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">{topic.summary}</p>
            {topic.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {topic.tags.map(tag => (
                  <span key={tag} className="px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded text-[11px]">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0 pt-0.5">
            <span className="text-[11px] text-zinc-500">{formatTs(topic.lastUpdatedAt, tz)}</span>
            <button
              onClick={e => { e.stopPropagation(); if (window.confirm(`Delete topic "${topic.label}"?`)) onDelete(topic.topicId) }}
              className="text-zinc-700 hover:text-red-500 transition-colors px-1"
              title="Delete topic"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clipRule="evenodd" />
              </svg>
            </button>
            <span className="text-zinc-700 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
      </button>

      {/* Entities row */}
      {topic.entities.length > 0 && !expanded && (
        <div className="px-4 pb-3 flex flex-wrap gap-1">
          {topic.entities.map(e => <EntityBadge key={`${e.type}-${e.name}`} entity={e} onClick={() => onEntityClick(e)} />)}
        </div>
      )}

      {/* Expanded chunks */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-2 bg-zinc-950/50">
          {chunksQuery.isLoading && (
            <div className="text-xs text-zinc-500 py-2">Loading…</div>
          )}
          {sortedChunks.map(chunk => (
            <ChunkRow key={chunk.chunkId} chunk={chunk} onEntityClick={onEntityClick} />
          ))}
          {!chunksQuery.isLoading && sortedChunks.length === 0 && (
            <div className="text-xs text-zinc-500 py-2">No chunks</div>
          )}
        </div>
      )}

      {/* Related topics */}
      {expanded && relatedTopics.length > 0 && (
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="text-[11px] text-zinc-500 mb-2 font-medium">Related topics</div>
          <div className="space-y-1.5">
            {relatedTopics.map(rt => {
              const shared = rt.entities.filter(e => topic.entities.some(te => entityKey(te) === entityKey(e)))
              return (
                <div key={rt.topicId} className="flex items-center gap-2 text-xs">
                  <span className="text-zinc-300 truncate">{rt.label}</span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-500">{formatTs(rt.lastUpdatedAt, tz)}</span>
                  <div className="flex gap-1 ml-auto shrink-0">
                    {shared.map(e => <EntityBadge key={`${e.type}-${e.name}`} entity={e} onClick={() => onEntityClick(e)} />)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Entity row (entities view) ──────────────────────────────────────────────

function EntityRow({ entity, topicCount, linkedTopics, onEntityClick }: {
  entity: MemoryEntity
  topicCount: number
  linkedTopics: MemoryTopic[]
  onEntityClick: (e: MemoryEntity) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const tz = useConfigTimezone()

  const relationsQuery = useQuery({
    queryKey: ['entity-relations', entity.name],
    queryFn: () => api.memory.entityRelations(entity.name),
    enabled: expanded,
    staleTime: 60_000,
  })

  const relations = relationsQuery.data?.relations ?? []

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(v => !v)} className="w-full text-left px-4 py-2.5 hover:bg-zinc-800/30 transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <EntityBadge entity={entity} />
            <span className="text-[11px] text-zinc-500">{topicCount} topic{topicCount !== 1 ? 's' : ''}</span>
          </div>
          <span className="text-zinc-700 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3 bg-zinc-950/50">
          {/* Relations */}
          {relationsQuery.isLoading && <div className="text-xs text-zinc-500">Loading relations…</div>}
          {relations.length > 0 && (
            <div>
              <div className="text-[11px] text-zinc-500 mb-1.5 font-medium">Relations</div>
              <div className="space-y-1">
                {relations.map((r, i) => <RelationRow key={i} relation={r} />)}
              </div>
            </div>
          )}
          {!relationsQuery.isLoading && relations.length === 0 && (
            <div className="text-xs text-zinc-600">No relations found</div>
          )}

          {/* Linked topics */}
          {linkedTopics.length > 0 && (
            <div>
              <div className="text-[11px] text-zinc-500 mb-1.5 font-medium">Topics</div>
              <div className="space-y-1">
                {linkedTopics.map(t => (
                  <div key={t.topicId} className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-300 truncate">{t.label}</span>
                    <span className="text-zinc-700 ml-auto shrink-0">·</span>
                    <span className="text-zinc-500 shrink-0">{formatTs(t.lastUpdatedAt, tz)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Entity type labels ──────────────────────────────────────────────────────

const TYPE_LABELS: Record<MemoryEntity['type'], string> = {
  person: 'People',
  project: 'Projects',
  place: 'Places',
  organization: 'Organizations',
  other: 'Other',
}

const TYPE_ORDER: MemoryEntity['type'][] = ['person', 'project', 'place', 'organization', 'other']

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'topics' | 'entities'>('topics')
  const [selectedEntity, setSelectedEntity] = useState<MemoryEntity | null>(null)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['memory'],
    queryFn: api.memory.topics,
    refetchInterval: 10_000,
  })

  const deleteMutation = useMutation({
    mutationFn: api.memory.deleteTopic,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memory'] }),
  })

  const topics = data?.topics ?? []

  // ── Entity index (derived from topics) ──
  const entityIndex = useMemo(() => {
    const map = new Map<string, { entity: MemoryEntity; topicIds: Set<string> }>()
    for (const t of topics) {
      for (const e of t.entities) {
        const key = entityKey(e)
        if (!map.has(key)) map.set(key, { entity: e, topicIds: new Set() })
        map.get(key)!.topicIds.add(t.topicId)
      }
    }
    return map
  }, [topics])

  const entitiesByType = useMemo(() => {
    const groups: Partial<Record<MemoryEntity['type'], Array<{ entity: MemoryEntity; topicCount: number }>>> = {}
    for (const [, { entity, topicIds }] of entityIndex) {
      const type = entity.type
      if (!groups[type]) groups[type] = []
      groups[type]!.push({ entity, topicCount: topicIds.size })
    }
    for (const arr of Object.values(groups)) arr!.sort((a, b) => a.entity.name.localeCompare(b.entity.name))
    return groups
  }, [entityIndex])

  // ── Filtering ──
  const filtered = useMemo(() => {
    let result = topics
    if (selectedEntity) {
      const sel = entityKey(selectedEntity)
      result = result.filter(t => t.entities.some(e => entityKey(e) === sel))
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(t =>
        t.label.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.toLowerCase().includes(q))
      )
    }
    return result
  }, [topics, selectedEntity, search])

  const filteredEntities = useMemo(() => {
    if (!search.trim()) return entitiesByType
    const q = search.toLowerCase()
    const result: Partial<Record<MemoryEntity['type'], Array<{ entity: MemoryEntity; topicCount: number }>>> = {}
    for (const [type, items] of Object.entries(entitiesByType)) {
      const matched = items!.filter(i => i.entity.name.toLowerCase().includes(q))
      if (matched.length > 0) result[type as MemoryEntity['type']] = matched
    }
    return result
  }, [entitiesByType, search])

  const totalTokens = topics.reduce((s, t) => s + t.estimatedTokens, 0)

  const handleEntityClick = (e: MemoryEntity) => {
    setSelectedEntity(e)
    setView('topics')
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading…</div>
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
        <div className="flex items-baseline justify-between mb-3">
          <h1 className="text-lg font-semibold text-zinc-100">Memory</h1>
          <div className="text-xs text-zinc-500">
            {topics.length} topic{topics.length !== 1 ? 's' : ''} · {formatTokens(totalTokens)} tokens · {entityIndex.size} entit{entityIndex.size !== 1 ? 'ies' : 'y'}
          </div>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div className="flex gap-1">
            <button
              onClick={() => { setView('topics'); setSelectedEntity(null) }}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${view === 'topics' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-400'}`}
            >Topics</button>
            <button
              onClick={() => { setView('entities'); setSelectedEntity(null) }}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${view === 'entities' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-400'}`}
            >Entities</button>
          </div>
        </div>
        <input
          type="text"
          placeholder={view === 'topics' ? 'Search topics…' : 'Search entities…'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {/* Topics view */}
        {view === 'topics' && (
          <>
            {selectedEntity && (
              <RelationsPanel entity={selectedEntity} onClose={() => setSelectedEntity(null)} />
            )}
            {filtered.length === 0 && (
              <div className="text-sm text-zinc-500 py-8 text-center">
                {search || selectedEntity ? 'No topics match' : 'No topics yet'}
              </div>
            )}
            {filtered.map(topic => (
              <TopicRow
                key={topic.topicId}
                topic={topic}
                topics={topics}
                onDelete={id => deleteMutation.mutate(id)}
                onEntityClick={handleEntityClick}
              />
            ))}
          </>
        )}

        {/* Entities view */}
        {view === 'entities' && (
          <>
            {Object.keys(filteredEntities).length === 0 && (
              <div className="text-sm text-zinc-500 py-8 text-center">
                {search ? 'No entities match' : 'No entities yet'}
              </div>
            )}
            {TYPE_ORDER.filter(type => filteredEntities[type]).map(type => (
              <div key={type}>
                <div className="text-[11px] text-zinc-500 font-medium mb-2 mt-3 first:mt-0">{TYPE_LABELS[type]}</div>
                <div className="space-y-1.5">
                  {filteredEntities[type]!.map(({ entity, topicCount }) => (
                    <EntityRow
                      key={entityKey(entity)}
                      entity={entity}
                      topicCount={topicCount}
                      linkedTopics={topics.filter(t => t.entities.some(e => entityKey(e) === entityKey(entity)))}
                      onEntityClick={handleEntityClick}
                    />
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
