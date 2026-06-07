/**
 * Phase 46 Plan 02 — Enforcement tests.
 *
 * Two layers proven:
 *  1. HEAD filtering (TOOLCFG-05/07): the filter expression computed in buildSystem
 *     correctly gates the HEAD_TOOLS surface offered to the activation loop.
 *  2. AGENT threading (TOOLCFG-06/07): the resolved per-head agent allowlist,
 *     threaded into agentDefaults.allowedTools, reaches assembleTools and gates
 *     the assembled tool surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { resolveAllowlist } from '../sub-agents/tool-access.js'
import { HEAD_TOOLS } from './index.js'
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
// Assert the filter expression: resolvedHeadTools === null ? HEAD_TOOLS : HEAD_TOOLS.filter(...)

describe('HEAD tool filtering (TOOLCFG-05/07)', () => {
  it('override absent + global default absent → resolveAllowlist returns null → full HEAD_TOOLS offered', () => {
    // No per-head override, no global default → everything-on default (TOOLCFG-07)
    const resolved = resolveAllowlist(undefined, undefined)
    expect(resolved).toBeNull()
    const effective = resolved === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolved.includes(t.name))
    // Full HEAD_TOOLS offered
    expect(effective).toBe(HEAD_TOOLS)
    // Core orchestration tools are present — no guardrail (TOOLCFG-07)
    const names = effective.map(t => t.name)
    expect(names).toContain('spawn_agent')
    expect(names).toContain('message_agent')
    expect(names).toContain('cancel_agent')
  })

  it('override = [write_identity, get_usage] → only those two HEAD_TOOLS offered; spawn_agent absent', () => {
    const override = ['write_identity', 'get_usage']
    const globalDefault = null // all tools
    const resolved = resolveAllowlist(override, globalDefault)
    // Per-head override wins — returns the override array
    expect(resolved).toEqual(['write_identity', 'get_usage'])
    const effective = resolved === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolved.includes(t.name))
    const names = effective.map(t => t.name)
    expect(names).toContain('write_identity')
    expect(names).toContain('get_usage')
    expect(names).not.toContain('spawn_agent')  // core tool genuinely removable (TOOLCFG-07)
    expect(names).not.toContain('message_agent')
    expect(names).not.toContain('cancel_agent')
    expect(effective.length).toBe(2)
  })

  it('override absent + global default = [spawn_agent] → only spawn_agent offered', () => {
    // No per-head override, but global head default restricts to spawn_agent
    const resolved = resolveAllowlist(undefined, ['spawn_agent'])
    expect(resolved).toEqual(['spawn_agent'])
    const effective = resolved === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolved.includes(t.name))
    const names = effective.map(t => t.name)
    expect(names).toContain('spawn_agent')
    expect(names).not.toContain('write_identity')
    expect(names).not.toContain('get_usage')
    expect(effective.length).toBe(1)
  })

  it('per-head override = null (all tools) overrides a restrictive global default', () => {
    // null means "all tools" — overrides even a restrictive global
    const resolved = resolveAllowlist(null, ['spawn_agent'])
    expect(resolved).toBeNull()
    const effective = resolved === null ? HEAD_TOOLS : HEAD_TOOLS.filter(t => resolved.includes(t.name))
    // All HEAD_TOOLS offered
    expect(effective).toBe(HEAD_TOOLS)
    const names = effective.map(t => t.name)
    expect(names).toContain('spawn_agent')
    expect(names).toContain('write_identity')
  })
})

// ─── AGENT threading tests (TOOLCFG-06 / TOOLCFG-07) ────────────────────────
// Drive assembleTools with agentDefaults set to the output of resolveAllowlist.

describe('AGENT tool threading (TOOLCFG-06/07)', () => {
  let tmp: string
  let skillsDir: string
  let skillsLoader: FileSystemKindLoader
  let unifiedLoader: UnifiedLoader

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

  it('per-head override = [bash] against global = null → bash present, web_search absent', async () => {
    // resolveAllowlist([bash], null) = [bash] — per-head override wins
    const resolvedAllowlist = resolveAllowlist(['bash'], null)
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

  it('per-head override absent + global = [get_usage] → get_usage present, bash absent', async () => {
    // resolveAllowlist(undefined, [get_usage]) = [get_usage] — global default applies
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

  it('both absent (null result) → unrestricted — representative optional tool present (TOOLCFG-07)', async () => {
    // resolveAllowlist(undefined, undefined) = null — all tools
    const resolvedAllowlist = resolveAllowlist(undefined, undefined)
    expect(resolvedAllowlist).toBeNull()
    const deps = makeDeps({
      agentDefaults: { env: null, allowedTools: resolvedAllowlist },
    })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'test-agent',
      options: { prompt: 'test', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    const names = toolEntries.map(e => e.definition.name)
    // With no restrictions, optional tools should be present
    expect(names).toContain('web_search')
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
  })
})
