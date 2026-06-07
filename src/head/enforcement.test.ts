/**
 * Phase 46 Plan 05 — Enforcement tests (reshaped for two-state model).
 *
 * Two layers proven:
 *  1. HEAD filtering (TOOLCFG-05/07): resolveAllowlist + HEAD_TOOLS.filter correctly
 *     gates the head tool surface (no null/all branch in the feature path).
 *  2. AGENT threading (TOOLCFG-06/07): the resolved per-head agent allowlist,
 *     threaded into agentDefaults.allowedTools, reaches assembleTools and gates
 *     the assembled tool surface.
 *
 * Key contract changes from Plan 02 (two-state D-04):
 *  - resolveAllowlist always returns string[] (never null).
 *  - The head "everything-on" default is the 10 HEAD_TOOL_NAMES passed as globalDefault.
 *  - Legacy null normalized to fall-through (D-05); no test asserts null = all tools.
 *  - assembleTools' if (allowedTools) gate: an array (even the 25-tool set) restricts
 *    to the named tools; null disables restriction. The production path always supplies
 *    a concrete array (from base config.json or HEAD_TOOL_NAMES), never null.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { resolveAllowlist } from '../sub-agents/tool-access.js'
import { HEAD_TOOLS, HEAD_TOOL_NAMES } from './index.js'
import { assembleTools, type ToolSurfaceDeps } from '../sub-agents/tool-surface.js'
import { AgentToolRegistryImpl } from '../sub-agents/registry.js'
import { FileSystemKindLoader } from '../skills/loader.js'
import { UnifiedLoader } from '../skills/unified.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { UsageStore } from '../db/usage.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'

const MIGRATIONS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../sql')

// ─── HEAD filtering tests (TOOLCFG-05 / TOOLCFG-07) ─────────────────────────
// Assert the two-state filter: HEAD_TOOLS.filter(t => resolvedHeadTools.includes(t.name))
// (no null/all branch — resolveAllowlist always returns string[])

describe('HEAD tool filtering (TOOLCFG-05/07) — two-state', () => {
  it('no-config head: resolveAllowlist(undefined, HEAD_TOOL_NAMES) → all 10 HEAD_TOOLS offered', () => {
    // The pre-feature default is HEAD_TOOL_NAMES (10 names). No per-head override.
    // This is what buildSystem computes for a no-config head (TOOLCFG-07).
    const resolved = resolveAllowlist(undefined, HEAD_TOOL_NAMES)
    expect(resolved).toEqual(HEAD_TOOL_NAMES)
    expect(resolved.length).toBe(10)
    const effective = HEAD_TOOLS.filter(t => resolved.includes(t.name))
    // All 10 HEAD_TOOLS offered (same as the pre-feature default)
    expect(effective.length).toBe(10)
    const names = effective.map(t => t.name)
    // Core orchestration tools fully present — no guardrail (TOOLCFG-07)
    expect(names).toContain('spawn_agent')
    expect(names).toContain('message_agent')
    expect(names).toContain('cancel_agent')
    // Edge tool also present
    expect(names).toContain('ring_device')
  })

  it('per-head override = [write_identity, get_usage] → only those 2 offered; spawn_agent absent', () => {
    // Per-head override wins over global default. Core tools genuinely removable (TOOLCFG-07).
    const override = ['write_identity', 'get_usage']
    const resolved = resolveAllowlist(override, HEAD_TOOL_NAMES)
    expect(resolved).toEqual(['write_identity', 'get_usage'])
    const effective = HEAD_TOOLS.filter(t => resolved.includes(t.name))
    const names = effective.map(t => t.name)
    expect(names).toContain('write_identity')
    expect(names).toContain('get_usage')
    expect(names).not.toContain('spawn_agent')  // core tool genuinely removable
    expect(names).not.toContain('message_agent')
    expect(names).not.toContain('cancel_agent')
    expect(effective.length).toBe(2)
  })

  it('per-head override absent + global head default = [spawn_agent] → only spawn_agent offered', () => {
    // No per-head override; global head default restricts to spawn_agent only.
    const resolved = resolveAllowlist(undefined, ['spawn_agent'])
    expect(resolved).toEqual(['spawn_agent'])
    const effective = HEAD_TOOLS.filter(t => resolved.includes(t.name))
    const names = effective.map(t => t.name)
    expect(names).toContain('spawn_agent')
    expect(names).not.toContain('write_identity')
    expect(names).not.toContain('get_usage')
    expect(effective.length).toBe(1)
  })

  it('legacy null override (D-05) normalized to fall-through → global default used, NOT all tools', () => {
    // null is tolerated but normalized to fall-through — does NOT mean "all tools".
    // Legacy null on per-head override → inherits global (HEAD_TOOL_NAMES = 10 tools).
    const resolved = resolveAllowlist(null, ['spawn_agent'])
    // null override falls through → global default wins (not a null-means-all state)
    expect(resolved).toEqual(['spawn_agent'])
    const effective = HEAD_TOOLS.filter(t => resolved.includes(t.name))
    expect(effective.length).toBe(1)
    expect(effective[0]?.name).toBe('spawn_agent')
  })
})

// ─── AGENT threading tests (TOOLCFG-06 / TOOLCFG-07) ────────────────────────
// Drive assembleTools with agentDefaults set to the output of resolveAllowlist.

describe('AGENT tool threading (TOOLCFG-06/07) — two-state', () => {
  let tmp: string
  let skillsDir: string
  let skillsLoader: FileSystemKindLoader
  let unifiedLoader: UnifiedLoader

  // The 25-tool base set from base config.json (TOOLCFG-07)
  const BASE_25_TOOLS = [
    'bash', 'read_file', 'read_multiple_files', 'view_image', 'write_file', 'edit_file',
    'create_directory', 'list_directory', 'directory_tree', 'move_file', 'search_files',
    'get_file_info', 'web_fetch', 'web_search', 'write_note', 'read_note', 'list_notes',
    'search_notes', 'delete_note', 'create_reminder', 'list_reminders', 'cancel_reminder',
    'create_schedule', 'list_schedules', 'delete_schedule',
  ]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enforcement-test-'))
    skillsDir = path.join(tmp, 'skills')
    const tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(skillsDir, 'dummy'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, 'dummy', 'SKILL.md'),
      `---\nname: dummy\ndescription: dummy skill\n---\nBody.`
    )
    fs.mkdirSync(tasksDir, { recursive: true })
    skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    unifiedLoader = new UnifiedLoader(skillsLoader, tasksLoader)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function makeDeps(overrides: Partial<ToolSurfaceDeps> = {}): ToolSurfaceDeps {
    const db = initDb(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    const usageStore = new UsageStore(db, 'UTC')
    const identityLoader: IdentityLoader = {
      loadSystemPrompt: vi.fn().mockReturnValue(''),
      listFiles: vi.fn().mockReturnValue([]),
      readFile: vi.fn().mockReturnValue(null),
    }
    const agentIdentityLoader: IdentityLoader = {
      loadSystemPrompt: vi.fn().mockReturnValue(''),
      listFiles: vi.fn().mockReturnValue([]),
      readFile: vi.fn().mockReturnValue(null),
    }
    const mcpRegistry: McpRegistry = {
      listCapabilities: vi.fn().mockReturnValue([]),
      loadTools: vi.fn().mockResolvedValue([]),
    }
    return {
      skillLoader: skillsLoader as unknown as SkillLoader,
      headId: 'default',
      unifiedLoader,
      skillsDir,
      workspacePath: null,
      identityLoader,
      agentIdentityLoader,
      toolRegistry: new AgentToolRegistryImpl(),
      mcpRegistry,
      usageStore,
      scheduleStore: null,
      noteStore: null,
      appState: null,
      agentDefaults: { env: null, allowedTools: null },
      envOverrides: {},
      nestedAgentSpawningEnabled: true,
      toolOutputMaxChars: 0,
      timezone: 'UTC',
      ...overrides,
    }
  }

  it('per-head agent override = [bash] → bash present, web_search absent', async () => {
    // resolveAllowlist(['bash'], BASE_25_TOOLS) = ['bash'] — per-head override wins
    const resolvedAllowlist = resolveAllowlist(['bash'], BASE_25_TOOLS)
    expect(resolvedAllowlist).toEqual(['bash'])
    const deps = makeDeps({
      agentDefaults: { env: null, allowedTools: resolvedAllowlist },
    })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'test-agent',
      options: { prompt: 'test', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    const names = toolEntries.map(e => e.definition.name)
    expect(names).toContain('bash')
    expect(names).not.toContain('web_search')
  })

  it('per-head agent override absent + global = [get_usage] → get_usage present, bash absent', async () => {
    // resolveAllowlist(undefined, ['get_usage']) = ['get_usage'] — global default applies
    const resolvedAllowlist = resolveAllowlist(undefined, ['get_usage'])
    expect(resolvedAllowlist).toEqual(['get_usage'])
    const deps = makeDeps({
      agentDefaults: { env: null, allowedTools: resolvedAllowlist },
    })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'test-agent',
      options: { prompt: 'test', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    const names = toolEntries.map(e => e.definition.name)
    expect(names).toContain('get_usage')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('web_search')
  })

  it('no-config agent layer: global = BASE_25_TOOLS → resolves to that array; bash and read_file present', async () => {
    // Production flow: resolveAllowlist(undefined, workerDefaults.allowedTools) where
    // workerDefaults.allowedTools is the 25-tool array from base config.json (TOOLCFG-07).
    // Note: in the test, noteStore=null and scheduleStore=null, so note/reminder/schedule
    // tools are not assembled even if in the allowlist. This test asserts the registry tools
    // that ARE available (bash, read_file, web_search) to confirm the allowlist threads correctly.
    const resolvedAllowlist = resolveAllowlist(undefined, BASE_25_TOOLS)
    expect(resolvedAllowlist).toEqual(BASE_25_TOOLS)
    expect(resolvedAllowlist.length).toBe(25)
    const deps = makeDeps({
      agentDefaults: { env: null, allowedTools: resolvedAllowlist },
    })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'test-agent',
      options: { prompt: 'test', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    const names = toolEntries.map(e => e.definition.name)
    // Core registry tools from BASE_25_TOOLS that assembleTools can fulfill without stores
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    // The resolved allowlist drives restriction — tools not in BASE_25_TOOLS are absent
    // (get_usage is NOT in the 25-tool agent set — it is a head tool, TOOLCFG-07)
    expect(names).not.toContain('get_usage')
  })
})
