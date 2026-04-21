import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { log } from '../logger.js'
import { generateId, extractJson } from '../llm/util.js'
import { estimateCost } from '../llm/pricing.js'
import { PRIORITY } from '../types/core.js'
import { systemNudge } from '../markers.js'
import { trace } from '../tracer.js'
import type { LLMRouter } from '../types/llm.js'
import type { QueueStore } from '../db/queue.js'
import type { UsageStore } from '../db/usage.js'

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'prompts')

let stewardWorkspaceDir: string | null = null

export function setStewardWorkspaceDir(dir: string): void {
  stewardWorkspaceDir = dir
}

export function loadStewardPrompt(name: string): string {
  if (stewardWorkspaceDir) {
    const workspacePath = path.join(stewardWorkspaceDir, `${name}.md`)
    if (existsSync(workspacePath)) {
      return readFileSync(workspacePath, 'utf8')
    }
  }
  return readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

export interface StewardPromptEntry {
  filename: string
  sourcePath: string
  isWorkspace: boolean
}

export function listStewardPrompts(): StewardPromptEntry[] {
  const map = new Map<string, StewardPromptEntry>()

  // First, load defaults
  if (existsSync(PROMPTS_DIR)) {
    for (const file of readdirSync(PROMPTS_DIR).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(PROMPTS_DIR, file), isWorkspace: false })
      }
    }
  }

  // Overlay workspace files (workspace wins)
  if (stewardWorkspaceDir && existsSync(stewardWorkspaceDir)) {
    for (const file of readdirSync(stewardWorkspaceDir).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(stewardWorkspaceDir, file), isWorkspace: true })
      }
    }
  }

  return [...map.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{${k}}`, v), template)
}

export interface StewardContext {
  /** The text that triggered the activation: user message, agent output, question, error, etc. */
  triggerText: string
  /** The type of event that triggered this activation */
  activationType: 'user_message' | 'agent_completed' | 'agent_failed' | 'agent_question' | 'schedule_trigger' | 'webhook' | 'other'
  /** The head's response this turn */
  headResponse: string
  /** Current contents of USER.md */
  currentUserMd: string
  /** Current contents of SOUL.md */
  currentSoulMd: string
  /** Current contents of BOOTSTRAP.md — empty string if cleared or not present */
  currentBootstrapMd: string
  /** ISO timestamp of activation start */
  activationStart: string
  /** Names of tools called by the head this turn */
  toolsCalledThisTurn: string[]
  /** Last few turns of conversation before this activation — includes injected event messages */
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
}

interface Nudge {
  kind: 'nudge'
  message: string
}

type StewardCorrection = Nudge

export type Steward = (ctx: StewardContext, router: LLMRouter, model: string, usageStore?: UsageStore, eventId?: string, onDebug?: (msg: string) => void) => Promise<StewardCorrection | null | 'skipped'>

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatHistory(history: Array<{ role: string; content: string; createdAt?: string }>): string {
  if (history.length === 0) return '(no prior conversation)'
  const now = Date.now()
  return history.map(m => {
    if (!m.createdAt) return `[${m.role}] ${m.content}`
    const ageMs = now - new Date(m.createdAt).getTime()
    const ageMin = Math.round(ageMs / 60_000)
    const label = ageMin < 60 ? `${ageMin}m ago`
      : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago`
      : `${Math.round(ageMin / 1440)}d ago`
    return `[${m.role}] (${label}) ${m.content}`
  }).join('\n')
}

export async function stewardComplete(
  stewardId: string,
  router: LLMRouter,
  model: string,
  prompt: string,
  maxTokens: number,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
  jsonSchema?: import('../types/llm.js').LLMCallOptions['jsonSchema'],
) {
  const msg = { kind: 'text' as const, role: 'user' as const, id: stewardId, content: prompt, createdAt: new Date().toISOString() }
  const t = trace.begin('steward', stewardId, model, '', [msg])
  let response: import('../types/llm.js').LLMResponse
  try {
    response = await router.complete(model, [msg], [], { maxTokens, ...(jsonSchema ? { jsonSchema } : {}) })
  } catch (err) {
    t.llmResponse(1, { content: `ERROR: ${(err as Error).message}`, inputTokens: 0, outputTokens: 0, stopReason: 'end_turn', model: model })
    t.end(1, { content: '', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn', model: model })
    throw err
  }
  t.llmResponse(1, response)
  t.end(1, response)
  usageStore?.record({
    sourceType: 'head',
    sourceId: eventId ?? null,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: estimateCost(
      response.model, response.inputTokens, response.outputTokens,
      response.cacheReadInputTokens, response.cacheCreationInputTokens,
    ),
    cacheReadTokens: response.cacheReadInputTokens ?? 0,
    cacheWriteTokens: response.cacheCreationInputTokens ?? 0,
  })
  onDebug?.(`\`[${stewardId}]\` ${response.content.trim().slice(0, 120)}`)
  return response
}

// ─── Preference Steward ─────────────────────────────────────────────────────────

const preferenceSteward: Steward = async (ctx, router, model, usageStore, eventId, onDebug) => {
  if (ctx.toolsCalledThisTurn.includes('write_identity')) return 'skipped'

  const prompt = interpolate(loadStewardPrompt('preference'), {
    HISTORY: formatHistory(ctx.recentHistory),
    TRIGGER_TEXT: ctx.triggerText,
    HEAD_RESPONSE: ctx.headResponse,
    CURRENT_USER_MD: ctx.currentUserMd || '(empty)',
    CURRENT_SOUL_MD: ctx.currentSoulMd || '(empty)',
  })

  const response = await stewardComplete('steward-pref', router, model, prompt, 1024, usageStore, eventId, onDebug,
    { name: 'preference_steward', schema: { type: 'object', properties: { preference: { type: 'boolean' }, nudge: { type: 'string' } }, required: ['preference', 'nudge'], additionalProperties: false } })

  let parsed: { preference: boolean; nudge?: string }
  try {
    parsed = extractJson(response.content) as { preference: boolean; nudge?: string }
  } catch {
    log.warn('[steward:preference] non-JSON response:', response.content.slice(0, 100))
    return null
  }

  if (!parsed.preference || !parsed.nudge) return null
  return { kind: 'nudge', message: parsed.nudge }
}

// ─── Spawn Steward ──────────────────────────────────────────────────────────────

const AGENT_MGMT_TOOLS = ['spawn_agent', 'message_agent', 'cancel_agent']

const spawnSteward: Steward = async (ctx, router, model, usageStore, eventId, onDebug) => {
  if (ctx.toolsCalledThisTurn.some(t => AGENT_MGMT_TOOLS.includes(t))) return 'skipped'

  const prompt = interpolate(loadStewardPrompt('spawn'), {
    HISTORY: formatHistory(ctx.recentHistory),
    TRIGGER_TEXT: ctx.triggerText,
    ACTIVATION_TYPE: ctx.activationType,
    HEAD_RESPONSE: ctx.headResponse,
  })

  const response = await stewardComplete('steward-spawn', router, model, prompt, 1024, usageStore, eventId, onDebug,
    { name: 'spawn_steward', schema: { type: 'object', properties: { missed: { type: 'boolean' }, nudge: { type: 'string' } }, required: ['missed', 'nudge'], additionalProperties: false } })

  let parsed: { missed: boolean; nudge?: string }
  try {
    parsed = extractJson(response.content) as { missed: boolean; nudge?: string }
  } catch {
    log.warn('[steward:spawn] non-JSON response:', response.content.slice(0, 100))
    return null
  }

  if (!parsed.missed || !parsed.nudge) return null
  return { kind: 'nudge', message: parsed.nudge }
}

// ─── Action Compliance Steward ──────────────────────────────────────────────────

const actionComplianceSteward: Steward = async (ctx, router, model, usageStore, eventId, onDebug) => {
  if (ctx.toolsCalledThisTurn.some(t => AGENT_MGMT_TOOLS.includes(t))) return 'skipped'

  const prompt = interpolate(loadStewardPrompt('action-compliance'), {
    HISTORY: formatHistory(ctx.recentHistory),
    TRIGGER_TEXT: ctx.triggerText,
    ACTIVATION_TYPE: ctx.activationType,
    HEAD_RESPONSE: ctx.headResponse,
  })

  const response = await stewardComplete('steward-action-compliance', router, model, prompt, 1024, usageStore, eventId, onDebug,
    { name: 'action_compliance_steward', schema: { type: 'object', properties: { missed: { type: 'boolean' }, hallucinated: { type: 'boolean' }, computed: { type: 'boolean' }, nudge: { type: 'string' } }, required: ['missed', 'hallucinated', 'computed', 'nudge'], additionalProperties: false } })

  let parsed: { missed?: boolean; hallucinated?: boolean; computed?: boolean; nudge?: string }
  try {
    parsed = extractJson(response.content) as { missed?: boolean; hallucinated?: boolean; computed?: boolean; nudge?: string }
  } catch {
    log.warn('[steward:action-compliance] non-JSON response:', response.content.slice(0, 100))
    return null
  }

  if ((parsed.missed || parsed.hallucinated || parsed.computed) && parsed.nudge) {
    return { kind: 'nudge', message: parsed.nudge }
  }
  return null
}

// ─── Bootstrap Steward ──────────────────────────────────────────────────────────

const bootstrapSteward: Steward = async (ctx, router, model, usageStore, eventId, onDebug) => {
  // Fast pre-filter: skip if BOOTSTRAP.md was already empty, or if the head
  // called write_identity this turn (it already handled onboarding).
  if (!ctx.currentBootstrapMd.trim()) return 'skipped'
  if (ctx.toolsCalledThisTurn.includes('write_identity')) return 'skipped'

  const prompt = interpolate(loadStewardPrompt('bootstrap'), {
    HISTORY: formatHistory(ctx.recentHistory),
    TRIGGER_TEXT: ctx.triggerText,
    HEAD_RESPONSE: ctx.headResponse,
  })

  const response = await stewardComplete('steward-bootstrap', router, model, prompt, 128, usageStore, eventId, onDebug,
    { name: 'bootstrap_steward', schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false } })

  let parsed: { done: boolean }
  try {
    parsed = extractJson(response.content) as { done: boolean }
  } catch {
    log.warn('[steward:bootstrap] non-JSON response:', response.content.slice(0, 100))
    return null
  }

  if (!parsed.done) return null
  return {
    kind: 'nudge',
    message: "Onboarding appears complete but you didn't finish the required steps. Call write_identity for 'USER.md' (user profile), write_identity for 'SOUL.md' (your personality and tone), and write_identity('BOOTSTRAP.md', '') to clear it. Important: USER.md and SOUL.md must not mention agents, sub-agents, spawning, or delegation — those are internal implementation details that do not belong in identity files. Do this silently — no message to the user until all three calls succeed.",
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runStewards(
  stewards: Steward[],
  ctx: StewardContext,
  router: LLMRouter,
  model: string,
  queueStore: QueueStore,
  channel: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
  onRan?: (results: Array<{ name: string; ran: boolean; fired: boolean }>) => void,
): Promise<void> {
  const corrections = await Promise.all(
    stewards.map(async j => {
      try { return await j(ctx, router, model, usageStore, eventId, onDebug) }
      catch (err) { log.warn(`[steward:${j.name}] threw:`, (err as Error).message); return null }
    })
  )

  const runSummary: Array<{ name: string; ran: boolean; fired: boolean }> = []

  for (const [i, correction] of corrections.entries()) {
    const stewardName = stewards[i]?.name ?? `steward-${i}`
    const ran = correction !== 'skipped'
    const fired = ran && correction !== null
    runSummary.push({ name: stewardName, ran, fired })
    if (fired && correction.kind === 'nudge') {
      queueStore.enqueue({
        type: 'user_message',
        id: generateId('qe'),
        channel,
        text: systemNudge(correction.message),
        createdAt: new Date().toISOString(),
        injected: true,
      }, PRIORITY.USER_MESSAGE)
      log.info(`[steward:${stewardName}] nudge enqueued: ${correction.message.slice(0, 80)}`)
      onDebug?.(`\`[${stewardName}]\` nudge sent — ${correction.message.slice(9, 80)}`)
    }
  }

  onRan?.(runSummary)
}

// ─── Relay Steward ──────────────────────────────────────────────────────────────

export interface RelayStewardContext {
  /** The agent's final output */
  output: string
  /** The agent's original task prompt */
  task: string
  /** Full skill instructions from SKILL.md — tells the steward what this skill is for and what it considers noteworthy */
  skillInstructions: string
  /** Current USER.md — user preferences and profile */
  userMd: string
  /** Current SOUL.md — assistant identity and behavior guidelines */
  soulMd: string
  /** Current ISO timestamp */
  currentTime: string
}

// Cap the agent output passed to the relay steward. The steward needs the gist
// to decide surface/suppress, not a full digest. Identity + skill context stay
// verbatim — that's the lens we want the judgment made through.
const DEFAULT_RELAY_OUTPUT_CAP = 8192  // ≈ 2K tokens

/** Pre-activation gate for scheduled agent completions.
 *  Returns true if the output is worth surfacing to the user, false to suppress. */
export async function runRelaySteward(
  ctx: RelayStewardContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
  outputCap: number = DEFAULT_RELAY_OUTPUT_CAP,
): Promise<boolean> {
  const clippedOutput = ctx.output.length > outputCap
    ? ctx.output.slice(0, outputCap) + '…[truncated]'
    : ctx.output
  const prompt = interpolate(loadStewardPrompt('relay'), {
    TASK: ctx.task,
    OUTPUT: clippedOutput,
    SKILL_INSTRUCTIONS: ctx.skillInstructions || '(no skill instructions available)',
    USER_MD: ctx.userMd || '(empty)',
    SOUL_MD: ctx.soulMd || '(empty)',
    CURRENT_TIME: ctx.currentTime,
  })
  try {
    const response = await stewardComplete('steward-relay', router, model, prompt, 128, usageStore, eventId, onDebug,
      { name: 'relay_steward', schema: { type: 'object', properties: { relay: { type: 'boolean' } }, required: ['relay'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { relay: boolean }
    return parsed.relay !== false
  } catch (err) {
    log.warn('[steward:relay] failed, defaulting to relay:', (err as Error).message)
    return true
  }
}

// ─── Completion Steward ────────────────────────────────────────────────────────

export interface CompletionStewardContext {
  task: string
  output: string
}

/** Classifies an agent's final output as a completion or a question.
 *  Used to decide whether to complete the agent or suspend it for an answer. */
export async function runCompletionSteward(
  ctx: CompletionStewardContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<{ type: 'done' } | { type: 'question' }> {
  const prompt = interpolate(loadStewardPrompt('agent-completion'), {
    TASK: ctx.task,
    OUTPUT: ctx.output,
  })
  try {
    const response = await stewardComplete('steward-completion', router, model, prompt, 128, usageStore, eventId, onDebug,
      { name: 'completion_steward', schema: { type: 'object', properties: { type: { type: 'string', enum: ['done', 'question'] } }, required: ['type'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { type: string }
    if (parsed.type === 'question') {
      return { type: 'question' }
    }
    return { type: 'done' }
  } catch (err) {
    log.warn('[steward:completion] failed, defaulting to done:', (err as Error).message)
    return { type: 'done' }
  }
}

// ─── Work Summary Steward ─────────────────────────────────────────────────────

export interface WorkSummaryContext {
  task: string
  work: string  // formatted work history (plain text)
}

/** Summarises an agent's work history into a concise paragraph for the head.
 *  Returns the summary string, or null on failure (caller keeps raw work). */
export async function runWorkSummarySteward(
  ctx: WorkSummaryContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<string | null> {
  const prompt = interpolate(loadStewardPrompt('work-summary'), {
    TASK: ctx.task,
    WORK: ctx.work,
  })
  try {
    const response = await stewardComplete('steward-work-summary', router, model, prompt, 4000, usageStore, eventId, onDebug,
      { name: 'work_summary_steward', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { summary: string }
    return parsed.summary || null
  } catch (err) {
    log.warn('[steward:work-summary] failed, keeping raw work:', (err as Error).message)
    return null
  }
}

// ─── Resume Steward ───────────────────────────────────────────────────────────

/** Gates message_agent calls to suspended agents — rejects non-answers so the head
 *  goes to the user instead. Returns true if the answer should resume the agent. */
export async function runResumeSteward(
  question: string,
  answer: string,
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<boolean> {
  const prompt = interpolate(loadStewardPrompt('resume'), {
    QUESTION: question,
    ANSWER: answer,
    HISTORY: formatHistory(recentHistory),
  })
  try {
    const response = await stewardComplete('steward-resume', router, model, prompt, 128, usageStore, eventId, onDebug,
      { name: 'resume_steward', schema: { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { pass: boolean }
    return parsed.pass !== false
  } catch (err) {
    log.warn('[steward:resume] failed, defaulting to pass:', (err as Error).message)
    return true
  }
}

// ─── Message Agent Steward ─────────────────────────────────────────────────────

/** Gates message_agent calls — blocks impatient head check-ins on running agents.
 *  Returns true if the message should be sent, false to block. */
export async function runMessageAgentSteward(
  task: string,
  message: string,
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<boolean> {
  const prompt = interpolate(loadStewardPrompt('message-agent'), {
    TASK: task,
    MESSAGE: message,
    HISTORY: formatHistory(recentHistory),
  })
  try {
    const response = await stewardComplete('steward-message-agent', router, model, prompt, 128, usageStore, eventId, onDebug,
      { name: 'message_agent_steward', schema: { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { pass: boolean }
    return parsed.pass !== false
  } catch (err) {
    log.warn('[steward:message-agent] failed, defaulting to pass:', (err as Error).message)
    return true
  }
}

// ─── Spawn Agent Steward ───────────────────────────────────────────────────

/** Gates spawn_agent calls from depth-1 agents — rejects over-delegation with a
 *  short reason the parent can act on. Returns {pass, reason}. */
export async function runSpawnAgentSteward(
  parentTask: string,
  childTask: string,
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<{ pass: boolean; reason: string }> {
  const prompt = interpolate(loadStewardPrompt('spawn-agent'), {
    PARENT_TASK: parentTask,
    CHILD_TASK: childTask,
    HISTORY: formatHistory(recentHistory),
  })
  try {
    const response = await stewardComplete('steward-spawn-agent', router, model, prompt, 1024, usageStore, eventId, onDebug,
      { name: 'spawn_agent_steward', schema: { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass', 'reason'], additionalProperties: false } })
    const parsed = extractJson(response.content) as { pass?: boolean; reason?: string }
    // Defensive: treat missing/undefined pass as pass (mirrors runMessageAgentSteward:434)
    if (parsed.pass === false) {
      return { pass: false, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
    }
    return { pass: true, reason: '' }
  } catch (err) {
    log.warn('[steward:spawn-agent] failed, defaulting to pass:', (err as Error).message)
    return { pass: true, reason: '' }
  }
}

// ─── Head Relay Steward ─────────────────────────────────────────────────────────

/** Post-processes head messages before delivery — rewrites agent leaks.
 *  Returns the (possibly rewritten) message. Never suppresses. */
export async function runHeadRelaySteward(
  message: string,
  recentHistory: Array<{ role: string; content: string }>,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  onDebug?: (msg: string) => void,
): Promise<string> {
  const historyText = recentHistory
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n')
  const prompt = interpolate(loadStewardPrompt('head-relay'), {
    HISTORY: historyText,
    MESSAGE: message,
  })
  try {
    const response = await stewardComplete('steward-head-relay', router, model, prompt, 4000, usageStore, undefined, onDebug,
      { name: 'head_relay_steward', schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['keep', 'rewrite'] },
          text: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      } })
    const parsed = extractJson(response.content) as { action: string; text?: string }
    if (parsed.action === 'rewrite' && parsed.text) return parsed.text
    return message  // 'keep' or fallback
  } catch (err) {
    log.warn('[steward:head-relay] failed, passing through:', (err as Error).message)
    return message
  }
}

// ─── Identity filter steward ──────────────────────────────────────────────────

export interface IdentityFilterResult {
  keep: string
  reject: string
}

export async function runIdentityFilterSteward(
  content: string,
  skillList: string,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
): Promise<IdentityFilterResult | null> {
  const prompt = interpolate(loadStewardPrompt('identity-filter'), {
    SKILL_LIST: skillList,
    CONTENT: content,
  })
  try {
    const response = await stewardComplete('steward-identity-filter', router, model, prompt, 4000, usageStore, undefined, undefined,
      { name: 'identity_filter_steward', schema: {
        type: 'object',
        properties: {
          keep: { type: 'string' },
          reject: { type: 'string' },
        },
        required: ['keep', 'reject'],
        additionalProperties: false,
      } })
    const parsed = extractJson(response.content) as IdentityFilterResult
    if (typeof parsed.keep !== 'string') return null
    return parsed
  } catch (err) {
    log.warn('[steward:identity-filter] failed, passing through:', (err as Error).message)
    return null  // fail-open: write as-is
  }
}

// ─── Context Relevance Steward ───────────────────────────────────────────────

/** Pre-activation filter: trims older head history to only relevant messages.
 *  Returns sorted array of indices to keep from the history array.
 *  Fail-open: on any error returns all indices (full history). */
export async function runContextRelevanceSteward(
  history: Array<{ role: string; content: string; createdAt?: string; injected?: boolean }>,
  triggerText: string,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  onDebug?: (msg: string) => void,
): Promise<number[]> {
  // Pre-compute mandatory keeps: last 5 indices + any injected message index
  const mandatoryKeeps = new Set<number>()
  const last5Start = Math.max(0, history.length - 5)
  for (let i = last5Start; i < history.length; i++) mandatoryKeeps.add(i)
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.injected) mandatoryKeeps.add(i)
  }

  // Format history for the prompt: numbered list with index, role, age, injected flag, full content
  const now = Date.now()
  const formattedHistory = history.map((m, i) => {
    let ageLabel = ''
    if (m.createdAt) {
      const ageMs = now - new Date(m.createdAt).getTime()
      const ageMin = Math.round(ageMs / 60_000)
      ageLabel = ageMin < 60 ? `${ageMin}m ago`
        : ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago`
        : `${Math.round(ageMin / 1440)}d ago`
    }
    const injectedTag = m.injected ? ' [injected]' : ''
    const ageSuffix = ageLabel ? ` (${ageLabel})` : ''
    return `[${i}] [${m.role}]${injectedTag}${ageSuffix} ${m.content}`
  }).join('\n')

  const prompt = interpolate(loadStewardPrompt('context-relevance'), {
    TRIGGER_TEXT: triggerText || '(no trigger text)',
    HISTORY: formattedHistory || '(no history)',
  })

  const jsonSchema = {
    name: 'context_relevance_steward' as const,
    schema: {
      type: 'object' as const,
      properties: { keep: { type: 'array', items: { type: 'integer' } } },
      required: ['keep'],
      additionalProperties: false,
    },
  }

  try {
    const response = await stewardComplete(
      'steward-context-relevance', router, model, prompt, 512,
      usageStore, eventId, onDebug, jsonSchema,
    )
    const parsed = extractJson(response.content) as { keep?: unknown }
    if (!Array.isArray(parsed.keep)) throw new Error('keep is not an array')
    const validIndices = (parsed.keep as unknown[])
      .filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < history.length)
    // Merge steward's keep list with mandatory keeps
    for (const idx of mandatoryKeeps) validIndices.push(idx)
    return [...new Set(validIndices)].sort((a, b) => a - b)
  } catch (err) {
    log.warn('[steward:context-relevance] failed, using full history:', (err as Error).message)
    // Fail-open: return all indices
    return Array.from({ length: history.length }, (_, i) => i)
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// ─── Routing steward ─────────────────────────────────────────────────────────

export async function runRoutingSteward(
  message: string,
  skillList: string,
  recentHistory: Array<{ role: string; content: string }>,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
  completedAgents?: Array<{ id: string; task: string }>,
  attachments?: Array<{ filename: string; type: string; mediaType: string }>,
): Promise<string | null> {
  const agentList = completedAgents?.length
    ? completedAgents.map(a => `- ${a.id}: ${a.task}`).join('\n')
    : '(none)'
  const attachmentList = attachments?.length
    ? attachments.map(a => `- ${a.filename} (${a.type}, ${a.mediaType})`).join('\n')
    : '(none)'
  const prompt = interpolate(loadStewardPrompt('routing'), {
    SKILL_LIST: skillList,
    COMPLETED_AGENTS: agentList,
    ATTACHMENTS: attachmentList,
    HISTORY: recentHistory.map(m => `[${m.role}] ${m.content}`).join('\n'),
    MESSAGE: message,
  })
  try {
    const response = await stewardComplete(
      'steward-routing', router, model, prompt, 200,
      usageStore, eventId, undefined,
      { name: 'routing_steward', schema: {
        type: 'object',
        properties: { hint: { type: 'string' } },
        required: ['hint'],
        additionalProperties: false,
      } }
    )
    const parsed = extractJson(response.content) as { hint: string }
    return parsed.hint || null
  } catch (err) {
    log.warn('[steward:routing] failed, passing through:', (err as Error).message)
    return null
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// DEFAULT_STEWARDS is the post-activation steward bank that runs after every head
// response. Each steward decides internally whether to fire (returning 'skipped',
// a nudge, or null). Individual stewards are gated by per-steward config flags in
// activation.ts — see the filter block there. Adding a steward here is a
// prerequisite for it running at all; the flag controls whether it's allowed to
// run on a given activation.
export const DEFAULT_STEWARDS: Steward[] = [
  bootstrapSteward,
  preferenceSteward,
  spawnSteward,
  actionComplianceSteward,
]
