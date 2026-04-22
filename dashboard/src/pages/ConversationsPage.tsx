import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Paperclip, X } from 'lucide-react'
import { api } from '../lib/api'
import { agentDisplayName } from '../lib/agentId'
import { useStream } from '../hooks/useStream'
import { useMode } from '../context/ModeContext'
import { useAssistantName } from '../lib/assistant-name'
import type { Message, StewardRun, EventUsageSummary, SettingsData } from '../types/api'
import { formatInTz, useConfigTimezone } from '../lib/formatTime'

// Stable color palette for agent IDs — deterministic hash to one of 8 distinct colors
const AGENT_COLORS = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7']
function agentColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]!
}

function parseAgentPrefix(content: string): { agentId: string | null; text: string } {
  const match = content.match(/^\[agent:([^\]]+)\]\s*/)
  if (match) return { agentId: match[1]!, text: content.slice(match[0].length) }
  return { agentId: null, text: content }
}

function _basename(p?: string): string {
  if (!p) return '?'
  return p.split('/').pop()?.split('\\').pop() ?? p
}

function _shorten(p?: string): string {
  if (!p) return '?'
  return p.length > 40 ? '...' + p.slice(-37) : p
}

function _description(tc: { input: Record<string, unknown> }): string | null {
  const d = tc.input['description']
  return typeof d === 'string' && d.trim() !== '' ? d.trim() : null
}

function _displayInput(tc: { input: Record<string, unknown> }): Record<string, unknown> {
  if (_description(tc) === null) return tc.input
  const { description: _d, ...rest } = tc.input
  return rest
}

function toolCallSummary(tc: { name: string; input: Record<string, unknown> }): string {
  const p = (key: string) => tc.input[key] as string | undefined
  switch (tc.name) {
    case 'read_file': return `read_file → ${_basename(p('path'))}`
    case 'read_multiple_files': {
      const paths = tc.input.paths as string[] | undefined
      return `read_multiple_files → ${paths?.length ?? '?'} files`
    }
    case 'write_file': {
      const desc = _description(tc)
      if (desc) return `write_file → ${desc}`
      return `write_file → ${_basename(p('path'))}`
    }
    case 'edit_file': {
      const desc = _description(tc)
      if (desc) return `edit_file → ${desc}`
      return `edit_file → ${_basename(p('file_path') ?? p('path'))}`
    }
    case 'view_image': return `view_image → ${_basename(p('path'))}`
    case 'create_directory': return `create_directory → ${_shorten(p('path'))}`
    case 'list_directory': return `list_directory → ${_shorten(p('path'))}`
    case 'directory_tree': return `directory_tree → ${_shorten(p('path'))}`
    case 'move_file': return `move_file → ${_basename(p('source'))} → ${_basename(p('destination'))}`
    case 'search_files': return `search_files → "${p('query') ?? p('pattern')}"`
    case 'get_file_info': return `get_file_info → ${_basename(p('path'))}`
    case 'bash':
    case 'bash_no_net': {
      const desc = _description(tc)
      if (desc) return `${tc.name} → ${desc}`
      const cmd = p('command') ?? ''
      return `${tc.name} → ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}`
    }
    case 'web_search': return `web_search → "${p('query')}"`
    case 'web_fetch': {
      const desc = _description(tc)
      if (desc) return `web_fetch → ${desc}`
      try { return `web_fetch → ${new URL(p('url')!).hostname}` } catch { return 'web_fetch' }
    }
    case 'write_note': return `write_note → ${p('title')}`
    case 'read_note': return `read_note → ${p('title')}`
    case 'search_notes': return `search_notes → "${p('query')}"`
    case 'delete_note': return `delete_note → ${p('title')}`
    case 'create_schedule': return `create_schedule → ${p('skillName')} (${p('cron')})`
    case 'create_reminder': {
      const msg = p('message') ?? ''
      return `create_reminder → ${msg.length > 50 ? msg.slice(0, 47) + '...' : msg}`
    }
    case 'send_file': {
      const desc = _description(tc)
      if (desc) return `send_file → ${desc}`
      return `send_file → ${_basename(p('path'))}`
    }
    case 'spawn_agent': {
      const desc = _description(tc)
      if (desc) return `spawn_agent → ${desc}`
      const task = p('task')
      if (task) return `spawn_agent → ${task.length > 60 ? task.slice(0, 57) + '...' : task}`
      return 'spawn_agent'
    }
    default: return tc.name
  }
}

function toolResultSummary(tr: { name: string; content: string }): string {
  const hasError = tr.content.includes('"error":true') || tr.content.includes('"error": true') || (tr.content.includes('"error":') && tr.content.includes('"message":'))
  const ok = !hasError
  switch (tr.name) {
    case 'bash':
    case 'bash_no_net': {
      const m = tr.content.match(/Exit code: (\S+)/)
      return `${tr.name} ← exit ${m?.[1] ?? '?'}`
    }
    case 'web_search': {
      const count = (tr.content.match(/Title:/g) || []).length
      return `web_search ← ${count} result${count === 1 ? '' : 's'}`
    }
    case 'web_fetch': {
      const kb = (tr.content.length / 1024).toFixed(1)
      return `web_fetch ← ${kb}KB`
    }
    case 'read_file':
    case 'read_multiple_files': {
      const kb = (tr.content.length / 1024).toFixed(1)
      return `${tr.name} ← ${kb}KB`
    }
    case 'write_file': return `write_file ← ${ok ? 'ok' : 'error'}`
    case 'edit_file': return `edit_file ← ${ok ? 'ok' : 'error'}`
    case 'create_directory': return `create_directory ← ${ok ? 'ok' : 'error'}`
    case 'move_file': return `move_file ← ${ok ? 'ok' : 'error'}`
    case 'search_files': {
      const lines = tr.content.split('\n').filter((l: string) => l.trim()).length
      if (lines === 0 || tr.content.toLowerCase().includes('no match')) return 'search_files ← no matches'
      return `search_files ← ${lines} match${lines === 1 ? '' : 'es'}`
    }
    case 'list_directory': {
      const items = tr.content.split('\n').filter((l: string) => l.trim()).length
      return `list_directory ← ${items} item${items === 1 ? '' : 's'}`
    }
    case 'directory_tree': {
      const lines = tr.content.split('\n').filter((l: string) => l.trim()).length
      return `directory_tree ← ${lines} entries`
    }
    case 'write_note': return `write_note ← ${ok ? 'ok' : 'error'}`
    case 'delete_note': return `delete_note ← ${ok ? 'ok' : 'error'}`
    case 'create_schedule': return `create_schedule ← ${ok ? 'ok' : 'error'}`
    case 'create_reminder': return `create_reminder ← ${ok ? 'ok' : 'error'}`
    default: return tr.name
  }
}

const SYSTEM_MARKER_PREFIXES = ['<system-trigger', '<system-event', '<system-nudge', '[SYSTEM: ', '<agent-result'] as const
function isSystemEventText(content: string): boolean {
  return SYSTEM_MARKER_PREFIXES.some(p => content.startsWith(p))
}

function MessageBubble({ message, usage, showUsage, showToolMessages, showSystemEvents, tz }: { message: Message; usage?: EventUsageSummary; showUsage?: boolean; showToolMessages?: boolean; showSystemEvents?: boolean; tz: string }) {
  const formatTime = (iso: string) => formatInTz(iso, tz, { includeSeconds: true })
  if ((message.kind === 'tool_call' || message.kind === 'tool_result') && !showToolMessages && !message.injected) {
    return null
  }

  if (message.kind === 'text' && isSystemEventText(message.content) && !showSystemEvents) {
    return null
  }

  if (message.kind === 'text') {
    const isUser = message.role === 'user'
    const attachments = message.attachments ?? []
    const { agentId, text: displayText } = message.injected ? parseAgentPrefix(message.content) : { agentId: null, text: message.content }
    const borderColor = agentId ? agentColor(agentId) : undefined
    return (
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`max-w-2xl px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words ${
            isUser
              ? 'bg-zinc-800 text-zinc-100'
              : message.injected
              ? 'bg-zinc-800/60 text-zinc-400 border border-zinc-700 font-mono text-xs'
              : 'bg-[var(--accent)] text-white border border-[var(--accent)] saturate-[1.06] brightness-[0.85]'
          }`}
          style={borderColor ? { border: 'none', borderLeft: `10px solid ${borderColor}` } : undefined}
          title={formatTime(message.createdAt)}
        >
          {!isUser && !message.injected
            ? <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{displayText}</Markdown></div>
            : displayText}
          {attachments.length > 0 && (
            <div className="mt-2 space-y-2">
              {attachments.map((att, i) => {
                const diskFilename = att.path ? att.path.split('/').pop() : undefined
                const displayName = att.filename ?? diskFilename ?? 'file'
                const mediaUrl = diskFilename ? `/api/media/${encodeURIComponent(diskFilename)}` : undefined
                if (att.type === 'image' && mediaUrl) {
                  return <img key={i} src={mediaUrl} alt={displayName} className="max-w-sm rounded-lg mt-1" />
                }
                if (att.type === 'audio' && mediaUrl) {
                  return <audio key={i} controls src={mediaUrl} className="mt-1 max-w-full" />
                }
                if (mediaUrl) {
                  return (
                    <a key={i} href={mediaUrl} download={displayName}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${isUser ? 'bg-zinc-700 text-zinc-300' : 'bg-white/15 text-white/90'}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z" />
                        <path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
                      </svg>
                      {displayName}{att.size ? ` (${att.size > 1024 * 1024 ? `${(att.size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(att.size / 1024)}KB`})` : ''}
                    </a>
                  )
                }
                return null
              })}
            </div>
          )}
        </div>
        {showUsage && usage && (
          <div className="mt-1 px-1 text-xs text-zinc-700 space-y-0.5">
            {Object.entries(usage.byModel).map(([model, m]) => (
              <div key={model} className="text-zinc-500">
                {model}: {m.inputTokens.toLocaleString()} in / {m.outputTokens.toLocaleString()} out · ${m.costUsd.toFixed(4)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (message.kind === 'tool_call') {
    const aid = (message as Message & { _agentId?: string })._agentId
    const agentPrefix = aid ? agentDisplayName(aid) : ''
    const borderColor = aid ? agentColor(aid) : undefined
    return (
      <div className="flex flex-col items-start" title={formatTime(message.createdAt)}>
        <div className="flex flex-col gap-1">
          {message.toolCalls.map((tc, i) => {
            const summary = toolCallSummary(tc)
            const key = tc.id || String(i)
            return (
              <details
                key={key}
                className="max-w-2xl bg-amber-950/40 border border-amber-900/50 rounded-lg text-xs font-mono"
                style={borderColor ? { border: 'none', borderLeft: `10px solid ${borderColor}` } : undefined}
              >
                <summary className="px-3 py-2 cursor-pointer text-amber-500 select-none break-words">
                  {agentPrefix && <>{agentPrefix}<br /></>}🔧 {summary}
                </summary>
                <pre className="px-3 pb-2 text-amber-400/80 overflow-auto">
                  {JSON.stringify(_displayInput(tc), null, 2)}
                </pre>
              </details>
            )
          })}
        </div>
      </div>
    )
  }

  if (message.kind === 'tool_result') {
    const aid = (message as Message & { _agentId?: string })._agentId
    const agentPrefix = aid ? agentDisplayName(aid) : ''
    const borderColor = aid ? agentColor(aid) : undefined
    return (
      <div className="flex flex-col items-start" title={formatTime(message.createdAt)}>
        <details className="max-w-2xl bg-emerald-950/40 border border-emerald-900/50 rounded-lg text-xs font-mono"
          style={borderColor ? { border: 'none', borderLeft: `10px solid ${borderColor}` } : undefined}>
          <summary className="px-3 py-2 cursor-pointer text-emerald-500 select-none">
            {agentPrefix && <>{agentPrefix}<br /></>}🔧 {message.toolResults.map(tr => toolResultSummary(tr)).join(' · ')}
          </summary>
          <pre className="px-3 pb-2 text-emerald-400/80 overflow-auto">
            {JSON.stringify(message.toolResults, null, 2)}
          </pre>
        </details>
      </div>
    )
  }

  if (message.kind === 'summary') {
    return (
      <div className="flex justify-center">
        <div className="px-4 py-1.5 bg-zinc-800 rounded-full text-xs text-zinc-500">
          {message.content}
        </div>
      </div>
    )
  }

  return null
}

function MergedToolBubble({ call, result, tz }: { call: Message & { kind: 'tool_call' }; result: Message & { kind: 'tool_result' }; tz: string }) {
  const formatTime = (iso: string) => formatInTz(iso, tz, { includeSeconds: true })
  const aid = (call as Message & { _agentId?: string })._agentId
  const agentPrefix = aid ? agentDisplayName(aid) : ''
  const borderColor = aid ? agentColor(aid) : undefined

  return (
    <div className="flex flex-col items-start" title={formatTime(call.createdAt)}>
      {call.toolCalls.map((tc, i) => {
        const callSummary = toolCallSummary(tc)
        const matchingResult = result.toolResults.find(tr => tr.toolCallId === tc.id)
        const resultSummary = matchingResult ? toolResultSummary(matchingResult) : null
        const key = tc.id || String(i)
        return (
          <details
            key={key}
            className="max-w-2xl bg-zinc-800/60 border border-zinc-700 rounded-lg text-xs font-mono"
            style={borderColor ? { border: 'none', borderLeft: `10px solid ${borderColor}` } : undefined}
          >
            <summary className="px-3 py-2 cursor-pointer select-none break-words text-zinc-400">
              {agentPrefix && <>{agentPrefix}<br /></>}<span className="text-amber-500">🔧 {callSummary}</span>
              {resultSummary && <><br /><span className="text-emerald-500">🔧 {resultSummary}</span></>}
            </summary>
            <pre className="px-3 pb-2 text-amber-400/80 overflow-auto">
              {JSON.stringify(_displayInput(tc), null, 2)}
            </pre>
            {matchingResult && (
              <pre className="px-3 pb-2 text-emerald-400/80 overflow-auto border-t border-zinc-700">
                {matchingResult.content.length > 500 ? matchingResult.content.slice(0, 500) + '...' : matchingResult.content}
              </pre>
            )}
          </details>
        )
      })}
    </div>
  )
}

function StewardRunRow({ run, tz }: { run: StewardRun; tz: string }) {
  const ran = run.stewards.filter(j => j.ran)
  if (ran.length === 0) return null
  const label = (name: string) => name.replace(/Steward$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  return (
    <div className="flex justify-center">
      <div
        className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900 border border-zinc-800 rounded-full text-xs"
        title={formatInTz(run.createdAt, tz, { includeSeconds: true })}
      >
        <span className="text-zinc-500 font-medium">stewards:</span>
        {ran.map(j => (
          <span key={j.name} className={j.fired ? 'text-amber-500' : 'text-zinc-500'}>{label(j.name)}{j.fired ? ' ↑' : ''}</span>
        ))}
      </div>
    </div>
  )
}

function MemoryRetrievalRow({ text, tokens }: { text: string; tokens?: number }) {
  const [expanded, setExpanded] = useState(false)
  const preview = text.length > 120 ? text.slice(0, 120) + '…' : text
  return (
    <div className="flex justify-center">
      <div
        className="max-w-[600px] px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-500 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        title="Memory retrieved for this turn"
      >
        <span className="text-zinc-600 font-medium">memory{typeof tokens === 'number' ? ` (~${tokens.toLocaleString()} tokens)` : ''}:</span>{' '}
        <span className="whitespace-pre-wrap">{expanded ? text : preview}</span>
      </div>
    </div>
  )
}

// ─── Agent pill types ────────────────────────────────────────────────────────

interface AgentPill {
  id: string
  task: string
  status: string
  skillName: string | null
  createdAt: string
}

function statusDot(status: string) {
  if (status === 'running') return 'bg-emerald-500'
  if (status === 'suspended') return 'bg-amber-500'
  return 'bg-zinc-600'
}

function isActive(status: string) {
  return status === 'running' || status === 'suspended'
}

// ─── Agent stream view ──────────────────────────────────────────────────────

function AgentStreamView({ agentId, status }: { agentId: string; status: string }) {
  const tz = useConfigTimezone()
  const historyQuery = useQuery({
    queryKey: ['agent-history', agentId],
    queryFn: () => api.agents.history(agentId),
    refetchOnWindowFocus: false,
    refetchInterval: (status === 'running' || status === 'suspended') ? 3_000 : false,
  })

  const bottomRef = useRef<HTMLDivElement>(null)
  const messages = historyQuery.data?.history ?? []
  const initialScrollDoneRef = useRef(false)
  const atBottomRef = useRef(true)

  // Track whether the user is at the bottom of the scroll view. When they scroll
  // up to read history, we stop auto-scrolling on new messages so the agent
  // working live doesn't yank them back down.
  useEffect(() => {
    const el = document.querySelector('main') as HTMLElement | null
    if (!el) return
    const handler = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [])

  // Jump to bottom instantly on first load
  useLayoutEffect(() => {
    if (!historyQuery.isLoading && !initialScrollDoneRef.current && messages.length > 0) {
      initialScrollDoneRef.current = true
      const el = document.querySelector('main')
      if (el) el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
  })

  // Smooth scroll on new messages — only if the user hasn't scrolled away from the bottom
  useEffect(() => {
    if (initialScrollDoneRef.current && atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length])

  if (historyQuery.isLoading) {
    return <p className="text-sm text-zinc-500 text-center pt-8">Loading agent history…</p>
  }

  if (messages.length === 0) {
    return <p className="text-sm text-zinc-500 text-center pt-8">No messages yet</p>
  }

  const renderedAgentMessages: React.ReactNode[] = []
  const skipAgentIndices = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (skipAgentIndices.has(i)) continue
    const msg = messages[i]!
    if (msg.kind === 'tool_call') {
      const next = messages[i + 1]
      if (next && next.kind === 'tool_result') {
        const callIds = new Set(msg.toolCalls.map(tc => tc.id))
        const hasMatch = next.toolResults.some(tr => callIds.has(tr.toolCallId))
        if (hasMatch) {
          skipAgentIndices.add(i + 1)
          renderedAgentMessages.push(
            <MergedToolBubble key={msg.id ?? `agent-merged-${i}`} call={msg} result={next} tz={tz} />
          )
          continue
        }
      }
    }
    renderedAgentMessages.push(
      <MessageBubble key={msg.id ?? `agent-msg-${i}`} message={msg} showToolMessages={true} showSystemEvents={true} tz={tz} />
    )
  }

  return (
    <>
      {renderedAgentMessages}
      <div ref={bottomRef} />
    </>
  )
}

// ─── Main page ──────────────────────────────────────────────────────────────

type TimelineItem = ({ _type: 'message' } & Message) | ({ _type: 'stewardRun' } & StewardRun)

export default function ConversationsPage() {
  useStream()
  const { isDeveloper } = useMode()
  const assistantName = useAssistantName()
  const { data: isTyping } = useQuery({ queryKey: ['typing'], initialData: false, staleTime: Infinity })
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const s = settings as SettingsData | undefined
  const visibility = {
    agentWork:        s?.visAgentWork        ?? false,
    headTools:        s?.visHeadTools        ?? false,
    systemEvents:     s?.visSystemEvents     ?? false,
    stewardRuns:      s?.visStewardRuns      ?? false,
    agentPills:       s?.visAgentPills       ?? false,
    memoryRetrievals: s?.visMemoryRetrievals ?? false,
  }
  const usageFootersEnabled = s?.usageFootersEnabled === true
  const tz = (settings as SettingsData | undefined)?.timezone || 'UTC'

  // Agent work backfill + live stream (gated by the agentWork category)
  const { data: xrayBackfill } = useQuery({
    queryKey: ['xray-backfill'],
    queryFn: api.agents.xrayHistory,
    enabled: visibility.agentWork,
    staleTime: Infinity,
  })
  const { data: xrayLive } = useQuery<Array<{ agentId: string; message: Message }>>({
    queryKey: ['xray-messages'],
    initialData: [],
    staleTime: Infinity,
    enabled: visibility.agentWork,
  })

  const { data: memoryRetrievals } = useQuery<Array<{ text: string; eventId?: string; tokens?: number }>>({
    queryKey: ['memory-retrievals'],
    initialData: [],
    staleTime: Infinity,
    enabled: visibility.memoryRetrievals,
  })
  const memoryByEvent = new Map((memoryRetrievals ?? []).filter(m => m.eventId).map(m => [m.eventId!, { text: m.text, tokens: m.tokens }]))

  const messagesQuery = useQuery({
    queryKey: ['messages'],
    queryFn: api.messages.list,
    refetchOnWindowFocus: false,
  })

  // Agents query drives the pill bar data — enable if either developer mode OR the agent pills category is on
  const agentsEnabled = isDeveloper || visibility.agentPills
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: api.agents.list,
    enabled: agentsEnabled,
    refetchInterval: agentsEnabled ? 5_000 : false,
  })

  const stewardRunsQuery = useQuery({
    queryKey: ['stewardRuns'],
    queryFn: api.stewardRuns.list,
  })

  const usageQuery = useQuery({
    queryKey: ['usage'],
    queryFn: api.usage.get,
  })

  // ── Pill state ──────────────────────────────────────────────────────────────
  const [selectedStream, setSelectedStream] = useState<'head' | string>('head')
  const [knownAgents, setKnownAgents] = useState<Map<string, AgentPill>>(new Map())

  // Accumulate agents as they appear (keeps completed ones as greyed pills)
  useEffect(() => {
    const agents = agentsQuery.data?.agents
    if (!agents) return
    setKnownAgents(prev => {
      const next = new Map(prev)
      for (const a of agents) {
        next.set(a.id, { id: a.id, task: a.task, status: a.status, skillName: a.skillName, createdAt: a.createdAt })
      }
      return next
    })
  }, [agentsQuery.data])

  // ── Input state ─────────────────────────────────────────────────────────────
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleSend() {
    const text = input.trim()
    if ((!text && pendingFiles.length === 0) || sending) return
    setSending(true)
    const savedInput = input
    const savedFiles = [...pendingFiles]
    setInput('')
    setPendingFiles([])
    setSelectedStream('head') // Switch to head when sending
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const filesToSend = savedFiles
      let files: Array<{ name: string; mediaType: string; data?: string; textContent?: string }> | undefined
      if (filesToSend.length > 0) {
        files = await Promise.all(filesToSend.map(async f => {
          const isText = f.type.startsWith('text/') || ['application/json', 'application/xml',
            'application/javascript', 'application/typescript', 'application/csv',
            'application/x-yaml', 'application/yaml', 'application/toml',
            'application/x-sh', 'application/sql', 'application/graphql',
          ].includes(f.type.split(';')[0]!.trim())

          if (isText) {
            // Let the browser handle charset/BOM decoding natively
            const text = await f.text()
            return { name: f.name, mediaType: f.type || 'text/plain', textContent: text }
          }
          // Binary: base64 encode
          const data = await new Promise<string>(resolve => {
            const reader = new FileReader()
            reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
            reader.readAsDataURL(f)
          })
          return { name: f.name, mediaType: f.type || 'application/octet-stream', data }
        }))
      }
      await api.messages.send(text, files)
    } catch {
      // Restore input and files on failure so the user can retry
      setInput(savedInput)
      setPendingFiles(savedFiles)
    } finally {
      setSending(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? [])
    if (selected.length > 0) {
      setPendingFiles(prev => [...prev, ...selected])
    }
    e.target.value = '' // reset so the same file can be selected again
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // ── Scroll management ───────────────────────────────────────────────────────
  const bottomRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  function getMain() { return document.querySelector('main') as HTMLElement | null }

  const handleScroll = useCallback(() => {
    const el = getMain()
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  useEffect(() => {
    const el = getMain()
    el?.addEventListener('scroll', handleScroll, { passive: true })
    return () => el?.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  const messages = messagesQuery.data?.messages ?? []
  const stewardRunsList = stewardRunsQuery.data?.stewardRuns ?? []

  // Merge agent tool calls/results into timeline when the Agent work category is on
  const xrayMessages: Message[] = visibility.agentWork
    ? [...(xrayBackfill?.messages ?? []), ...(xrayLive ?? [])]
        // Dedupe by message id (backfill + live may overlap)
        .filter((entry, i, arr) => arr.findIndex(e => e.message.id === entry.message.id) === i)
        .map(entry => ({
          ...entry.message,
          injected: true,
          _agentId: entry.agentId,
        } as Message & { _agentId?: string }))
    : []

  const timeline: TimelineItem[] = [
    ...messages.map(m => ({ _type: 'message' as const, ...m })),
    ...xrayMessages.map(m => ({ _type: 'message' as const, ...m })),
    ...stewardRunsList.map(r => ({ _type: 'stewardRun' as const, ...r })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const isLoading = messagesQuery.isLoading || stewardRunsQuery.isLoading
  const perEvent = usageQuery.data?.perEvent ?? {}
  const perEventCount = Object.keys(perEvent).length

  function scrollToBottom() {
    const el = getMain()
    if (el) el.scrollTop = el.scrollHeight
  }

  const initialScrollDone = useRef(false)
  useLayoutEffect(() => {
    if (!initialScrollDone.current && !isLoading) {
      initialScrollDone.current = true
      scrollToBottom()
    }
  })

  useEffect(() => {
    if (initialScrollDone.current && atBottomRef.current) {
      scrollToBottom()
    }
  }, [timeline.length, perEventCount, isTyping])

  // Scroll to bottom when switching back to head stream
  useEffect(() => {
    if (selectedStream === 'head') {
      requestAnimationFrame(scrollToBottom)
    }
  }, [selectedStream])

  // ── Cancel agent ────────────────────────────────────────────────────────────
  async function handleCancelAgent(agentId: string) {
    if (!window.confirm('Cancel this agent?')) return
    try {
      await api.agents.cancel(agentId)
    } catch { /* ignore */ }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-zinc-500">
        Loading…
      </div>
    )
  }

  if (messagesQuery.isError || stewardRunsQuery.isError) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-400">
        Failed to load messages
      </div>
    )
  }

  const sortedPills = [...knownAgents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 border-b border-zinc-800 bg-zinc-900 z-10">
        <div className="px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-100">Conversation</h2>
        </div>

        {/* ── Pill bar (agent stream selector) ─────────────────────────── */}
        {visibility.agentPills && sortedPills.length > 0 && (
          <div className="px-6 pb-3 flex gap-1.5 overflow-x-auto">
            {/* Head pill */}
            <button
              onClick={() => setSelectedStream('head')}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                selectedStream === 'head'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'bg-zinc-800/50 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              Head
            </button>

            {/* Agent pills */}
            {sortedPills.map(a => {
              const active = isActive(a.status)
              const selected = selectedStream === a.id
              const taskSnippet = a.task.length > 40 ? a.task.slice(0, 37) + '…' : a.task
              return (
                <button
                  key={a.id}
                  onClick={() => setSelectedStream(a.id)}
                  className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-zinc-700 text-zinc-100'
                      : active
                      ? 'bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      : 'bg-zinc-800/30 text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-400'
                  }`}
                  title={a.task}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(a.status)}`} />
                  <span className="truncate max-w-[200px]">{a.skillName || agentDisplayName(a.id) || taskSnippet}</span>
                  {a.status === 'suspended' && <span className="text-amber-500 text-[11px]">paused</span>}
                  {active && (
                    <span
                      onClick={e => { e.stopPropagation(); void handleCancelAgent(a.id) }}
                      className="ml-0.5 text-zinc-500 hover:text-red-400 cursor-pointer"
                      title="Cancel agent"
                    >
                      ×
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Stream content ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-end px-6 py-4 space-y-3">
        {selectedStream === 'head' ? (
          // Head stream (existing timeline)
          timeline.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center pt-8">No messages yet</p>
          ) : (
            (() => {
              const renderedTimeline: React.ReactNode[] = []
              const skipIndices = new Set<number>()
              for (let i = 0; i < timeline.length; i++) {
                if (skipIndices.has(i)) continue
                const item = timeline[i]!
                if (item._type === 'stewardRun') {
                  if (visibility.stewardRuns) {
                    renderedTimeline.push(<StewardRunRow key={item.id} run={item} tz={tz} />)
                  }
                  continue
                }
                if (item.kind === 'tool_call' && (visibility.headTools || item.injected)) {
                  const next = timeline[i + 1]
                  if (next && next._type === 'message' && next.kind === 'tool_result') {
                    const callIds = new Set(item.toolCalls.map(tc => tc.id))
                    const hasMatch = next.toolResults.some(tr => callIds.has(tr.toolCallId))
                    if (hasMatch) {
                      skipIndices.add(i + 1)
                      renderedTimeline.push(
                        <MergedToolBubble key={item.id} call={item} result={next} tz={tz} />
                      )
                      continue
                    }
                  }
                }
                const memEntry = visibility.memoryRetrievals && 'role' in item && item.role === 'assistant' && 'eventId' in item && item.eventId ? memoryByEvent.get(item.eventId) : undefined
                renderedTimeline.push(
                  <React.Fragment key={item.id}>
                    {memEntry && <MemoryRetrievalRow text={memEntry.text} tokens={memEntry.tokens} />}
                    <MessageBubble message={item} showUsage={usageFootersEnabled} showToolMessages={visibility.headTools} showSystemEvents={visibility.systemEvents} usage={item.kind === 'text' && item.role === 'assistant' && item.eventId ? perEvent[item.eventId] : undefined} tz={tz} />
                  </React.Fragment>
                )
              }
              // Insert token budget markers (developer mode only)
              if (isDeveloper) {
                const TOKEN_MARKER_INTERVAL = 25_000
                // Walk timeline from bottom, accumulate tokens, insert markers at boundaries
                let cumTokens = 0
                let nextMarker = TOKEN_MARKER_INTERVAL
                const withMarkers: React.ReactNode[] = []
                for (let j = renderedTimeline.length - 1; j >= 0; j--) {
                  const tItem = timeline[j]
                  const msgTokens = tItem && '_type' in tItem && tItem._type === 'message' && 'tokens' in tItem ? (tItem.tokens as number) ?? 0 : 0
                  cumTokens += msgTokens
                  if (cumTokens >= nextMarker) {
                    withMarkers.push(
                      <div key={`tok-${nextMarker}`} className="flex items-center gap-2 py-0.5 select-none">
                        <div className="flex-1 border-t border-dashed border-zinc-700/50" />
                        <span className="text-[10px] text-zinc-600 font-mono">{(nextMarker / 1000).toFixed(0)}k tokens</span>
                        <div className="flex-1 border-t border-dashed border-zinc-700/50" />
                      </div>
                    )
                    nextMarker += TOKEN_MARKER_INTERVAL
                  }
                  withMarkers.push(renderedTimeline[j])
                }
                return withMarkers.reverse()
              }
              return renderedTimeline
            })()
          )
        ) : (
          // Agent stream
          <AgentStreamView agentId={selectedStream} status={knownAgents.get(selectedStream)?.status ?? 'running'} />
        )}
        {selectedStream === 'head' && isTyping && (
          <div className="flex items-start">
            <div className="px-4 py-3 rounded-2xl bg-[var(--accent)] flex gap-1.5 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
        {selectedStream === 'head' && <div ref={bottomRef} />}
      </div>

      {/* ── Input area ─────────────────────────────────────────────── */}
      {selectedStream === 'head' && (
      <div className="sticky bottom-0 px-6 py-4 border-t border-zinc-800 bg-zinc-900">
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pendingFiles.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
                <Paperclip size={11} className="text-zinc-400" />
                {f.name}
                <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-zinc-300">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="pl-0 pr-1 py-2.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={inputRef}
            className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded-xl px-4 py-2.5 resize-none outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-[var(--accent)]/50 max-h-40 overflow-y-auto"
            rows={1}
            placeholder={`Message ${assistantName}…`}
            value={input}
            onChange={e => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = el.scrollHeight + 'px'
            }}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <button
            onClick={() => void handleSend()}
            disabled={(!input.trim() && pendingFiles.length === 0) || sending}
            className="px-4 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-xl transition-colors"
          >
            Send
          </button>
        </div>
      </div>
      )}
    </div>
  )
}
