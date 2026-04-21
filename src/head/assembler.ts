import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { QueueEvent } from '../types/core.js'
import type { SkillLoader } from '../types/skill.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { MessageStore } from '../db/messages.js'
import type { AgentStore } from '../db/agents.js'
import type { Config } from '../config.js'
import { estimateStringTokens, estimateTokens } from '../db/token.js'
import { agentResult, priorTool, priorResult, escapeXmlBody, _descriptionForMarker } from '../markers.js'
import type { Message, ToolCallMessage, ToolResultMessage, AgentWork } from '../types/core.js'
import type { McpRegistry } from '../mcp/registry.js'
import { getOptionalTools } from '../sub-agents/registry.js'
import type { Memory, RetrieveResult, Topic } from '../memory/index.js'
import type { LLMRouter } from '../types/llm.js'
import type { TextMessage } from '../types/core.js'
import { log } from '../logger.js'
import { formatIanaTimeLine } from '../util/time.js'

// ─���─ AssembledContext ───────────────────────��───────────────────────────��─────

export interface AssembledContext {
  systemPrompt: string
  history: Message[]
  historyBudget: number
  /** The memory block injected into the system prompt, if any. Empty string if no topics retrieved. */
  memoryBlock: string
}

// ─── deriveQueryText ──────────────────────────────────────────────────────────

export function deriveQueryText(
  trigger: QueueEvent,
  workers: AgentStore,
  skillLoader: SkillLoader,
): string {
  switch (trigger.type) {
    case 'user_message':
      return trigger.text

    case 'agent_completed':
    case 'agent_question':
    case 'agent_failed': {
      const t = workers.get(trigger.agentId)
      const signal =
        trigger.type === 'agent_completed' ? trigger.output
        : trigger.type === 'agent_question' ? trigger.question
        : trigger.error
      return t ? `${t.task} ${signal}` : signal
    }

    case 'schedule_trigger': {
      const skill = skillLoader.load(trigger.skillName)
      return skill
        ? `${skill.name}: ${skill.frontmatter.description}`
        : trigger.skillName
    }

    case 'webhook': {
      const payloadSnippet = typeof trigger.payload === 'string'
        ? trigger.payload
        : JSON.stringify(trigger.payload)
      return `${trigger.source} ${trigger.event} ${payloadSnippet}`.slice(0, 500)
    }

    case 'agent_response':
      return trigger.response

    case 'reminder_trigger':
      return trigger.message

  }
}

// ─── ContextAssembler ─────────────────────────────────────────────────────────

export interface ContextAssembler {
  assemble(trigger: QueueEvent): Promise<AssembledContext>
}

export class ContextAssemblerImpl implements ContextAssembler {
  constructor(
    private identityLoader: IdentityLoader,
    private messages: MessageStore,
    private workers: AgentStore,
    private skillLoader: SkillLoader,
    private config: Config,
    private mcpRegistry: McpRegistry,
    private getNow: () => Date = () => new Date(),
    private topicMemory?: Memory,
    private router?: LLMRouter,
  ) {}

  async assemble(trigger: QueueEvent): Promise<AssembledContext> {
    // 1. System prompt + dynamic worker capabilities block
    // Static blocks (capabilities, skills) come before "Current time:" so they
    // land in the cached prefix that toAnthropicSystem splits on.
    let systemPrompt = this.identityLoader.loadSystemPrompt()

    // Ambient context — cached situational snapshot
    if (this.config.workspacePath) {
      try {
        const ambientPath = path.join(this.config.workspacePath.replace(/^~/, os.homedir()), 'AMBIENT.md')
        const ambient = fs.readFileSync(ambientPath, 'utf8').trim()
        if (ambient) systemPrompt += `\n\n## Ambient Context\n${ambient}`
      } catch { /* file doesn't exist yet — skip */ }
    }

    const capabilitiesBlock = await buildCapabilitiesBlock(this.mcpRegistry)
    if (capabilitiesBlock) {
      systemPrompt = `${systemPrompt}\n\n${capabilitiesBlock}`
    }
    const skillsBlock = buildSkillsBlock(this.skillLoader)
    if (skillsBlock) {
      systemPrompt = `${systemPrompt}\n\n${skillsBlock}`
    }
    systemPrompt += `\n\n${buildEnvironmentBlock(this.config)}`
    systemPrompt += `\n\nCurrent time: ${formatIanaTimeLine(this.getNow(), this.config.timezone)}`
    if (trigger.type === 'user_message' && trigger.channel) {
      systemPrompt += `\nChannel: ${trigger.channel}`
    }

    // 2. Fixed allocation — split the context window between system, memory, history, and output.
    //    No LLM calls needed. Memory retrieval uses the library's built-in relevance ranking.
    const baseSystemTokens = estimateStringTokens(systemPrompt)
    const outputReserve = this.config.llmMaxTokens
    const remaining = Math.max(0, this.config.contextWindowTokens - baseSystemTokens - outputReserve)
    const memoryFraction = (this.config.memoryBudgetPercent ?? 40) / 100
    const memoryBudget = Math.floor(remaining * memoryFraction)
    const historyBudget = remaining - memoryBudget

    // 3. Memory retrieval — query-based, ranked by relevance, capped at budget.
    //    For user_message triggers, the rewriter piggy-backs a shouldRetrieve
    //    classification onto its structured output so we can skip retrieval on
    //    pure acknowledgment turns ("ok", "thanks", "on it") without a second
    //    LLM call. Non-user_message triggers bypass the gate entirely.
    let finalSystemPrompt = systemPrompt
    let memoryBlock = ''
    if (this.topicMemory) {
      const rawTriggerText = deriveQueryText(trigger, this.workers, this.skillLoader)
      let retrievalQuery: string = rawTriggerText
      let shouldRetrieve = true
      if (trigger.type === 'user_message') {
        const decision = await this.rewriteQueryForRetrieval(rawTriggerText)
        shouldRetrieve = decision.shouldRetrieve
        retrievalQuery = decision.query
      }
      if (!shouldRetrieve) {
        log.debug(`[assembler] retrieval skipped (shouldRetrieve=false) for: "${rawTriggerText}"`)
      } else {
        if (retrievalQuery !== rawTriggerText) {
          log.debug(`[assembler] retrieval query rewritten: "${rawTriggerText}" → "${retrievalQuery}"`)
        }
        const retrieved = await this.topicMemory.retrieve(retrievalQuery, memoryBudget)
        if (retrieved.length > 0) {
          const topics = await this.topicMemory.getTopics()
          memoryBlock = formatMemoryBlock(retrieved, topics)
          finalSystemPrompt = `${systemPrompt}\n\n${memoryBlock}`
        }
      }
    }

    // 4. History — most recent messages that fit in the budget (FIFO)
    const history = this.messages.getRecent(historyBudget)

    return { systemPrompt: finalSystemPrompt, history, historyBudget, memoryBlock }
  }

  /**
   * Classify whether the latest user turn warrants a memory retrieval AND, if
   * so, rewrite it into a self-contained search query. Both decisions ride on a
   * single structured-output LLM call so classification costs zero extra
   * round-trips. Every failure mode (LLM throw, parse error, schema mismatch,
   * missing field) fails OPEN — returns `{ shouldRetrieve: true, query: triggerText }`
   * — because a missing retrieval on a substantive turn is worse than a wasted
   * retrieval on an ack.
   */
  private async rewriteQueryForRetrieval(
    triggerText: string,
  ): Promise<{ shouldRetrieve: boolean; query: string }> {
    const failOpen = { shouldRetrieve: true, query: triggerText }

    const contextTokenBudget = this.config.memoryQueryContextTokens
    if (!contextTokenBudget || !this.router) return failOpen

    const recent = this.messages.getRecentTextByTokens(contextTokenBudget, estimateTokens).reverse()
    if (recent.length === 0) return failOpen

    const conversationContext = recent
      .map(m => `[${(m as TextMessage).role}] ${(m as TextMessage).content}`)
      .join('\n')

    const system = [
      'You gate memory retrieval for a conversational assistant. For each latest user message you produce a JSON object with two fields:',
      '',
      '1. shouldRetrieve (boolean): should the assistant pull prior memories/topics before responding?',
      '   - Return FALSE ONLY when the latest message is a pure acknowledgment, social nicety, or filler with no information need.',
      '     Examples of FALSE: "ok", "thanks", "thx", "on it", "got it", "lol", "👍", "sure", "np", "cool", "k".',
      '   - Return TRUE for anything else — any question, any message referencing people/entities/topics/events, any statement that could benefit from prior context, anything ambiguous.',
      '     Examples of TRUE: "what did she say?", "remind me about the budget", "is alice still on the project?", "summarize yesterday", "the thing we discussed".',
      '   - When in doubt, return TRUE. False negatives (missing context) are much worse than false positives (a wasted retrieval).',
      '',
      '2. query (string): a self-contained search query for the topic index.',
      '   - Resolve all pronouns and implicit references using the conversation excerpt. Name entities, topics, and specifics explicitly.',
      '   - If shouldRetrieve is false the query will not be used, but it MUST still be a non-empty string — echo the latest message verbatim in that case.',
      '',
      'Output ONLY the JSON object matching the schema. No prose, no preamble, no code fences.',
    ].join('\n')

    const user = `Recent conversation:\n${conversationContext}\n\nLatest message: ${triggerText}`

    let raw: string
    try {
      const result = await this.router.complete(
        this.config.memoryRetrievalModel,
        [{ kind: 'text' as const, id: 'qr', role: 'user' as const, content: user, createdAt: new Date().toISOString() }],
        [],
        {
          systemPrompt: system,
          maxTokens: 384,
          jsonSchema: {
            name: 'memory_query_rewriter',
            schema: {
              type: 'object',
              properties: {
                shouldRetrieve: { type: 'boolean' },
                query: { type: 'string' },
              },
              required: ['shouldRetrieve', 'query'],
              additionalProperties: false,
            },
          },
        },
      )
      raw = result.content
    } catch {
      return failOpen
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.trim())
    } catch {
      return failOpen
    }

    if (!parsed || typeof parsed !== 'object') return failOpen
    const obj = parsed as Record<string, unknown>
    if (typeof obj.shouldRetrieve !== 'boolean' || typeof obj.query !== 'string') {
      return failOpen
    }

    const trimmedQuery = obj.query.trim()
    return {
      shouldRetrieve: obj.shouldRetrieve,
      query: trimmedQuery || triggerText,
    }
  }
}

// ─── getMessageContent ────────────────────────────────────────────────────────

function getMessageContent(m: Message): string {
  switch (m.kind) {
    case 'text':
      return m.content
    case 'tool_call':
      return m.content || m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input)})`).join(', ')
    case 'tool_result':
      return m.toolResults.map(tr => `${tr.name}: ${tr.content}`).join('\n')
    case 'summary':
      return m.content
  }
}

// ─── Agent work marker helpers ────────────────────────────────────────────────

const AGENT_WORK_RE = /^\x00AGENT_WORK:([\s\S]+)\x00$/

function parseAgentWorkMarker(content: string): AgentWork | null {
  const m = AGENT_WORK_RE.exec(content)
  if (!m) return null
  try { return JSON.parse(m[1]!) as AgentWork }
  catch { return null }
}

function renderAgentWorkForHead(aw: AgentWork): string {
  const lines: string[] = []
  for (const m of aw.work) {
    // WR-01 family: free-text from a sub-agent is attacker-influenceable prose.
    // Wrap it in <text>…</text> with body-escape so any injected closing tag
    // (e.g. </agent-result>) or forged sibling marker is neutralized. The
    // surrounding agent-result deliberately does NOT escape workSection (that
    // would destroy child <prior-tool>/<prior-result> markers), so every
    // attacker-reachable byte in workSection must be escaped at this boundary.
    if (m.kind === 'text' && m.content) {
      lines.push(`<text>${escapeXmlBody(m.content)}</text>`)
    } else if (m.kind === 'tool_call') {
      if (m.content) lines.push(`<text>${escapeXmlBody(m.content)}</text>`)
      for (const tc of m.toolCalls) {
        const intent = _descriptionForMarker(tc.input)
        lines.push(priorTool({
          name: tc.name,
          input: JSON.stringify(tc.input),
          ...(intent !== null ? { intent } : {}),
        }))
      }
    } else if (m.kind === 'tool_result') {
      for (const tr of m.toolResults)
        lines.push(priorResult(tr.name, tr.content))
    }
  }
  const workSection = lines.length > 0 ? '\n\n' + lines.join('\n') : ''
  return agentResult('completed', aw.agentId, workSection, aw.output)
}

// ─── formatMemoryBlock ────────────────────────────────────────────────────────

export function formatMemoryBlock(results: RetrieveResult[], allTopics: Topic[]): string {
  // Build a map for quick topic metadata lookup
  const topicMap = new Map(allTopics.map(t => [t.topicId, t]))

  // Sort results oldest-to-newest by topic's lastUpdatedAt
  const sorted = [...results].sort((a, b) => {
    const aTime = topicMap.get(a.topicId)?.lastUpdatedAt ?? ''
    const bTime = topicMap.get(b.topicId)?.lastUpdatedAt ?? ''
    return aTime.localeCompare(bTime)
  })

  const now = Date.now()
  const sections: string[] = ['## Memory Context']

  for (const result of sorted) {
    const topic = topicMap.get(result.topicId)
    const lastUpdated = topic?.lastUpdatedAt
    const relAge = lastUpdated ? formatRelativeAge(new Date(lastUpdated), now) : ''
    const header = relAge ? `### ${result.label}  *(${relAge})*` : `### ${result.label}`

    const lines: string[] = [header, result.summary]

    for (let i = 0; i < result.chunks.length; i++) {
      const chunk = result.chunks[i]!
      if (i > 0) lines.push('\n---')
      if (chunk.timeRange) {
        const dateLabel = formatDateRange(chunk.timeRange.start, chunk.timeRange.end)
        if (dateLabel) lines.push(`\n#### ${dateLabel}`)
      }
      if (chunk.raw) {
        for (const msg of chunk.messages) {
          const role = msg.role === 'user' ? 'User' : 'Assistant'
          const aw = parseAgentWorkMarker(msg.content)
          const rendered = aw ? renderAgentWorkForHead(aw) : msg.content
          lines.push(`${role}: ${rendered}`)
        }
      } else {
        lines.push(`Summary: ${chunk.summary}`)
      }
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}

function formatRelativeAge(date: Date, nowMs: number): string {
  const diffMs = nowMs - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 14) return `${diffDays} days ago`
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks < 8) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return ''
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const sMonth = monthNames[s.getUTCMonth()]!
  const sDay = s.getUTCDate()
  const eMonth = monthNames[e.getUTCMonth()]!
  const eDay = e.getUTCDate()
  if (sMonth === eMonth && sDay === eDay) return `${sMonth} ${sDay}`
  if (sMonth === eMonth) return `${sMonth} ${sDay}–${eDay}`
  return `${sMonth} ${sDay} – ${eMonth} ${eDay}`
}

function getCapableModel(config: Config): string {
  switch (config.llmProvider) {
    case 'anthropic': return config.anthropicModelCapable
    case 'gemini': return config.geminiModelCapable
    case 'openai': return config.openaiModelCapable
  }
}

function buildEnvironmentBlock(config: Config): string {
  const platform = process.platform  // 'linux', 'darwin', 'win32', ...
  const arch = os.arch()             // 'x64', 'arm64', ...
  const osLabel = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'
  const home = os.homedir()
  const model = getCapableModel(config)

  return `## System Environment
OS: ${osLabel} (${platform}/${arch})
Home: ${home}
LLM: ${config.llmProvider} / ${model}`
}

function buildSkillsBlock(skillLoader: SkillLoader): string {
  const skills = skillLoader.listAll()
  if (skills.length === 0) return ''
  const lines = skills.map(s => `- \`${s.name}\`: ${s.frontmatter.description}`)
  return `## Available Skills\n${lines.join('\n')}`
}

// Cache capabilities block — re-fetch at most once per hour
let capabilitiesCache: { block: string; builtAt: number } | null = null
const CAPABILITIES_TTL_MS = 60 * 60 * 1000

async function buildCapabilitiesBlock(mcpRegistry: McpRegistry): Promise<string> {
  const now = Date.now()
  if (capabilitiesCache && now - capabilitiesCache.builtAt < CAPABILITIES_TTL_MS) {
    return capabilitiesCache.block
  }

  const lines: string[] = []

  // Built-in optional tools always available to workers
  for (const { definition } of getOptionalTools()) {
    lines.push(`- \`${definition.name}\`: ${definition.description}`)
  }

  // Usage, schedule, and reminder tools (always available to agents)
  lines.push('- `get_usage`: Get token usage statistics, optionally filtered to a time period.')
  lines.push('- `list_schedules`: List all skill schedules.')
  lines.push('- `create_schedule`: Create a new skill schedule.')
  lines.push('- `update_schedule`: Update an existing schedule.')
  lines.push('- `delete_schedule`: Delete a schedule by ID.')
  lines.push('- `list_reminders`: List all active reminders.')
  lines.push('- `create_reminder`: Create a reminder that fires a notification at a specified time.')
  lines.push('- `cancel_reminder`: Cancel a reminder by ID.')
  lines.push('- `write_note`: Save a note for later recall (facts, commands, references).')
  lines.push('- `read_note`: Read a specific note by ID.')
  lines.push('- `list_notes`: List all saved notes.')
  lines.push('- `search_notes`: Search notes by keyword.')
  lines.push('- `delete_note`: Delete a note by ID.')

  // MCP tools from any user-configured capabilities
  for (const capability of mcpRegistry.listCapabilities()) {
    try {
      const tools = await mcpRegistry.loadTools(capability)
      for (const { definition } of tools) {
        lines.push(`- \`${definition.name}\`: ${definition.description}`)
      }
    } catch {
      // MCP server unreachable at assembly time — skip silently
    }
  }

  const block = lines.length > 0
    ? `## Available Agent Tools\nAgents you spawn have access to these tools:\n${lines.join('\n')}`
    : ''

  capabilitiesCache = { block, builtAt: now }
  return block
}
