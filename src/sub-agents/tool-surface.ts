import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentToolEntry, AgentToolRegistry } from '../types/agent.js'
import type { SpawnOptions } from '../types/agent.js'
import type { Skill, SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'
import type { UsageStore } from '../db/usage.js'
import type { ScheduleStore } from '../db/schedules.js'
import type { NoteStore } from '../db/notes.js'
import type { AppStateStore } from '../db/app_state.js'
import { log } from '../logger.js'
import { formatIanaTimeLine } from '../util/time.js'
import { buildScopedEnv } from './env.js'
import { getOptionalTools, buildScopedBashTools, buildUsageTool, buildScheduleTools, buildReminderTools, buildNoteTools } from './registry.js'
import { truncateToolOutput } from './output-cap.js'

const BASH_TOOL_NAMES = new Set(['bash', 'bash_no_net'])

export interface AgentDefaults {
  env: string[] | null
  allowedTools: string[] | null
}

export interface ToolSurfaceDeps {
  skillLoader: SkillLoader
  /** Unified loader — passed through to create_schedule for kind validation.
   *  NEVER consumed by buildSkillsListing (ISO-01): the listing reads skillLoader
   *  exclusively so tasks stay structurally absent from the agent-visible surface. */
  unifiedLoader?: import('../skills/unified.js').UnifiedLoader
  skillsDir: string
  workspacePath: string | null
  tasksDir?: string
  identityLoader: IdentityLoader
  agentIdentityLoader: IdentityLoader
  toolRegistry: AgentToolRegistry
  mcpRegistry: McpRegistry
  usageStore: UsageStore
  scheduleStore: ScheduleStore | null
  noteStore: NoteStore | null
  appState: AppStateStore | null
  agentDefaults: AgentDefaults
  envOverrides: Record<string, string>
  /** When false, NO agent receives spawn_agent — byte-equivalent to pre-Milestone-1 behavior.
   *  When true, depth-1 agents (parentAgentId === null) receive spawn_agent; depth-2+ agents never do.
   *  See assembleTools below (CFG-02, NEST-02). */
  nestedAgentSpawningEnabled: boolean
  /** Max chars of agent-visible tool OUTPUT before middle-truncation. 0 = disabled. */
  toolOutputMaxChars: number
  /** IANA timezone (config.timezone). Used by:
   *  - The agent system-prompt "Current time:" line (Task 2 — human-readable localized).
   *  - create_schedule / create_reminder / update_schedule next-run cron computation
   *    so agent-created schedules fire in the user's zone (Task 1). */
  timezone: string
}

/** Build the system prompt for an agent, injecting the skills guide and any spawned skill's instructions. */
export function buildSystemPrompt(deps: ToolSurfaceDeps, _skill: Skill | null): string {
  // Load identity files but exclude SYSTEM.md — that file contains head-only
  // operational instructions (system events, activation flow) that confuse agents.
  const identityFiles = deps.identityLoader.listFiles().filter(f => f !== 'SYSTEM.md')
  const identityPrompt = identityFiles
    .sort()
    .map(f => deps.identityLoader.readFile(f)?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n---\n\n')

  let prompt = identityPrompt

  if (deps.workspacePath) {
    try {
      const ambient = fs.readFileSync(path.join(deps.workspacePath, 'AMBIENT.md'), 'utf8').trim()
      if (ambient) prompt += `\n\n## Ambient Context\n${ambient}`
    } catch { /* file doesn't exist yet — skip */ }
  }

  prompt += `\n\nCurrent time: ${formatIanaTimeLine(new Date(), deps.timezone)}`

  const listing = buildSkillsListing(deps)
  if (listing) prompt += `\n\n${listing}`

  if (deps.tasksDir) {
    const tasksBlurb = buildTasksBlurb(deps.tasksDir)
    if (tasksBlurb) prompt += `\n\n${tasksBlurb}`
  }

  const agentPrompt = deps.agentIdentityLoader.loadSystemPrompt()
  if (agentPrompt) prompt += `\n\n${agentPrompt}`

  return prompt
}

/** List directory entries in tree format, prioritizing SKILL.md and MEMORY.md. */
function listDirTree(dirPath: string, prefix: string): string[] {
  const MAX_SHOWN = 10
  const lines: string[] = []
  try {
    const all = fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).sort()
    const priority = all.filter(f => f === 'SKILL.md' || f === 'MEMORY.md')
    const rest = all.filter(f => f !== 'SKILL.md' && f !== 'MEMORY.md')
    const shown = [...priority, ...rest.slice(0, MAX_SHOWN - priority.length)]
    const truncated = all.length > MAX_SHOWN

    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i]!
      const isLast = i === shown.length - 1 && !truncated
      const connector = isLast ? '└── ' : '├── '
      const entryPath = path.join(dirPath, entry)
      let isDir = false
      try { isDir = fs.statSync(entryPath).isDirectory() } catch { continue }

      if (isDir && fs.existsSync(path.join(entryPath, 'SKILL.md'))) {
        lines.push(`${prefix}${connector}${entry}/`)
        const subPrefix = prefix + (isLast ? '    ' : '│   ')
        lines.push(...listDirTree(entryPath, subPrefix))
      } else if (isDir) {
        lines.push(`${prefix}${connector}${entry}/`)
      } else {
        lines.push(`${prefix}${connector}${entry}`)
      }
    }
    if (truncated) lines.push(`${prefix}└── ... and ${all.length - MAX_SHOWN} more items`)
  } catch { /* unreadable dir */ }
  return lines
}

function buildSkillsListing(deps: ToolSurfaceDeps): string | null {
  const allSkills = deps.skillLoader.listAll()
  if (allSkills.length === 0) return null

  const lines: string[] = [`$SHROK_SKILLS_DIR/ (${deps.skillsDir})`]
  for (let s = 0; s < allSkills.length; s++) {
    const skill = allSkills[s]!
    const skillDir = path.dirname(skill.path)
    const desc = skill.frontmatter.description ?? skill.name
    const isLastSkill = s === allSkills.length - 1
    const connector = isLastSkill ? '└── ' : '├── '
    const childPrefix = isLastSkill ? '    ' : '│   '
    lines.push(`${connector}${skill.name}/  # ${desc}`)
    lines.push(...listDirTree(skillDir, childPrefix))
  }

  return `## Skills\nRead SKILL.md for instructions. If MEMORY.md exists, it contains credentials and state from prior runs.\n\n${lines.join('\n')}`
}

export function buildTasksBlurb(tasksDir: string): string | null {
  try {
    fs.accessSync(tasksDir)
  } catch {
    return null
  }
  return `## Tasks\nPre-authored tasks live in ${tasksDir}/. To use a task, read its TASK.md — it contains the instructions for what the task does. Tasks may also have a MEMORY.md with state and credentials from prior runs.`
}

export interface AssembleToolsArgs {
  agentId: string
  options: SpawnOptions
  skill: Skill | null
}

export async function assembleTools(
  deps: ToolSurfaceDeps,
  args: AssembleToolsArgs,
): Promise<{ toolEntries: AgentToolEntry[]; failedMcpCapabilities: string[] }> {
  const { options } = args

  // spawn_agent is included iff:
  //   (a) the global nested-spawning flag is on, AND
  //   (b) this agent is top-level (no parentAgentId — head slot, proactive, or scheduled).
  // Condition (b) is the depth-2 hard cap per PROJECT.md Key Decisions — an agent that
  // already has a parent is a sub-agent and never sees spawn_agent regardless of the flag.
  // message_agent and cancel_agent remain sub-agent-forbidden via PARENT_ONLY_TOOLS because
  // they only make sense for an agent that itself spawned children (the head's slot).
  // Defense-in-depth: even if spawn_agent is hallucinated into a sub-agent's tool list,
  // the runtime check inside handleSpawnAgent at src/sub-agents/local.ts will still reject
  // it. See NEST-01..07, NEST-06, CFG-02.
  const PARENT_ONLY_TOOLS = new Set(['message_agent', 'cancel_agent'])
  const isSubAgent = !!options.parentAgentId
  const canSpawn = deps.nestedAgentSpawningEnabled && !isSubAgent
  const builtins = deps.toolRegistry.builtins().filter(t => {
    if (t.definition.name === 'spawn_agent') return canSpawn
    if (isSubAgent && PARENT_ONLY_TOOLS.has(t.definition.name)) return false
    return true
  })
  const tools = [...builtins]

  // 260414-112: skill-frontmatter trigger-tools / trigger-env were dropped;
  // tool/env surface is always derived from agentDefaults now. The per-skill
  // env-warn loop is gone with them.
  const allowedTools = deps.agentDefaults.allowedTools
  const effectiveEnv = deps.agentDefaults.env

  // 260414-3pk: skill `npm-deps` frontmatter + ensureSkillDeps auto-install removed.
  // Skills that need packages must declare them via normal npm install paths.

  // Scope bash tools when env is declared (null = unrestricted, [] = baseline only)
  const scopedEnv = effectiveEnv !== null ? buildScopedEnv(effectiveEnv) : null

  // Merge any runner-level env overrides (e.g. WORKSPACE_PATH for eval isolation).
  // When there are overrides and no skill-declared scoping, build a full-env dict so
  // the overrides are visible to bash without dropping any real env vars.
  const hasOverrides = Object.keys(deps.envOverrides).length > 0
  const effectiveBashEnv: Record<string, string> | null = hasOverrides
    ? { ...(scopedEnv ?? process.env as Record<string, string>), ...deps.envOverrides }
    : scopedEnv

  // Collect all MCP tools upfront — needed for both restricted and unrestricted agents
  const allMcpTools: AgentToolEntry[] = []
  const failedMcpCapabilities: string[] = []
  const mcpCap = deps.toolOutputMaxChars
  for (const capability of deps.mcpRegistry.listCapabilities()) {
    try {
      const loaded = await deps.mcpRegistry.loadTools(capability)
      // Post-process wrap: cap every agent-visible MCP tool output. This is the
      // single MCP chokepoint covering BOTH stdio and HTTP transports without
      // modifying src/mcp/registry.ts or src/sub-agents/mcp-stdio.ts.
      const capped: AgentToolEntry[] = mcpCap > 0
        ? loaded.map(entry => ({
            definition: entry.definition,
            execute: async (input, ctx) => {
              const result = await entry.execute(input, ctx)
              return typeof result === 'string'
                ? truncateToolOutput(result, mcpCap, 'mcp tool output')
                : result
            },
          }))
        : loaded
      allMcpTools.push(...capped)
    } catch (err) {
      log.warn(`[agent] MCP capability ${capability} unavailable:`, (err as Error).message)
      failedMcpCapabilities.push(capability)
    }
  }

  const usageTool = buildUsageTool(deps.usageStore)
  const scheduleTools = deps.scheduleStore ? buildScheduleTools(deps.scheduleStore, deps.timezone, deps.unifiedLoader ?? null) : []
  const remindersTasksDir = deps.workspacePath
    ? path.join(deps.workspacePath, 'reminders')
    : null
  const reminderTools = (deps.scheduleStore && remindersTasksDir)
    ? buildReminderTools(deps.scheduleStore, remindersTasksDir, deps.timezone)
    : []
  const noteTools = deps.noteStore ? buildNoteTools(deps.noteStore) : []

  if (allowedTools) {
    // Skill declares an explicit tool allowlist — applies to optional, MCP, and skill tools.
    const allowedSet = new Set(allowedTools)
    const registryNames = allowedTools.filter(t => t !== 'get_usage')
    const optionalEntries = deps.toolRegistry.resolveOptional(registryNames, deps.toolOutputMaxChars)
    if (effectiveBashEnv) {
      tools.push(...optionalEntries.filter(t => !BASH_TOOL_NAMES.has(t.definition.name)))
      tools.push(...buildScopedBashTools(effectiveBashEnv, deps.toolOutputMaxChars).filter(t => allowedSet.has(t.definition.name)))
    } else {
      tools.push(...optionalEntries)
    }
    if (allowedSet.has('get_usage')) tools.push(usageTool)
    tools.push(...allMcpTools.filter(t => allowedSet.has(t.definition.name)))
    tools.push(...scheduleTools.filter(t => allowedSet.has(t.definition.name)))
    tools.push(...reminderTools.filter(t => allowedSet.has(t.definition.name)))
    tools.push(...noteTools.filter(t => allowedSet.has(t.definition.name)))
  } else {
    // No restriction — include all optional, MCP, and note tools
    const allOptional = getOptionalTools(deps.toolOutputMaxChars)
    if (effectiveBashEnv) {
      tools.push(...allOptional.filter(t => !BASH_TOOL_NAMES.has(t.definition.name)))
      tools.push(...buildScopedBashTools(effectiveBashEnv, deps.toolOutputMaxChars))
    } else {
      tools.push(...allOptional)
    }
    tools.push(usageTool)
    tools.push(...scheduleTools)
    tools.push(...reminderTools)
    tools.push(...noteTools)
    tools.push(...allMcpTools)
  }

  return { toolEntries: tools, failedMcpCapabilities }
}
