import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { log } from '../logger.js'
import { extractJson } from '../llm/util.js'
import { stewardComplete, interpolate } from '../head/steward.js'
import { describeCron } from './cron.js'
import type { LLMRouter } from '../types/llm.js'
import type { UsageStore } from '../db/usage.js'

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'prompts')

let proactiveWorkspaceDir: string | null = null

export function setProactiveWorkspaceDir(dir: string): void {
  proactiveWorkspaceDir = dir
}

function loadPrompt(name: string): string {
  if (proactiveWorkspaceDir) {
    const workspacePath = path.join(proactiveWorkspaceDir, `${name}.md`)
    if (existsSync(workspacePath)) {
      return readFileSync(workspacePath, 'utf8')
    }
  }
  return readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

export interface ProactivePromptEntry {
  filename: string
  sourcePath: string
  isWorkspace: boolean
}

export function listProactivePrompts(): ProactivePromptEntry[] {
  const map = new Map<string, ProactivePromptEntry>()

  // First, load defaults
  if (existsSync(PROMPTS_DIR)) {
    for (const file of readdirSync(PROMPTS_DIR).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(PROMPTS_DIR, file), isWorkspace: false })
      }
    }
  }

  // Overlay workspace files (workspace wins)
  if (proactiveWorkspaceDir && existsSync(proactiveWorkspaceDir)) {
    for (const file of readdirSync(proactiveWorkspaceDir).sort()) {
      if (file.endsWith('.md')) {
        map.set(file, { filename: file, sourcePath: path.join(proactiveWorkspaceDir, file), isWorkspace: true })
      }
    }
  }

  return [...map.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

function formatTimestampedHistory(history: Array<{ role: string; content: string; createdAt?: string }>): string {
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

export interface ProactiveContext {
  skillName: string
  skillDescription: string
  skillInstructions: string
  scheduleCron: string | null
  lastRun: string | null
  lastSkipped: string | null
  lastSkipReason: string | null
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
}

export interface ProactiveDecision {
  action: 'run' | 'skip'
  reason: string
  /** Optional context from conversation to pass to the skill agent when running. */
  context?: string
}

const RUN_DEFAULT: ProactiveDecision = { action: 'run', reason: 'proactive decision failed, defaulting to run' }

// ─── Reminder Decision ──────────────────────────────────────────────────────

export interface ReminderDecisionContext {
  reminderMessage: string
  reminderCron: string | null
  userMd: string
  recentHistory: Array<{ role: string; content: string; createdAt?: string }>
  ambientContext: string
  currentTime: string
}

export type ReminderDecision = { action: 'inject' | 'skip'; reason: string }

const INJECT_DEFAULT: ReminderDecision = { action: 'inject', reason: 'reminder decision failed, defaulting to inject' }

export async function runReminderDecision(
  ctx: ReminderDecisionContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ReminderDecision> {
  const scheduleDesc = ctx.reminderCron
    ? describeCron(ctx.reminderCron)
    : '(one-time)'

  const prompt = interpolate(loadPrompt('reminder'), {
    CURRENT_TIME: ctx.currentTime,
    REMINDER_MESSAGE: ctx.reminderMessage,
    SCHEDULE: scheduleDesc,
    USER_MD: ctx.userMd || '(empty)',
    AMBIENT: ctx.ambientContext || '(none)',
    HISTORY: formatTimestampedHistory(ctx.recentHistory),
  })

  try {
    const response = await stewardComplete(
      'steward-reminder', router, model, prompt, 256,
      usageStore, eventId, undefined,
      { name: 'reminder_decision', schema: { type: 'object', properties: { action: { type: 'string', enum: ['inject', 'skip'] }, reason: { type: 'string' } }, required: ['action', 'reason'], additionalProperties: false } },
    )
    const parsed = extractJson(response.content) as { action?: string; reason?: string }
    if (parsed.action === 'skip' && parsed.reason) {
      return { action: 'skip', reason: parsed.reason }
    }
    return { action: 'inject', reason: parsed.reason ?? 'no reason to skip' }
  } catch (err) {
    log.warn('[proactive:reminder] decision failed, defaulting to inject:', (err as Error).message)
    return INJECT_DEFAULT
  }
}

export async function runProactiveDecision(
  ctx: ProactiveContext,
  router: LLMRouter,
  model: string,
  usageStore?: UsageStore,
  eventId?: string,
): Promise<ProactiveDecision> {
  const scheduleDesc = ctx.scheduleCron
    ? describeCron(ctx.scheduleCron)
    : '(one-time)'

  const prompt = interpolate(loadPrompt('tasks'), {
    CURRENT_TIME: ctx.currentTime,
    SKILL_NAME: ctx.skillName,
    SKILL_DESCRIPTION: ctx.skillDescription || '(no description)',
    SCHEDULE: scheduleDesc,
    LAST_RUN: ctx.lastRun || '(never)',
    SKILL_INSTRUCTIONS: ctx.skillInstructions || '(no skill instructions available)',
    USER_MD: ctx.userMd || '(empty)',
    AMBIENT: ctx.ambientContext || '(none)',
    HISTORY: formatTimestampedHistory(ctx.recentHistory),
  })

  try {
    const response = await stewardComplete(
      'steward-proactive', router, model, prompt, 256,
      usageStore, eventId, undefined,
      { name: 'proactive_decision', schema: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'skip'] }, reason: { type: 'string' }, context: { type: 'string' } }, required: ['action', 'reason'], additionalProperties: false } },
    )
    const parsed = extractJson(response.content) as { action?: string; reason?: string; context?: string }
    if (parsed.action === 'skip' && parsed.reason) {
      return { action: 'skip', reason: parsed.reason }
    }
    return {
      action: 'run',
      reason: parsed.reason ?? 'no reason to skip',
      ...(parsed.context ? { context: parsed.context } : {}),
    }
  } catch (err) {
    log.warn('[proactive] decision failed, defaulting to run:', (err as Error).message)
    return RUN_DEFAULT
  }
}
