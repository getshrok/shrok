import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileSystemKindLoader } from '../skills/loader.js'
import { UnifiedLoader } from '../skills/unified.js'
import { assembleTools, buildSystemPrompt, type ToolSurfaceDeps } from './tool-surface.js'
import { AgentToolRegistryImpl } from './registry.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { UsageStore } from '../db/usage.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'

const MIGRATIONS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../sql')

/**
 * ISO-01 regression lock.
 *
 * The architectural guarantee: buildSkillsListing only consumes
 * `deps.skillLoader`, which is the skills-only FileSystemKindLoader
 * instance. Tasks live under a separate root and are structurally absent
 * from that loader's view.
 *
 * Sub-skill enumeration (ISO-04) is removed entirely — see guard #3 below.
 */

describe('tool-surface ISO-01 enforcement', () => {
  let tmp: string
  let skillsDir: string
  let tasksDir: string
  let skillsLoader: FileSystemKindLoader
  let unifiedLoader: UnifiedLoader

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-surface-iso-'))
    skillsDir = path.join(tmp, 'skills')
    tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(skillsDir, 'foo'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, 'foo', 'SKILL.md'),
      `---\nname: foo\ndescription: the foo skill\n---\nFoo body.`
    )

    fs.mkdirSync(path.join(tasksDir, 'bar'), { recursive: true })
    fs.writeFileSync(
      path.join(tasksDir, 'bar', 'TASK.md'),
      `---\nname: bar\ndescription: the bar task\n---\nBar task body.`
    )

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

  it('buildSystemPrompt skills listing includes skills but NEVER tasks (ISO-01)', () => {
    const deps = makeDeps()
    const prompt = buildSystemPrompt(deps, null)
    expect(prompt).toContain('foo/')
    expect(prompt).toContain('the foo skill')
    expect(prompt).not.toContain('bar')
    expect(prompt).not.toContain('the bar task')
  })

  it('source audit: tool-surface.ts has no references to unifiedLoader in listing code paths', () => {
    // Architectural guard (cheap source grep). ISO-01 is a structural
    // guarantee: buildSkillsListing must read deps.skillLoader only.
    const source = fs.readFileSync(path.resolve('src/sub-agents/tool-surface.ts'), 'utf8')
    // Only the ToolSurfaceDeps field declaration and the create_schedule
    // wiring line may mention unifiedLoader. buildSkillsListing must not touch it.
    const listingBlock = source.slice(source.indexOf('function buildSkillsListing'), source.indexOf('function buildSkillsListing') + 1200)
    expect(listingBlock).not.toContain('unifiedLoader')
  })

  it('source audit: tool-surface.ts has no runSubSkill or subSkills references (guard #3)', () => {
    const source = fs.readFileSync(path.resolve('src/sub-agents/tool-surface.ts'), 'utf8')
    expect(source).not.toMatch(/runSubSkill/)
    expect(source).not.toMatch(/\.subSkills/)
  })
})
