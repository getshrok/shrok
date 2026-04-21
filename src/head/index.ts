import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolCall, ToolResult } from '../types/core.js'
import type { ToolDefinition } from '../types/llm.js'
import type { AgentRunner } from '../types/agent.js'
import type { Memory } from '../memory/index.js'
import type { SkillLoader } from '../types/skill.js'
import type { UsageStore } from '../db/usage.js'
import type { MessageStore } from '../db/messages.js'
import type { ToolExecutor } from '../llm/tool-loop.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { LLMRouter } from '../types/llm.js'
import type { TextMessage } from '../types/core.js'
import { runResumeSteward, runMessageAgentSteward, runIdentityFilterSteward } from './steward.js'
import { VIEW_IMAGE_DEF, executeViewImage } from '../sub-agents/registry.js'
import { DESCRIPTION_PARAM_SPEC } from '../tool-description.js'
import { timingMark } from '../timing.js'

// ─── HEAD_TOOLS definitions ───────────────────────────────────────────────────

export const HEAD_TOOLS: ToolDefinition[] = [
  {
    name: 'spawn_agent',
    description: 'Spawn an agent to handle a task asynchronously. Tell the agent what to do, not how — relay the user\'s intent and any relevant context, but let the agent decide the approach. Only include implementation details if the user specifically requested them. Always include a brief acknowledgment in your response when calling this tool (e.g. "On it." or "Checking now.") — the user needs to know you\'re working on it, and the loop exits immediately after.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
        prompt: { type: 'string', description: 'The full prompt for the agent.' },
        name: { type: 'string', description: 'Short human-readable name for this agent — 2-5 words describing what it\'s doing (e.g. "github-pr-123-review", "morning-email-triage", "fix-login-bug"). Used as the agent\'s ID prefix so you can identify it later. Multiple agents can run in parallel — be specific.' },
      },
      required: ['description', 'prompt', 'name'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send a message to an agent — works for running, paused, and completed agents. For running agents, delivers new context or instructions. For paused agents, provides the information they need and resumes them. For completed agents, resumes them with new instructions to continue where they left off.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['agentId', 'message'],
    },
  },
  {
    name: 'cancel_agent',
    description: 'Terminate a running or suspended agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'list_identity_files',
    description: 'List all files in the identity directory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write_identity',
    description: 'Overwrite an existing identity file. Use list_identity_files to see which files exist — writing to a non-existent file is an error. Changes take effect on the next activation. USER.md stores facts about the user: preferences, personal details, people in their life, and anything they ask to be remembered. SOUL.md stores personality, tone, and the assistant\'s name.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename, e.g. USER.md' },
        content: { type: 'string' },
      },
      required: ['file', 'content'],
    },
  },
  VIEW_IMAGE_DEF,
  {
    name: 'send_file',
    description: 'Send a file to the user through their current channel. Use when the user asked for a file and an agent created one.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: DESCRIPTION_PARAM_SPEC },
        path: { type: 'string', description: 'Path to the file.' },
      },
      required: ['description', 'path'],
    },
  },
  {
    name: 'get_usage',
    description: 'Returns estimated spend (USD) and token counts for the configured LLM account, broken down by model and source type, over a time window. Costs are ESTIMATED from per-token pricing tracked at request time and may drift slightly from the provider\'s billed total. Use this to answer "how much have I spent" instead of spawning an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp to filter from (e.g. "2026-04-15T00:00:00Z" for today UTC). Omit for all-time.' },
      },
    },
  },
]

// ─── HeadToolExecutor ─────────────────────────────────────────────────────────

export interface HeadToolExecutorOptions {
  agentRunner: AgentRunner
  agentStore?: import('../db/agents.js').AgentStore
  skillLoader: SkillLoader
  /** Unified loader across skills + tasks. Threaded in Plan 04-01; consumed by activation.ts and registry.ts in Plans 04-02/04-03. Optional for back-compat. */
  unifiedLoader?: import('../skills/unified.js').UnifiedLoader
  topicMemory: Memory
  usageStore: UsageStore
  identityDir: string
  identityLoader: IdentityLoader
  messages: MessageStore
  /** Returns the current head conversation history for passing to spawned agents. */
  getHistory?: () => import('../types/core.js').Message[]
  /** Returns attachments from the triggering event message, if any. */
  getAttachments?: () => import('../types/core.js').Attachment[]
  onDebug?: (msg: string) => Promise<void>
  onVerbose?: (msg: string) => Promise<void>
  /** Override the note returned in the spawn_agent tool result (for eval: encourages Round 2 text). */
  spawnAgentNote?: string
  /** LLM router for running stewards (e.g. resume steward). */
  llmRouter?: LLMRouter
  /** Model tier for steward calls. */
  stewardModel?: string
  /** Token budget for resume steward context. */
  resumeStewardContextTokens?: number
  /** Whether the resume steward validates answers to suspended agents. */
  resumeStewardEnabled?: boolean
  /** Whether message_agent can resume completed agents. */
  agentContinuationEnabled?: boolean
  /** Whether the message-agent steward validates calls (gates check-ins and continuations). */
  messageAgentStewardEnabled?: boolean
  /** Called after an identity file is written. Used to extract assistant name from SOUL.md. */
  onIdentityChanged?: (file: string, content: string) => void
  /** Called when Head queues a file for delivery to the user via send_file. */
  onFileQueued?: (att: import('../types/core.js').Attachment) => void
}

export class HeadToolExecutor implements ToolExecutor {
  constructor(private opts: HeadToolExecutorOptions) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const result = await this.dispatch(toolCall)
      if (typeof result === 'string') {
        return { toolCallId: toolCall.id, name: toolCall.name, content: result }
      }
      return { ...result, toolCallId: toolCall.id, name: toolCall.name }
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: JSON.stringify({ error: true, message: (err as Error).message ?? 'unknown error' }),
      }
    }
  }

  private async dispatch(toolCall: ToolCall): Promise<string | ToolResult> {
    const { name, input } = toolCall

    switch (name) {
      // ── Agent management ───────────────────────────────────────────────────
      case 'spawn_agent': {
        const spawnOpts: import('../types/agent.js').SpawnOptions = {
          prompt: input['prompt'] as string,
          name: input['name'] as string,
          trigger: 'manual',
          ...(this.opts.getHistory ? { headHistory: this.opts.getHistory() } : {}),
          ...(this.opts.onDebug ? { onDebug: this.opts.onDebug } : {}),
          ...(this.opts.onVerbose ? { onVerbose: this.opts.onVerbose } : {}),
          ...(this.opts.getAttachments ? { attachments: this.opts.getAttachments() } : {}),
        }
        const agentId = await this.opts.agentRunner.spawn(spawnOpts)
        timingMark('head.spawn_called', {
          sourceType: 'head',
          agent_id: agentId,
          skill_name: spawnOpts.name,
        })
        const note = this.opts.spawnAgentNote ?? 'Agent is running. End your response now — you will be activated again when the agent completes.'
        return JSON.stringify({ agentId, note })
      }

      case 'message_agent': {
        const agentId = input['agentId'] as string
        const message = input['message'] as string
        if (this.opts.agentStore) {
          const state = this.opts.agentStore.get(agentId)
          if (state?.status === 'failed' || state?.status === 'retracted') {
            return JSON.stringify({ error: true, message: `Agent ${agentId} is ${state.status} — it is no longer running. Check the tool_result for its output.` })
          }
          if (state?.status === 'completed' && !this.opts.agentContinuationEnabled) {
            return JSON.stringify({ error: true, message: `Agent ${agentId} is completed — it is no longer running. Check the tool_result for its output.` })
          }

          if (state?.status === 'completed') {
            // Continuation: validate the message is user-driven before resuming (gated by config)
            const task = state.task ?? ''
            if (this.opts.messageAgentStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecentText(4)
                .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt }))
              const pass = await runMessageAgentSteward(
                task, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent is completed. To continue it, the user must request continuation — don\'t resume agents unprompted.',
                })
              }
            }
          } else if (state?.status === 'suspended') {
            // Suspended agent — validate the answer is real before resuming (gated by config)
            const question = state.pendingQuestion ?? ''
            if (question && this.opts.resumeStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecent(this.opts.resumeStewardContextTokens ?? 4000)
                .filter((m): m is TextMessage => m.kind === 'text' && !m.injected)
                .map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt }))
              const pass = await runResumeSteward(
                question, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent needs a real answer from the user, not a placeholder. Ask the user for the information and call message_agent when you have their actual response.',
                })
              }
            }
          } else {
            // Running agent — reject unprompted check-ins (gated by config)
            const task = state?.task ?? ''
            if (this.opts.messageAgentStewardEnabled && this.opts.llmRouter && this.opts.stewardModel) {
              const recent = this.opts.messages.getRecentText(4)
                .map(m => ({ role: (m as TextMessage).role, content: (m as TextMessage).content, createdAt: m.createdAt }))
              const pass = await runMessageAgentSteward(
                task, message, recent,
                this.opts.llmRouter, this.opts.stewardModel,
                this.opts.usageStore,
              )
              if (!pass) {
                return JSON.stringify({
                  error: true,
                  message: 'The agent is still working. You\'ll be activated when it completes — no need to check in.',
                })
              }
            }
          }
        }
        await this.opts.agentRunner.update(agentId, message)
        return JSON.stringify({ ok: true })
      }

      case 'cancel_agent': {
        await this.opts.agentRunner.retract(input['agentId'] as string)
        return JSON.stringify({ ok: true })
      }

      case 'get_usage': {
        const since = input['since'] as string | undefined
        const summary = this.opts.usageStore.getSummary(since)
        return JSON.stringify({
          since: since ?? 'all-time',
          estimatedCostUsd: Number(summary.costUsd.toFixed(4)),
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          byModel: summary.byModel,
          bySourceType: summary.bySourceType,
          bySource: summary.bySource,
        })
      }

      // ── Identity ─────────────────────────────────────────────────────────────
      case 'list_identity_files': {
        return JSON.stringify(this.opts.identityLoader.listFiles())
      }

      case 'write_identity': {
        const file = input['file'] as string
        let content = input['content'] as string
        const baseName = path.basename(file)
        const knownFiles = this.opts.identityLoader.listFiles()
        if (!knownFiles.includes(baseName)) {
          return JSON.stringify({ error: true, message: `Identity file "${baseName}" does not exist. Use list_identity_files to see available files.` })
        }

        // Identity filter steward: strip skill-specific preferences from USER.md
        let rejected = ''
        if (baseName === 'USER.md' && content && this.opts.llmRouter) {
          const skills = this.opts.skillLoader.listAll()
          const skillList = skills.map(s => `- ${s.name}: ${s.frontmatter.description}`).join('\n')
          const result = await runIdentityFilterSteward(
            content, skillList,
            this.opts.llmRouter, this.opts.stewardModel ?? 'standard',
            this.opts.usageStore,
          )
          if (result && result.reject) {
            content = result.keep
            rejected = result.reject
          }
        }

        const filePath = path.join(this.opts.identityDir, baseName)
        const tempPath = path.join(this.opts.identityDir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.md`)
        await fs.promises.writeFile(tempPath, content, 'utf8')
        await fs.promises.rename(tempPath, filePath)
        if (baseName === 'SOUL.md' && this.opts.onIdentityChanged) {
          this.opts.onIdentityChanged(baseName, content)
        }

        if (rejected) {
          return JSON.stringify({
            ok: true,
            rejected,
            note: 'These preferences were removed from USER.md because they belong in the relevant skill\'s MEMORY.md. Spawn an agent with the skill to save them there.',
          })
        }
        return JSON.stringify({ ok: true })
      }

      // ── Vision ──────────────────────────────────────────────────────────────
      case 'view_image': {
        return executeViewImage(input)
      }

      // ── File delivery ──────────────────────────────────────────────────────
      case 'send_file': {
        const filePath = input['path'] as string
        if (!filePath) return JSON.stringify({ error: true, message: 'path is required' })
        const resolved = path.resolve(filePath)
        if (!fs.existsSync(resolved)) {
          return JSON.stringify({ error: true, message: `File not found: ${filePath}` })
        }
        const stat = fs.statSync(resolved)
        const ext = path.extname(resolved).toLowerCase()
        const mimeTypes: Record<string, string> = {
          '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
          '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip',
        }
        const mediaType = mimeTypes[ext] ?? 'application/octet-stream'
        const isImage = mediaType.startsWith('image/')
        const isAudio = mediaType.startsWith('audio/')
        const isVideo = mediaType.startsWith('video/')
        const attType = isImage ? 'image' as const : isAudio ? 'audio' as const : isVideo ? 'video' as const : 'document' as const
        const att: import('../types/core.js').Attachment = {
          type: attType, mediaType,
          filename: path.basename(resolved),
          path: resolved,
          size: stat.size,
        }
        this.opts.onFileQueued?.(att)
        return JSON.stringify({ ok: true, file: att.filename, size: `${(stat.size / 1024).toFixed(0)}KB` })
      }

      default:
        return JSON.stringify({ error: true, message: `Unknown tool: ${name}` })
    }
  }
}
