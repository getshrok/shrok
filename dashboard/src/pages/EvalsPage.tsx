import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { EvalScenarioInfo, EvalResult, EvalResultDetail } from '../types/api'
import { formatInTz, useConfigTimezone } from '../lib/formatTime'

// ─── Types ────────────────────────────────────────────────────────────────────

type RunState = 'idle' | 'running' | 'done'

const CATEGORY_ORDER = ['memory', 'identity', 'routing', 'reliability', 'stress']
const CATEGORY_LABEL: Record<string, string> = {
  memory: 'Memory',
  identity: 'Identity',
  routing: 'Routing',
  reliability: 'Reliability',
  stress: 'Stress',
}

// ─── Cost formatting ──────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `~$${usd.toFixed(2)}`
  return `~$${usd.toFixed(1)}`
}

// ─── Score display ─────────────────────────────────────────────────────────────

/** Score to HSL color: 0.0 = red (0°), 0.5 = yellow (45°), 1.0 = green (120°) */
function scoreColor(score: number): string {
  const hue = Math.round(score * 120) // 0→0° (red), 0.5→60° (yellow), 1.0→120° (green)
  return `hsl(${hue}, 70%, 45%)`
}

function ScoreDot({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="w-2 h-2 rounded-full bg-zinc-700 shrink-0 inline-block" />
  return <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: scoreColor(pass ? 1 : 0) }} />
}

function SidebarScoreBar({ result }: { result: { pass: boolean; minScore: number | null } | null }) {
  if (!result) return <div className="w-12 h-1.5 rounded-full bg-zinc-800 shrink-0" />
  const score = result.minScore
  if (score === null) {
    return <div className="w-12 h-1.5 rounded-full shrink-0" style={{ backgroundColor: scoreColor(result.pass ? 1 : 0) }} />
  }
  return (
    <div className="w-12 h-1.5 bg-zinc-800 rounded-full overflow-hidden shrink-0">
      <div className="h-full rounded-full" style={{ width: `${score * 100}%`, backgroundColor: scoreColor(score) }} />
    </div>
  )
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${score * 100}%`, backgroundColor: scoreColor(score) }} />
      </div>
      <span className="text-[11px] text-zinc-500 w-7 text-right">{score.toFixed(2)}</span>
    </div>
  )
}

// ─── Narrative renderer ───────────────────────────────────────────────────────

function NarrativeBlock({ text }: { text: string }) {
  // Split on newline-bullet pattern (new format) or fall back to sentence splitting
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  const isBulleted = lines.some(l => l.startsWith('-') || l.startsWith('•'))
  const bullets = isBulleted
    ? lines.map(l => l.replace(/^[-•]\s*/, ''))
    : text.match(/[^.!?]+[.!?]+/g)?.map(s => s.trim()).filter(Boolean) ?? [text]

  return (
    <ul className="space-y-1.5 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
      {bullets.map((b, i) => (
        <li key={i} className="flex gap-2 text-sm text-zinc-300 leading-relaxed">
          <span className="text-zinc-500 shrink-0 mt-0.5">·</span>
          <span>{b}</span>
        </li>
      ))}
    </ul>
  )
}

// ─── Turns type guard ─────────────────────────────────────────────────────────

function isEvalTurns(output: unknown): output is { turns: Array<{ query: string; response: string }> } {
  return (
    typeof output === 'object' && output !== null &&
    Array.isArray((output as { turns?: unknown }).turns) &&
    (output as { turns: unknown[] }).turns.length > 0 &&
    typeof (output as { turns: Array<{ query?: unknown }> }).turns[0]?.query === 'string'
  )
}

// ─── Timeline builder ─────────────────────────────────────────────────────────

interface TimelineEvent {
  time: string     // HH:MM:SS
  type: 'head' | 'agent' | 'steward' | 'tool' | 'error' | 'info'
  label: string    // short tag like HEAD, AGENT, STEWARD
  text: string     // the event content
  sortKey: string  // full timestamp for sorting
}

/** Extract memory blocks from head traces. The memory block starts with "## Memory Context" in the SYSTEM section. */
function extractMemoryBlocks(traces: Record<string, string>): Array<{ filename: string; block: string }> {
  const results: Array<{ filename: string; block: string }> = []
  for (const [filename, content] of Object.entries(traces)) {
    if (!filename.startsWith('head-')) continue
    // The system prompt is between "SYSTEM: " and "TOOLS:" or "HISTORY:"
    const systemMatch = content.match(/^SYSTEM: ([\s\S]*?)(?=\nTOOLS:|\nHISTORY:)/m)
    if (!systemMatch) continue
    const systemPrompt = systemMatch[1]!
    const memIdx = systemPrompt.indexOf('## Memory Context')
    if (memIdx === -1) continue
    results.push({ filename, block: systemPrompt.slice(memIdx) })
  }
  return results
}

function buildTimeline(traces: Record<string, string>): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const [filename, content] of Object.entries(traces)) {
    // Determine source type from filename
    const isHead = filename.startsWith('head-')
    const isAgent = filename.startsWith('agent-')
    const isSteward = filename.startsWith('steward-')

    // Extract header: TYPE ID TIMESTAMP [tier]
    const headerMatch = content.match(/^(?:HEAD|AGENT|STEWARD)\s+(\S+)\s+(\S+)\s+\[(\w+)\]/m)
    const entityId = headerMatch?.[1] ?? ''
    const baseTime = headerMatch?.[2] ?? ''
    const tier = headerMatch?.[3] ?? ''
    const timeShort = baseTime.slice(11, 19) // HH:MM:SS
    // Short agent tag: last 7 chars of ID for disambiguation
    const agentTag = entityId ? entityId.slice(-7) : ''

    if (isHead) {
      // Extract HISTORY section — show each message with its actual role, raw content, no reinterpretation
      const histSection = content.match(/HISTORY:.*?\n([\s\S]*?)(?=\n-- round 1)/)?.[1] ?? ''
      const histMsgs = [...histSection.matchAll(/\[(user|assistant)\]\s*([\s\S]*?)(?=\n\s*\[(?:user|assistant)\]|\n\s*←|\n\s*→|$)/g)]
      for (const hm of histMsgs) {
        const role = hm[1]!
        const raw = hm[2]!.trim()
        if (!raw) continue
        events.push({
          time: timeShort,
          type: role === 'user' ? 'info' : 'head',
          label: `[${role}]`,
          text: raw,
          sortKey: baseTime + '_0a',
        })
      }

      // Extract rounds
      const rounds = content.split(/^-- round \d+ --$/m).slice(1)
      for (let ri = 0; ri < rounds.length; ri++) {
        const round = rounds[ri]!
        // Tool calls
        const toolCalls = [...round.matchAll(/→ (\w+) ({.*?)$/gm)]
        for (const tc of toolCalls) {
          const name = tc[1]!
          events.push({ time: timeShort, type: 'tool', label: 'HEAD', text: `→ ${name} ${tc[2]!}`, sortKey: baseTime + `_${ri + 1}a` })
        }
        // Tool results
        const toolResults = [...round.matchAll(/← (\w+): ([\s\S]*?)(?=\n← |\n→ |\n-- round|\nRESPONSE:|\nSTOP:|$)/gm)]
        for (const tr of toolResults) {
          const isError = tr[2]!.startsWith('Error:')
          events.push({ time: timeShort, type: isError ? 'error' : 'tool', label: 'HEAD', text: `← ${tr[1]} ${tr[2]!}`, sortKey: baseTime + `_${ri + 1}b` })
        }
        // Response
        const respMatch = round.match(/^RESPONSE: ([\s\S]*?)(?=^TOOL CALLS:|^STOP:)/m)
          ?? round.match(/^RESPONSE: ([\s\S]*?)$/m)
        if (respMatch) {
          const resp = respMatch[1]!.trim()
          if (resp) {
            events.push({ time: timeShort, type: 'head', label: 'HEAD', text: resp, sortKey: baseTime + `_${ri + 1}c` })
          }
        }
      }

      // STOP line
      const stopMatch = content.match(/^STOP: (.+)$/m)
      if (stopMatch) {
        events.push({ time: timeShort, type: 'info', label: 'STOP', text: stopMatch[1]!, sortKey: baseTime + '_z' })
      }
    }

    if (isAgent) {
      const aLabel = agentTag ? `AGENT:${agentTag}` : 'AGENT'
      events.push({ time: timeShort, type: 'agent', label: aLabel, text: `started [${tier}]`, sortKey: baseTime + '_0' })

      // Extract tool calls from rounds
      const rounds = content.split(/^-- round \d+ --$/m).slice(1)
      for (let ri = 0; ri < rounds.length; ri++) {
        const round = rounds[ri]!
        const toolCalls = [...round.matchAll(/→ (\w+) ({.*?)$/gm)]
        for (const tc of toolCalls) {
          events.push({ time: timeShort, type: 'tool', label: aLabel, text: `→ ${tc[1]} ${tc[2]!}`, sortKey: baseTime + `_${ri + 1}a` })
        }
        const agentToolResults = [...round.matchAll(/← (\w+): ([\s\S]*?)(?=\n← |\n→ |\n-- round|\nRESPONSE:|\nSTOP:|$)/gm)]
        for (const tr of agentToolResults) {
          events.push({ time: timeShort, type: 'tool', label: aLabel, text: `← ${tr[1]} ${tr[2]!}`, sortKey: baseTime + `_${ri + 1}b` })
        }
        // Agent response (final)
        const respMatch = round.match(/^RESPONSE: ([\s\S]*?)(?=^STOP:)/m)
        if (respMatch) {
          events.push({ time: timeShort, type: 'agent', label: aLabel, text: `response: ${respMatch[1]!.trim()}`, sortKey: baseTime + `_${ri + 1}c` })
        }
      }

      const stopMatch = content.match(/^STOP: (.+)$/m)
      if (stopMatch) {
        events.push({ time: timeShort, type: 'agent', label: aLabel, text: `done: ${stopMatch[1]!}`, sortKey: baseTime + '_z' })
      }
    }

    if (isSteward) {
      const stewardType = filename.includes('stewardcomplet') ? 'completion'
        : filename.includes('stewardworksum') ? 'work-summary'
        : filename.includes('stewardrelay') ? 'relay'
        : filename.includes('stewardresume') ? 'resume'
        : 'steward'
      const respMatch = content.match(/^RESPONSE: ([\s\S]*?)(?=^STOP:)/m)
      const result = respMatch?.[1]?.trim() ?? ''
      events.push({ time: timeShort, type: 'steward', label: 'STEWARD', text: `${stewardType}: ${result}`, sortKey: baseTime + '_1' })
    }
  }

  return events.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
}

// ─── Result detail panel ───────────────────────────────────────────────────────

function ResultDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [tab, setTab] = useState<'summary' | 'walkthrough' | 'turns' | 'trace' | 'head-trace' | 'memory'>('summary')
  const tz = useConfigTimezone()
  const { data, isLoading } = useQuery({
    queryKey: ['eval-detail', id],
    queryFn: () => api.evals.detail(id),
    staleTime: Infinity,
  })

  if (isLoading || !data) {
    return <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">Loading…</div>
  }

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'walkthrough', label: 'Walkthrough' },
    ...(isEvalTurns(data.output) ? [{ id: 'turns', label: 'Turns' }] : []),
    ...(data.history.length > 0 ? [{ id: 'trace', label: 'Trace' }] : []),
    ...(Object.keys(data.traces ?? {}).length > 0 ? [{ id: 'head-trace', label: 'Timeline' }] : []),
    ...(extractMemoryBlocks(data.traces ?? {}).length > 0 ? [{ id: 'memory', label: 'Memory' }] : []),
  ] as const

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3 shrink-0">
        <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">← Back</button>
        <span className="text-sm font-medium text-zinc-100">{data.scenario}</span>
        <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${data.pass ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
          {data.pass ? 'PASS' : 'FAIL'}
        </span>
        <span className="text-[11px] text-zinc-500">{formatInTz(data.createdAt, tz, { style: 'full' })}</span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 px-5 shrink-0">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as 'summary' | 'walkthrough' | 'turns' | 'trace' | 'head-trace' | 'memory')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === t.id ? 'border-zinc-400 text-zinc-200' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
        {tab === 'summary' && (
          <div className="space-y-4">
            <div className="text-sm text-zinc-300 leading-relaxed">{data.overall}</div>
            <div className="space-y-2">
              {Object.entries(data.dimensions).map(([dim, { score, notes }]) => (
                <div key={dim} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-medium ${score >= 0.5 ? 'text-zinc-300' : 'text-red-400'}`}>{dim}</span>
                  </div>
                  <ScoreBar score={score} />
                  <p className="text-[11px] text-zinc-500 leading-snug">{notes}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'walkthrough' && (
          <NarrativeBlock text={data.narrative} />
        )}

        {tab === 'turns' && isEvalTurns(data.output) && (
          <div className="space-y-4">
            {data.output.turns.map((t, i) => (
              <div key={i} className="space-y-1">
                <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50">
                  <div className="px-3 py-1.5 border-b border-zinc-700/50 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Query {i + 1}
                  </div>
                  <pre className="px-3 py-2.5 text-zinc-300 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
                    {t.query}
                  </pre>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
                  <div className="px-3 py-1.5 border-b border-zinc-800 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    Response
                  </div>
                  <pre className="px-3 py-2.5 text-zinc-300 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
                    {t.response}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'trace' && (
          <div className="space-y-3">
            {data.history.map((msg, i) => (
              <div key={i} className={`rounded-lg border text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-zinc-800/50 border-zinc-700/50'
                  : 'bg-zinc-900/40 border-zinc-800'
              }`}>
                <div className={`px-3 py-1.5 border-b text-[11px] font-semibold uppercase tracking-wider ${
                  msg.role === 'user'
                    ? 'border-zinc-700/50 text-zinc-400'
                    : 'border-zinc-800 text-zinc-500'
                }`}>
                  {msg.role}
                </div>
                <pre className="px-3 py-2.5 text-zinc-300 whitespace-pre-wrap break-words font-sans leading-relaxed">
                  {msg.content}
                </pre>
              </div>
            ))}
          </div>
        )}

        {tab === 'memory' && (() => {
          const blocks = extractMemoryBlocks(data.traces ?? {})
          if (blocks.length === 0) return <span className="text-zinc-500 text-xs">No memory topics were retrieved.</span>
          // Parse topics from the memory block
          const allTopics: Array<{ title: string; age: string; summary: string; chunks: string[] }> = []
          for (const b of blocks) {
            const topicSections = b.block.split(/^### /m).slice(1)
            for (const section of topicSections) {
              const [headerLine, ...rest] = section.split('\n')
              const titleMatch = headerLine?.match(/^(.+?)\s*\*\((.+?)\)\*/)
              const title = titleMatch?.[1]?.trim() ?? headerLine?.trim() ?? ''
              const age = titleMatch?.[2] ?? ''
              const body = rest.join('\n').trim()
              // Split summary from chunks (chunks start with #### )
              const chunkSplit = body.split(/^#### /m)
              const summary = chunkSplit[0]?.trim() ?? ''
              const chunks = chunkSplit.slice(1).map(c => {
                // Strip the date-range header line (e.g. "undefined NaN – Jan 1" or "Mar 3 – Mar 5")
                const lines = c.trim().split('\n')
                const firstLine = lines[0] ?? ''
                // Date-range lines typically don't start with User:/Assistant: and contain –
                if (!firstLine.startsWith('User:') && !firstLine.startsWith('Assistant:') && !firstLine.startsWith('Summary:')) {
                  return lines.slice(1).join('\n').trim()
                }
                return c.trim()
              })
              allTopics.push({ title, age, summary, chunks })
            }
          }
          return (
            <div className="space-y-4">
              {allTopics.map((topic, ti) => (
                <div key={ti} className="bg-zinc-800/40 rounded-lg border border-zinc-800 overflow-hidden">
                  <div className="px-3 py-2 border-b border-zinc-800 flex items-baseline gap-2">
                    <span className="text-xs font-medium text-zinc-200">{topic.title}</span>
                    {topic.age && <span className="text-[11px] text-zinc-500">{topic.age}</span>}
                  </div>
                  {topic.summary && (
                    <div className="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-800/50 italic">{topic.summary}</div>
                  )}
                  {topic.chunks.map((chunk, ci) => (
                    <details key={ci} className="border-t border-zinc-800/50">
                      <summary className="px-3 py-1.5 text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                        Chunk {ci + 1} ({chunk.split('\n').length} lines)
                      </summary>
                      <pre className="px-3 py-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-words font-sans leading-relaxed">{chunk}</pre>
                    </details>
                  ))}
                </div>
              ))}
            </div>
          )
        })()}

        {tab === 'head-trace' && (
          <div className="space-y-1">
            {buildTimeline(data.traces ?? {}).map((evt, i) => (
              <div key={i} className={`flex gap-2 px-3 py-1.5 rounded text-[11px] font-mono ${
                evt.type === 'head' ? 'bg-blue-900/20 text-blue-300' :
                evt.type === 'agent' ? 'bg-emerald-900/20 text-emerald-300' :
                evt.type === 'steward' ? 'bg-amber-900/20 text-amber-300' :
                evt.type === 'tool' ? 'bg-zinc-800/60 text-zinc-400' :
                evt.type === 'error' ? 'bg-red-900/20 text-red-300' :
                'bg-zinc-800/40 text-zinc-400'
              }`}>
                <span className="text-zinc-500 shrink-0 w-[52px]">{evt.time}</span>
                <span className={`shrink-0 w-[60px] text-[11px] font-semibold uppercase ${
                  evt.type === 'head' ? 'text-blue-500' :
                  evt.type === 'agent' ? 'text-emerald-500' :
                  evt.type === 'steward' ? 'text-amber-500' :
                  evt.type === 'tool' ? 'text-zinc-500' :
                  evt.type === 'error' ? 'text-red-500' :
                  'text-zinc-500'
                }`}>{evt.label}</span>
                <span className="whitespace-pre-wrap break-words min-w-0">{evt.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Scenario detail panel ─────────────────────────────────────────────────────

function ScenarioDetail({
  scenario,
  onRun,
}: {
  scenario: EvalScenarioInfo
  onRun: (names: string[], opts?: { variant?: string; runs?: string }) => void
}) {
  const [selectedResult, setSelectedResult] = useState<string | null>(null)
  const tz = useConfigTimezone()


  const { data } = useQuery({
    queryKey: ['eval-results', scenario.name],
    queryFn: () => api.evals.results(scenario.name),
    staleTime: 30_000,
  })

  if (selectedResult) {
    return <ResultDetail id={selectedResult} onBack={() => setSelectedResult(null)} />
  }

  const results = data?.results ?? []
  const hasVariants = scenario.variants.length > 0

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3 shrink-0">
        <span className="text-sm font-medium text-zinc-100">{scenario.name}</span>
        <div className="flex-1" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">
        {/* Description */}
        <p className="text-sm text-zinc-400">{scenario.description}</p>

        {/* Rubric */}
        {scenario.rubric.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Rubric</div>
            <div className="space-y-1.5">
              {scenario.rubric.map((dim, i) => {
                const [name, ...rest] = dim.split(' — ')
                // Aggregate: find the latest run_id, then take the lowest score
                // for this dimension across all results in that run.
                const latestRunId = results[0]?.runId
                const runResults = latestRunId ? results.filter(r => r.runId === latestRunId) : []
                const scores = runResults
                  .map(r => r.dimensions[name ?? '']?.score)
                  .filter((s): s is number => s !== undefined)
                const score = scores.length > 0 ? Math.min(...scores) : undefined
                return (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-zinc-500 text-[11px] mt-0.5">—</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-mono text-zinc-400">{name}</span>
                      {rest.length > 0 && <span className="text-[11px] text-zinc-500"> — {rest.join(' — ')}</span>}
                      {score !== undefined && <ScoreBar score={score} />}
                      {scores.length > 1 && <span className="text-[11px] text-zinc-500 ml-1">({scores.length} runs)</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Run history */}
        {results.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Run History</div>
            <div className="space-y-1.5">
              {results.map(result => (
                <button
                  key={result.id}
                  onClick={() => setSelectedResult(result.id)}
                  className="w-full text-left px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <ScoreDot pass={result.pass} />
                    <span className="text-xs text-zinc-300">{formatInTz(result.createdAt, tz, { style: 'full' })}</span>
                    <span className={`ml-auto text-[11px] font-medium ${result.pass ? 'text-green-400' : 'text-red-400'}`}>
                      {result.pass ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1 truncate">{result.overall}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {results.length === 0 && (
          <p className="text-xs text-zinc-500">No runs yet. Click Run to execute this scenario.</p>
        )}
      </div>
    </div>
  )
}

// ─── Output pane ──────────────────────────────────────────────────────────────

function OutputPane({
  lines,
  runState,
  onStop,
  onRun,
  lastRunSummary,
  scenario,
}: {
  lines: string[]
  runState: RunState
  onStop: () => void
  onRun: (names: string[], opts?: { variant?: string; runs?: string }) => void
  lastRunSummary: { passed: number; total: number } | null
  scenario: { name: string; variants: string[] } | null
}) {
  const hasVariants = scenario ? scenario.variants.length > 0 : false
  const isRunning = runState === 'running'
  const ref = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !atBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="flex flex-col border-t border-zinc-800 min-h-0" style={{ height: '40%' }}>
      <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-2 shrink-0 flex-wrap">
        <span className="text-xs text-zinc-500">Output</span>
        {runState === 'running' && <span className="text-[11px] text-zinc-500 animate-pulse">running…</span>}
        {lastRunSummary && runState === 'done' && (
          <span className={`text-[11px] font-medium ${lastRunSummary.passed === lastRunSummary.total ? 'text-green-400' : 'text-amber-400'}`}>
            {lastRunSummary.passed}/{lastRunSummary.total} passed
          </span>
        )}
        <div className="flex-1" />
        {scenario && hasVariants && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onRun([scenario.name], { runs: 'all' })}
              disabled={isRunning}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              run all variants
            </button>
            {scenario.variants.map(v => (
              <button
                key={v}
                onClick={() => onRun([scenario.name], { variant: v })}
                disabled={isRunning}
                className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                run {v}
              </button>
            ))}
          </div>
        )}
        {scenario && !hasVariants && (
          <button
            onClick={() => onRun([scenario.name], {})}
            disabled={isRunning}
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            run
          </button>
        )}
        {runState === 'running' && (
          <button onClick={onStop} className="text-[11px] text-red-700 hover:text-red-500 transition-colors">stop</button>
        )}
      </div>
      <div
        ref={ref}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap min-h-0"
      >
        {lines.length === 0 ? (
          <span className="text-zinc-500">Run a scenario to see output here.</span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={
                /PASS/.test(line) ? 'text-green-400' :
                /FAIL|error|Error/.test(line) ? 'text-red-400' :
                /Scenario:|Run ID:/.test(line) ? 'text-zinc-200' :
                /✓/.test(line) ? 'text-green-400' :
                /✗/.test(line) ? 'text-red-400' :
                'text-zinc-500'
              }
            >
              {line || '\u00a0'}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function EvalsPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [runState, setRunState] = useState<RunState>('idle')
  const [lines, setLines] = useState<string[]>([])
  const [lastRunSummary, setLastRunSummary] = useState<{ passed: number; total: number } | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['evals'],
    queryFn: api.evals.list,
    staleTime: 60_000,
  })

  const scenarios = data?.scenarios ?? []

  // Group by category
  const byCategory: Record<string, EvalScenarioInfo[]> = {}
  for (const s of scenarios) {
    if (!byCategory[s.category]) byCategory[s.category] = []
    byCategory[s.category]!.push(s)
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter(c => byCategory[c]),
    ...Object.keys(byCategory).filter(c => !CATEGORY_ORDER.includes(c)),
  ]

  function toggleCheck(name: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function runScenarios(names: string[], opts?: { variant?: string; runs?: string }) {
    if (runState === 'running') return
    esRef.current?.close()
    setRunState('running')
    setLines([])
    setLastRunSummary(null)

    const param = names.join(',')
    let url = `/api/evals/run?scenarios=${encodeURIComponent(param)}`
    if (opts?.variant) url += `&variant=${encodeURIComponent(opts.variant)}`
    if (opts?.runs) url += `&runs=${encodeURIComponent(opts.runs)}`
    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('line', (e) => {
      const { text } = JSON.parse(e.data) as { text: string }
      setLines(prev => [...prev, text])
    })

    es.addEventListener('done', (e) => {
      const { passed, runId } = JSON.parse(e.data) as { passed: boolean; runId: string; code: number }
      setRunState('done')
      // Refetch scenario list + results for any selected scenario
      void qc.invalidateQueries({ queryKey: ['evals'] })
      if (selected) void qc.invalidateQueries({ queryKey: ['eval-results', selected] })
      void qc.invalidateQueries({ queryKey: ['eval-results'] })
      es.close()
    })

    es.addEventListener('start', (e) => {
      const { scenarios: started } = JSON.parse(e.data) as { scenarios: string[] }
      setLastRunSummary({ passed: 0, total: started.length || names.length })
    })

    es.onerror = () => {
      setRunState('done')
      es.close()
    }
  }

  function stopRun() {
    esRef.current?.close()
    esRef.current = null
    setRunState('idle')
  }

  useEffect(() => () => { esRef.current?.close() }, [])

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading…</div>
  }

  const selectedScenario = scenarios.find(s => s.name === selected) ?? null
  const checkedList = [...checked]
  const totalCost = scenarios.reduce((sum, s) => sum + s.estimatedCostUsd, 0)
  const checkedCost = checkedList.reduce((sum, name) => {
    return sum + (scenarios.find(s => s.name === name)?.estimatedCostUsd ?? 0)
  }, 0)

  return (
    <div className="h-full flex">
      {/* Left sidebar */}
      <div className="w-[20rem] shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">
        <div className="px-4 pt-6 pb-3 border-b border-zinc-800 shrink-0">
          <h1 className="text-lg font-semibold text-zinc-100 mb-3">Evals</h1>
          <div className="flex gap-1.5">
            <button
              onClick={() => runScenarios(scenarios.map(s => s.name))}
              disabled={runState === 'running'}
              className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Run All
            </button>
            {checkedList.length > 0 && (
              <button
                onClick={() => runScenarios(checkedList)}
                disabled={runState === 'running'}
                className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Run ({checkedList.length})
              </button>
            )}
          </div>
          <div className="mt-2 text-[11px] text-zinc-500">
            {checkedList.length > 0
              ? <>{formatCost(checkedCost)} for {checkedList.length} · {formatCost(totalCost)} for all · Anthropic est.</>
              : <>{formatCost(totalCost)} to run all · Anthropic est.</>
            }
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-4">
          {orderedCategories.map(cat => (
            <div key={cat}>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {CATEGORY_LABEL[cat] ?? cat}
              </div>
              {byCategory[cat]!.map(s => (
                <div
                  key={s.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(s.name)}
                  onKeyDown={e => e.key === 'Enter' && setSelected(s.name)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    selected === s.name ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(s.name)}
                    onChange={e => { e.stopPropagation(); toggleCheck(s.name) }}
                    onClick={e => e.stopPropagation()}
                    className="w-3 h-3 rounded accent-zinc-400 shrink-0"
                  />
                  <span className={`text-xs flex-1 break-words min-w-0 ${selected === s.name ? 'text-zinc-100' : 'text-zinc-400'}`}>
                    {s.name}
                  </span>
                  <span className="text-[11px] text-zinc-700 shrink-0">{formatCost(s.estimatedCostUsd)}</span>
                  <SidebarScoreBar result={s.lastResult} />
                </div>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Scenario detail or empty state */}
        <div className="flex-1 flex min-h-0" style={{ height: '60%' }}>
          {selectedScenario ? (
            <ScenarioDetail
              key={selectedScenario.name}
              scenario={selectedScenario}
              onRun={runScenarios}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
              Select a scenario or run all
            </div>
          )}
        </div>

        {/* Output pane */}
        <OutputPane
          lines={lines}
          runState={runState}
          onStop={stopRun}
          onRun={runScenarios}
          lastRunSummary={lastRunSummary}
          scenario={selectedScenario}
        />
      </div>
    </div>
  )
}
