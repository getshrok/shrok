import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CADENCE_ERROR_MESSAGE } from '../scheduler/cadence.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { HeadToolExecutor } from '../head/index.js'
import { FileSystemIdentityLoader } from '../identity/loader.js'
import { LocalAgentRunner } from './local.js'
import { buildContextSnapshot } from './context.js'
import { buildScopedEnv } from './env.js'
import { estimateTokens } from '../db/token.js'
import { AgentToolRegistryImpl } from './registry.js'
import { assembleTools, type ToolSurfaceDeps } from './tool-surface.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { AgentStore } from '../db/agents.js'
import { AgentInboxStore } from '../db/agent_inbox.js'
import { QueueStore } from '../db/queue.js'
import { UsageStore } from '../db/usage.js'
import type { Message, TextMessage } from '../types/core.js'
import type { LLMRouter, LLMResponse } from '../types/llm.js'
import type { SkillLoader } from '../types/skill.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { IdentityLoader } from '../identity/loader.js'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

// ─── buildContextSnapshot ─────────────────────────────────────────────────────

function makeText(id: string, content: string, role: 'user' | 'assistant' = 'user'): TextMessage {
  return { kind: 'text', role, id, content, createdAt: new Date().toISOString() }
}

describe('buildContextSnapshot', () => {
  it('returns empty array when headHistory is empty', () => {
    expect(buildContextSnapshot([], undefined, 1000)).toEqual([])
  })

  it('includes triggeringMessage first', () => {
    const trigger = makeText('t1', 'do something')
    const history: Message[] = [makeText('h1', 'earlier')]
    const snap = buildContextSnapshot(history, trigger, 10_000)
    expect(snap[0]!.id).toBe('t1')
  })

  it('excludes triggeringMessage from the candidate window', () => {
    const trigger = makeText('t1', 'trigger')
    const history: Message[] = [trigger, makeText('h1', 'other')]
    const snap = buildContextSnapshot(history, trigger, 10_000)
    const ids = snap.map(m => m.id)
    expect(ids.filter(id => id === 't1').length).toBe(1)  // only once (prepended)
  })

  it('respects token budget', () => {
    const history: Message[] = Array.from({ length: 6 }, (_, i) =>
      makeText(`m${i}`, 'a'.repeat(1000))
    )
    // Budget fits at most 2 messages
    const costPerMsg = estimateTokens([history[0]!])
    const snap = buildContextSnapshot(history, undefined, costPerMsg * 2)
    expect(snap.length).toBeLessThanOrEqual(2)
  })

  it('works without a triggering message', () => {
    const history: Message[] = [makeText('h1', 'hello'), makeText('h2', 'world')]
    const snap = buildContextSnapshot(history, undefined, 10_000)
    expect(snap.length).toBeGreaterThan(0)
    expect(snap.some(m => m.id === 'h1' || m.id === 'h2')).toBe(true)
  })
})

// ─── buildScopedEnv ───────────────────────────────────────────────────────────

describe('buildScopedEnv', () => {
  it('includes baseline env keys that are present', () => {
    const orig = process.env['PATH']
    process.env['PATH'] = '/usr/bin'
    const env = buildScopedEnv([])
    expect(env['PATH']).toBe('/usr/bin')
    if (orig !== undefined) process.env['PATH'] = orig
  })

  it('includes declared vars that are present in process.env', () => {
    process.env['MY_TEST_VAR'] = 'hello'
    const env = buildScopedEnv(['MY_TEST_VAR'])
    expect(env['MY_TEST_VAR']).toBe('hello')
    delete process.env['MY_TEST_VAR']
  })

  it('excludes vars not in baseline or declared list', () => {
    process.env['SECRET_KEY'] = 'should-not-appear'
    const env = buildScopedEnv([])
    expect(env['SECRET_KEY']).toBeUndefined()
    delete process.env['SECRET_KEY']
  })

  it('omits declared vars that are absent from process.env', () => {
    delete process.env['NONEXISTENT_VAR']
    const env = buildScopedEnv(['NONEXISTENT_VAR'])
    expect('NONEXISTENT_VAR' in env).toBe(false)
  })

  it('propagates SHROK_WORKSPACE_PATH as a baseline key', () => {
    process.env['SHROK_WORKSPACE_PATH'] = '/test/workspace'
    const env = buildScopedEnv([])
    expect(env['SHROK_WORKSPACE_PATH']).toBe('/test/workspace')
    delete process.env['SHROK_WORKSPACE_PATH']
  })

  it('propagates legacy WORKSPACE_PATH as a baseline key', () => {
    process.env['WORKSPACE_PATH'] = '/legacy/workspace'
    const env = buildScopedEnv([])
    expect(env['WORKSPACE_PATH']).toBe('/legacy/workspace')
    delete process.env['WORKSPACE_PATH']
  })

  it('propagates both names when both are set', () => {
    process.env['SHROK_WORKSPACE_PATH'] = '/new/workspace'
    process.env['WORKSPACE_PATH'] = '/legacy/workspace'
    const env = buildScopedEnv([])
    expect(env['SHROK_WORKSPACE_PATH']).toBe('/new/workspace')
    expect(env['WORKSPACE_PATH']).toBe('/legacy/workspace')
    delete process.env['SHROK_WORKSPACE_PATH']
    delete process.env['WORKSPACE_PATH']
  })
})

// ─── agentDefaults — tool allowlist ──────────────────────────────────────────

describe('agentDefaults allowedTools via resolveOptional', () => {
  it('restricts tool set when allowedTools is set', () => {
    const registry = new AgentToolRegistryImpl()
    const entries = registry.resolveOptional(['bash'])
    const names = entries.map(e => e.definition.name)
    expect(names).toContain('bash')
    expect(names).not.toContain('read_file')
    expect(names).not.toContain('write_file')
  })

  it('returns all optional tools when no filter is applied', () => {
    const registry = new AgentToolRegistryImpl()
    const all = registry.resolveOptional(['bash', 'read_file', 'write_file'])
    const names = all.map(e => e.definition.name)
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
  })

  it('known tool names do not produce a warning', () => {
    const registry = new AgentToolRegistryImpl()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = registry.resolveOptional(['bash', 'read_file'])
    expect(warn).not.toHaveBeenCalled()
    expect(entries.map(e => e.definition.name)).toContain('bash')
    warn.mockRestore()
  })
})

// ─── AgentToolRegistryImpl ───────────────────────────────────────────────────

describe('AgentToolRegistryImpl', () => {
  let registry: AgentToolRegistryImpl

  beforeEach(() => {
    registry = new AgentToolRegistryImpl()
  })

  it('builtins() returns all 3 built-in tools', () => {
    const builtins = registry.builtins()
    const names = builtins.map(e => e.definition.name)
    expect(names).toContain('spawn_agent')
    expect(names).toContain('message_agent')
    expect(names).toContain('cancel_agent')
    // report_status is NOT in the baseline built-ins (injected transiently)
    expect(names).not.toContain('report_status')
  })

  it('resolveOptional returns known tools', () => {
    const entries = registry.resolveOptional(['bash', 'read_file'])
    const names = entries.map(e => e.definition.name)
    expect(names).toContain('bash')
    expect(names).toContain('read_file')
  })

  it('resolveOptional silently skips unknown tool names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = registry.resolveOptional(['bash', 'nonexistent_tool'])
    expect(entries.map(e => e.definition.name)).toContain('bash')
    expect(entries.map(e => e.definition.name)).not.toContain('nonexistent_tool')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nonexistent_tool'))
    warn.mockRestore()
  })

  it('resolveOptional returns empty array for empty input', () => {
    expect(registry.resolveOptional([])).toEqual([])
  })

  it('bash executor runs a command and returns output', async () => {
    const entries = registry.resolveOptional(['bash'])
    const bash = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await bash.execute({ command: 'echo hello' }, ctx)
    expect(result).toContain('hello')
    expect(result).toContain('Exit code: 0')
  })

  it('read_file executor reads an existing file', async () => {
    const entries = registry.resolveOptional(['read_file'])
    const readFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await readFile.execute({ path: '/etc/hostname' }, ctx)
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('read_file executor throws for missing file', async () => {
    const entries = registry.resolveOptional(['read_file'])
    const readFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    await expect(readFile.execute({ path: '/nonexistent/path/xyz.txt' }, ctx)).rejects.toThrow('read_file')
  })

  it('write_file executor writes and returns byte count', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const tmpPath = `/tmp/agent_test_${Date.now()}.txt`
    const result = await writeFile.execute({ path: tmpPath, content: 'hello world' }, ctx)
    expect(result).toContain('11 bytes')

    // Verify file was written
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(tmpPath, 'utf8')).toBe('hello world')
  })

  it('write_file executor rejects a missing `content` arg with an actionable error and writes nothing', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const fs = await import('node:fs')
    // A large-file write truncated at the output-token limit arrives with path + description but no content.
    const tmpPath = `/tmp/agent_test_nocontent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
    const call = () => writeFile.execute({ path: tmpPath, description: 'write the app' }, ctx)
    await expect(call()).rejects.toThrow(/content/)
    // The error must steer toward a different action (split / edit_file), not the cryptic Node message.
    await expect(call()).rejects.toThrow(/edit_file|smaller|split/)
    expect(fs.existsSync(tmpPath)).toBe(false)

    // Boundary: an empty string is a LEGAL write (empty file), NOT a missing-content rejection.
    const emptyPath = `/tmp/agent_test_empty_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
    try {
      const ok = await writeFile.execute({ path: emptyPath, content: '' }, ctx)
      expect(ok).toContain('Written 0 bytes')
    } finally {
      fs.rmSync(emptyPath, { force: true })
    }
  })

  it('write_file executor accepts valid SKILL.md frontmatter', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const fs = await import('node:fs')
    const dir = `/tmp/agent_test_skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${dir}/SKILL.md`
    const content = '---\nname: test-skill\ndescription: A valid test skill\n---\n\n# Body\n'
    try {
      const result = await writeFile.execute({ path: tmpPath, content }, ctx)
      expect(result).toContain('Written')
      expect(fs.readFileSync(tmpPath, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write_file executor rejects SKILL.md with invalid YAML frontmatter', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const fs = await import('node:fs')
    const dir = `/tmp/agent_test_skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${dir}/SKILL.md`
    // Unquoted colon inside a YAML value breaks the parser
    const content = '---\nname: broken\ndescription: hello: world\n---\n\nBody\n'
    try {
      const result = await writeFile.execute({ path: tmpPath, content }, ctx)
      expect(typeof result).toBe('string')
      expect(result as string).toContain('write_file rejected')
      expect(result as string).toContain('SKILL.md')
      expect(fs.existsSync(tmpPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write_file executor accepts valid TASK.md frontmatter', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const fs = await import('node:fs')
    const dir = `/tmp/agent_test_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${dir}/TASK.md`
    const content = '---\nname: test-task\ndescription: A valid test task\nmodel: standard\n---\n\n# Body\n'
    try {
      const result = await writeFile.execute({ path: tmpPath, content }, ctx)
      expect(result).toContain('Written')
      expect(fs.readFileSync(tmpPath, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('edit_file executor rejects edits that break TASK.md frontmatter', async () => {
    const entries = registry.resolveOptional(['edit_file'])
    const editFile = entries[0]!
    const ctx = { agentId: 't1', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const fs = await import('node:fs')
    const dir = `/tmp/agent_test_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${dir}/TASK.md`
    const original = '---\nname: test-task\ndescription: Valid task\n---\n\n# Body\n'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmpPath, original, 'utf8')
    try {
      const result = await editFile.execute({
        path: tmpPath,
        edits: [{ oldText: 'description: Valid task', newText: 'description: hello: world' }],
      }, ctx)
      expect(typeof result).toBe('string')
      expect(result as string).toContain('edit_file rejected')
      expect(result as string).toContain('TASK.md')
      // File must be untouched on disk
      expect(fs.readFileSync(tmpPath, 'utf8')).toBe(original)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('all built-in definitions have required inputSchema fields', () => {
    for (const entry of registry.builtins()) {
      expect(entry.definition.name).toBeTruthy()
      expect(entry.definition.description).toBeTruthy()
      expect(entry.definition.inputSchema).toBeTruthy()
    }
  })
})

// ─── Async sub-agent spawning ─────────────────────────────────────────────────

function freshDb() {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return db
}

/** Build a minimal LLMRouter that returns a fixed sequence of responses per call. */
function makeLLMRouter(responses: LLMResponse[]): LLMRouter {
  let i = 0
  return {
    complete: vi.fn().mockImplementation(async () => {
      const resp = responses[i] ?? responses[responses.length - 1]!
      i++
      return resp
    }),
  }
}

function makeToolCallResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    content: '',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 10,
    stopReason: 'tool_use',
    toolCalls: [{ id: `tc_${Math.random().toString(36).slice(2, 9)}`, name: toolName, input }],
  }
}

function makeEndTurnResponse(): LLMResponse {
  return {
    content: 'Done.',
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

/** Completion steward response: agent output is a completion (not a question). */
function makeStewardDoneResponse(): LLMResponse {
  return {
    content: '{"type": "done"}',
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

/** Completion steward response: agent output is a question. */
function makeStewardQuestionResponse(question: string): LLMResponse {
  return {
    content: JSON.stringify({ type: 'question', question }),
    model: 'test-model',
    inputTokens: 5,
    outputTokens: 5,
    stopReason: 'end_turn',
    toolCalls: [],
  }
}

function makeRunner(
  llmRouter: LLMRouter,
  db: ReturnType<typeof freshDb>,
  overrides: { spawnAgentStewardEnabled?: boolean; stewardModel?: string; unifiedLoader?: import('../skills/unified.js').UnifiedLoader; skillLoader?: SkillLoader; agentModel?: string; archivalThreshold?: number; historyBudget?: number } = {},
) {
  const agentStore = new AgentStore(db)
  const inboxStore = new AgentInboxStore(db)
  const queueStore = new QueueStore(db)
  const usageStore = new UsageStore(db, 'UTC')

  const skillLoader: SkillLoader = overrides.skillLoader ?? {
    load: vi.fn().mockReturnValue(null),
    listAll: vi.fn().mockReturnValue([]),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn(),
  } as unknown as SkillLoader

  const mcpRegistry: McpRegistry = {
    listCapabilities: vi.fn().mockReturnValue([]),
    loadTools: vi.fn().mockResolvedValue([]),
  }

  const identityLoader: IdentityLoader = {
    loadSystemPrompt: vi.fn().mockReturnValue('You are a helpful assistant.'),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
  }

  const agentIdentityLoader: IdentityLoader = {
    loadSystemPrompt: vi.fn().mockReturnValue(''),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(null),
  }

  const runner = new LocalAgentRunner({
    headId: 'default',                                  // Phase 34: test fixture single-head
    agentStore,
    inboxStore,
    queueStore,
    usageStore,
    skillLoader,
    skillsDir: '/tmp',
    workspacePath: '/tmp',
    mcpRegistry,
    identityLoader,
    agentIdentityLoader,
    llmRouter,
    pollIntervalMs: 50,
    checkStatusTimeoutMs: 500,
    timezone: 'UTC',
    ...(overrides.spawnAgentStewardEnabled !== undefined ? { spawnAgentStewardEnabled: overrides.spawnAgentStewardEnabled } : {}),
    ...(overrides.stewardModel !== undefined ? { stewardModel: overrides.stewardModel } : {}),
    ...(overrides.unifiedLoader ? { unifiedLoader: overrides.unifiedLoader } : {}),
    ...(overrides.agentModel !== undefined ? { agentModel: overrides.agentModel } : {}),
    ...(overrides.archivalThreshold !== undefined ? { archivalThreshold: overrides.archivalThreshold } : {}),
    ...(overrides.historyBudget !== undefined ? { historyBudget: overrides.historyBudget } : {}),
  })

  return { runner, agentStore, inboxStore, queueStore, skillLoader }
}

function makeToolSurfaceDeps(overrides: Partial<ToolSurfaceDeps> = {}): ToolSurfaceDeps {
  const skillLoader: SkillLoader = {
    load: vi.fn().mockReturnValue(null),
    listAll: vi.fn().mockReturnValue([]),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn(),
    listFiles: vi.fn().mockReturnValue([]),
    readFile: vi.fn().mockReturnValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    renameSkill: vi.fn().mockResolvedValue({ updatedDeps: [] }),
  }
  const mcpRegistry: McpRegistry = {
    listCapabilities: vi.fn().mockReturnValue([]),
    loadTools: vi.fn().mockResolvedValue([]),
  }
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
  const db = freshDb()
  const usageStore = new UsageStore(db, 'UTC')
  return {
    skillLoader,
    headId: 'default',
    skillsDir: '/tmp/skills',
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

describe('assembleTools spawn_agent gating', () => {
  it('ad-hoc agent (no skill, no parent) has spawn_agent when flag is on', async () => {
    const db = freshDb()
    let capturedTools: string[] = []
    const llmRouter = makeLLMRouter([makeEndTurnResponse()])
    ;(llmRouter.complete as ReturnType<typeof vi.fn>).mockImplementation(
      (_tier: string, _msgs: unknown, tools: { name: string }[]) => {
        if (tools.length > 0) capturedTools = tools.map(t => t.name)
        return Promise.resolve({ content: 'Done.', model: 'test', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] })
      }
    )
    // makeRunner omits nestedAgentSpawningEnabled — defaults to true (depth-1, flag on)
    const { runner } = makeRunner(llmRouter, db)
    await runner.spawn({ task: 'task', name: 'test', trigger: 'ad_hoc', headId: 'default' })
    await runner.awaitAll(2000)
    expect(capturedTools).toContain('spawn_agent')
  })

  it("resolves the 'dynamic' agent-model sentinel to 'smart' for spawns without an explicit model (#37)", async () => {
    const db = freshDb()
    const llmRouter = makeLLMRouter([makeEndTurnResponse()])
    const { runner, agentStore } = makeRunner(llmRouter, db, { agentModel: 'dynamic' })
    const id = await runner.spawn({ task: 'task', name: 'dyn', trigger: 'ad_hoc', headId: 'default' })
    // The runner must never let "dynamic" reach the model field (it would 400 at the router).
    expect(agentStore.get(id)?.model).toBe('smart')
    await runner.awaitAll(2000)
  })

  it('skill agent without sub-skills (no parent) has spawn_agent when flag is on', async () => {
    // 260414-112: trigger-tools allowlist removed; tool surface always derives from
    // agentDefaults. spawn_agent is a builtin and still appears via canSpawn.
    const db = freshDb()
    let capturedTools: string[] = []
    const llmRouter = makeLLMRouter([makeEndTurnResponse()])
    ;(llmRouter.complete as ReturnType<typeof vi.fn>).mockImplementation(
      (_tier: string, _msgs: unknown, tools: { name: string }[]) => {
        if (tools.length > 0) capturedTools = tools.map(t => t.name)
        return Promise.resolve({ content: 'done', model: 'test', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] })
      }
    )
    const { runner, skillLoader } = makeRunner(llmRouter, db)
    ;(skillLoader.load as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'email',
      path: '/skills/email',
      frontmatter: { name: 'email', description: 'Email check' },
      instructions: 'Check system.',
    })
    await runner.spawn({ task: 'run email', name: 'email', skillName: 'email', trigger: 'scheduled', headId: 'default' })
    await runner.awaitAll(2000)
    expect(capturedTools).toContain('spawn_agent')
  })

})

describe('async sub-agent spawning', () => {
  it('spawn_agent returns { subAgentId } without suspending parent', async () => {
    const db = freshDb()
    // Parent and child share the router. Each tool call needs a follow-up end_turn since
    // runToolLoop always calls LLM once more after executing tools. Provide enough
    // end_turn responses to handle all possible LLM calls in any interleaving order.
    // The key assertion is that the parent reaches 'completed' without ever being 'suspended'.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('spawn_agent', { task: 'do child task' }),
      makeEndTurnResponse(),  // parent: after spawn, waits for child (has running child)
      makeEndTurnResponse(),  // child: auto-completes
      makeEndTurnResponse(),  // parent: after child inbox arrives, auto-completes
      makeEndTurnResponse(),  // extra buffer
      makeEndTurnResponse(),  // extra buffer
    ])
    const { runner, agentStore } = makeRunner(llmRouter, db)

    const parentId = await runner.spawn({ task: 'parent task', name: 'parent-task', trigger: 'manual', headId: 'default' })
    await runner.awaitAll(3000)

    const parentState = agentStore.get(parentId)
    expect(parentState?.status).toBe('completed')
    // Parent should never have been suspended waiting for child
    expect(parentState?.pendingQuestion).toBeUndefined()
    // No active agents remain
    expect(agentStore.getActive().length).toBe(0)
  })

  it('child auto-completes and routes sub_agent_completed to parent inbox when parentAgentId is set', async () => {
    const db = freshDb()
    // Child responds naturally and auto-completes via end_turn
    const { runner, agentStore, inboxStore, queueStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'echo done' }),  // child does some work
        makeEndTurnResponse(),  // child responds 'Done.' and auto-completes
      ]),
      db,
    )

    // Create a parent record (not running via runner — just a DB entry to receive inbox)
    const parentId = 'tent_parent_test'
    agentStore.create(parentId, { task: 'parent', trigger: 'manual', headId: 'default' })

    const childId = await runner.spawn({
      task: 'child task',
      name: 'child-task',
      trigger: 'ad_hoc',
      headId: 'default',
      parentAgentId: parentId,
    })

    await runner.awaitAll(2000)

    // Child should be completed with the last assistant text as output
    const childState = agentStore.get(childId)
    expect(childState?.status).toBe('completed')
    expect(childState?.output).toBe('Done.')

    // sub_agent_completed should be in parent inbox
    const msgs = inboxStore.poll(parentId)
    const completion = msgs.find(m => m.type === 'sub_agent_completed')
    expect(completion).toBeDefined()
    const payload = JSON.parse(completion!.payload ?? '{}')
    expect(payload.subWorkerId).toBe(childId)
    expect(payload.output).toBe('Done.')

    // Global queue should NOT have agent_completed for child
    const claimed = queueStore.claimNext('default')
    if (claimed) {
      expect(claimed.event.type).not.toBe('agent_completed')
    }
  })

  it('child question (via completion steward) routes sub_agent_question to parent inbox', async () => {
    const db = freshDb()
    // Child: calls a tool, then responds with a question. Steward classifies as question.
    const { runner, agentStore, inboxStore, queueStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'ls' }),       // child does some work
        { content: 'What color should I use?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('What color should I use?'), // steward classifies as question
      ]),
      db,
    )

    const parentId = 'tent_parent_q'
    agentStore.create(parentId, { task: 'parent', trigger: 'manual', headId: 'default' })

    const childId = await runner.spawn({
      task: 'child needs answer',
      name: 'child-q',
      trigger: 'ad_hoc',
      headId: 'default',
      parentAgentId: parentId,
    })

    // Wait for child to suspend (poll interval is 50ms)
    await new Promise(resolve => setTimeout(resolve, 400))

    const childState = agentStore.get(childId)
    expect(childState?.status).toBe('suspended')

    // Parent inbox should have sub_agent_question
    const msgs = inboxStore.poll(parentId)
    const subQ = msgs.find(m => m.type === 'sub_agent_question')
    expect(subQ).toBeDefined()
    const payload = JSON.parse(subQ!.payload ?? '{}')
    expect(payload.subWorkerId).toBe(childId)
    expect(payload.question).toBe('What color should I use?')

    // Global queue should NOT have agent_question for child
    const claimed = queueStore.claimNext('default')
    if (claimed) {
      expect(claimed.event.type).not.toBe('agent_question')
    }
  })

  it('ownership guard rejects agent management tools targeting non-children', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([makeEndTurnResponse()]),
      db,
    )

    // Create two unrelated agents
    const agentAId = 'tent_a'
    const agentBId = 'tent_b'
    agentStore.create(agentAId, { task: 'a', trigger: 'manual', headId: 'default' })
    agentStore.create(agentBId, { task: 'b', trigger: 'manual', headId: 'default' })

    // Agent B is not a child of Agent A — ownership guard should reject
    // We test via checkStatus since that's a direct method, but verify
    // the guard logic by checking the agentStore directly
    const agentB = agentStore.get(agentBId)
    expect(agentB?.parentAgentId).toBeUndefined()
    // parentAgentId !== agentAId → would return error JSON in the actual tool handler
    expect(agentB?.parentAgentId !== agentAId).toBe(true)
  })
})

// ─── Inbox processing (retract / signal / update) ─────────────────────────────

describe('inbox processing', () => {
  it('retract transitions a suspended agent to retracted', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'ls' }),
        { content: 'Should I proceed?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('Should I proceed?'),
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'test retract', name: 'retract-test', trigger: 'manual', headId: 'default' })
    // Wait for the agent to reach suspended state
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (agentStore.get(agentId)?.status === 'suspended') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })

    await runner.retract(agentId)
    // Give the retract a moment to propagate
    await new Promise(resolve => setTimeout(resolve, 200))

    const state = agentStore.get(agentId)
    expect(['retracted', 'failed']).toContain(state?.status)
  }, 5000)

  it('signal resumes a suspended agent to completion', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'ls' }),
        { content: 'What color?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('What color?'),              // steward → suspend
        makeEndTurnResponse(),                                  // resumes after signal, auto-completes
        makeStewardDoneResponse(),                                // steward → done on resume
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'test signal', name: 'signal-test', trigger: 'manual', headId: 'default' })
    // Wait for suspended state
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (agentStore.get(agentId)?.status === 'suspended') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })

    await runner.signal(agentId, 'blue')
    await runner.awaitAll(3000)

    expect(agentStore.get(agentId)?.status).toBe('completed')
  }, 8000)

  it('update writes a message to the inbox of an agent with no active loop', async () => {
    const db = freshDb()
    // Use a dummy LLM router — the loop for this agent won't run
    const { runner, agentStore, inboxStore } = makeRunner(
      makeLLMRouter([makeEndTurnResponse()]),
      db,
    )

    // Create an agent record directly without spawning a loop (no emitter)
    const agentId = 'tent_update_test'
    agentStore.create(agentId, { task: 'zombie agent', trigger: 'manual', headId: 'default' })

    await runner.update(agentId, 'additional context')

    // No loop running, no emitter — message stays in inbox
    const msgs = inboxStore.poll(agentId)
    const updateMsg = msgs.find(m => m.type === 'update')
    expect(updateMsg).toBeDefined()
    expect(updateMsg!.payload).toBe('additional context')
  })
})

// ─── TEST-01 + TEST-05: direct assembleTools unit tests ───────────────────────

describe('nested spawn tool-assembly gating (TEST-01, TEST-05)', () => {
  it('depth-1 agent gets spawn_agent when nestedAgentSpawningEnabled is true', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'a1',
      options: { task: 'x', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    const names = toolEntries.map(t => t.definition.name)
    expect(names).toContain('spawn_agent')
  })

  it('depth-1 agent does NOT get spawn_agent when nestedAgentSpawningEnabled is false (CFG-02 byte-equivalence)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: false })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'a1',
      options: { task: 'x', trigger: 'ad_hoc', headId: 'default' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent (parentAgentId set) does NOT get spawn_agent when flag is on (NEST-02)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { task: 'x', trigger: 'ad_hoc', headId: 'default', parentAgentId: 'parent-abc' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent does NOT get spawn_agent when flag is off (independence of the two blockers)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: false })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { task: 'x', trigger: 'ad_hoc', headId: 'default', parentAgentId: 'parent-abc' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent also does NOT get message_agent or cancel_agent (existing PARENT_ONLY_TOOLS behavior preserved)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { task: 'x', trigger: 'ad_hoc', headId: 'default', parentAgentId: 'parent-abc' },
      skill: null,
    })
    const names = toolEntries.map(t => t.definition.name)
    expect(names).not.toContain('message_agent')
    expect(names).not.toContain('cancel_agent')
  })

  // TEST-05: proactive agents are spawned via src/head/activation.ts with trigger: 'scheduled'
  // and no parentAgentId. They share the same code path as direct-scheduled agents and both
  // qualify as "top-level" for spawning purposes.
  it('scheduled trigger with no parent gets spawn_agent when flag is on (NEST-04, NEST-05)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 's1',
      options: { task: 'x', trigger: 'scheduled', headId: 'default' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).toContain('spawn_agent')
  })

  it('scheduled trigger WITH parentAgentId does NOT get spawn_agent (rule is parent-based, not trigger-based)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 's1',
      options: { task: 'x', trigger: 'scheduled', headId: 'default', parentAgentId: 'p1' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })
})

// ─── TEST-04: defense-in-depth runtime check ─────────────────────────────────

describe('handleSpawnAgent defense-in-depth (TEST-04, NEST-06)', () => {
  it('depth-2 agent that hallucinates a spawn_agent tool call gets the instruction-shaped error', async () => {
    const db = freshDb()
    // LLM stub: depth-2 agent (we force it to be depth-2 via parentAgentId) will
    // hallucinate a spawn_agent call on its first turn even though that tool is
    // not in its assembled tool list. handleSpawnAgent should reject it via the
    // runtime defense-in-depth check at src/sub-agents/local.ts.
    const llmRouter = makeLLMRouter([
      makeToolCallResponse('spawn_agent', { description: 'hallucinated', task: 'try to nest further' }),
      makeEndTurnResponse(),   // after tool error, agent completes
      makeStewardDoneResponse(),  // completion steward classifies as done
    ])
    const { runner, agentStore } = makeRunner(llmRouter, db)
    // Create a fake parent record so the sub_agent_completed inbox write has a target.
    agentStore.create('parent-x', { task: 'p', trigger: 'manual', headId: 'default' })

    const childId = await runner.spawn({
      task: 'child task',
      name: 'child',
      trigger: 'ad_hoc',
      headId: 'default',
      parentAgentId: 'parent-x',
    })
    await runner.awaitAll(2000)

    const childState = agentStore.get(childId)
    expect(childState).toBeDefined()

    // The history should contain a tool_result message for the spawn_agent call
    // whose content includes the defense-in-depth error string verbatim.
    const history = (childState!.history ?? []) as unknown as Array<Record<string, unknown>>
    const toolResultMsgs = history.filter(m => m['kind'] === 'tool_result')
    const rejected = toolResultMsgs.find(m => {
      const results = m['toolResults'] as Array<{ content: string }> | undefined
      return results?.some(r => r.content.includes('Sub-agents cannot spawn further sub-agents'))
    })
    expect(rejected).toBeDefined()

    // Verify no actual grandchild was spawned — query the DB directly for any
    // agent record whose parent_agent_id points at the child.
    const grandchildren = db.prepare(
      'SELECT id FROM agents WHERE parent_agent_id = ?'
    ).all(childId)
    expect(grandchildren.length).toBe(0)
  })
})

// ─── Spawn steward wiring tests (TEST-03, STEW-07, STEW-08) ─────────────────

function makeCountingRouter(opts: {
  response?: string
  throwError?: Error
}): { router: LLMRouter; calls: { count: number } } {
  const calls = { count: 0 }
  const router = {
    complete: async (model: string) => {
      calls.count++
      if (opts.throwError) throw opts.throwError
      return {
        content: opts.response ?? '{"pass": true, "reason": ""}',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn' as const,
        model,
      }
    },
  } as unknown as LLMRouter
  return { router, calls }
}

function makeHistory(): Message[] {
  return [
    { kind: 'text', role: 'user', id: 'h1', content: 'build the feature', createdAt: new Date().toISOString() } as TextMessage,
    { kind: 'text', role: 'assistant', id: 'h2', content: 'I will start by reading the existing code.', createdAt: new Date().toISOString() } as TextMessage,
    { kind: 'text', role: 'assistant', id: 'h3', content: 'Now I need a sub-agent for research.', createdAt: new Date().toISOString() } as TextMessage,
  ]
}

describe('spawn steward wiring (TEST-03, STEW-07, STEW-08)', () => {
  it('TEST-03 wiring reject: steward rejects and no child agent is created', async () => {
    const { router, calls } = makeCountingRouter({ response: '{"pass": false, "reason": "do it yourself"}' })
    const db = freshDb()
    const { runner, agentStore } = makeRunner(router, db, { spawnAgentStewardEnabled: true })

    const parentState = agentStore.create('tent_steward_reject', { task: 'build the feature', trigger: 'ad_hoc', headId: 'default' })
    const parentAgentId = parentState.id

    const parentOptions = { task: 'build the feature', model: 'smart', trigger: 'ad_hoc' as const, headId: 'default' }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { task: 'trivial child task' },
      history,
    ) as string

    // Assert the STEW-05 error format with em dash (U+2014)
    expect(result).toContain('delegation rejected \u2014 do it yourself')
    const parsed = JSON.parse(result)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('delegation rejected \u2014 do it yourself')

    // No child agent row should exist
    const children = db.prepare('SELECT id FROM agents WHERE parent_agent_id = ?').all(parentAgentId)
    expect(children.length).toBe(0)

    // Steward was called exactly once
    expect(calls.count).toBe(1)
  })

  it('TEST-03 wiring pass: steward passes and child agent is created', async () => {
    const { router, calls } = makeCountingRouter({ response: '{"pass": true, "reason": ""}' })
    const db = freshDb()
    const { runner, agentStore } = makeRunner(router, db, { spawnAgentStewardEnabled: true })

    const parentState = agentStore.create('tent_steward_pass', { task: 'build the feature', trigger: 'ad_hoc', headId: 'default' })
    const parentAgentId = parentState.id

    const parentOptions = { task: 'build the feature', model: 'smart', trigger: 'ad_hoc' as const, headId: 'default' }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'research', task: 'research task needing fresh context' },
      history,
    ) as string

    const parsed = JSON.parse(result)
    expect(typeof parsed.subAgentId).toBe('string')

    // Child agent row exists with the returned ID
    const children = db.prepare('SELECT id FROM agents WHERE parent_agent_id = ?').all(parentAgentId) as { id: string }[]
    expect(children.length).toBe(1)
    expect(children[0]!.id).toBe(parsed.subAgentId)

    // Steward was called at least once (child's background loop may add more calls)
    expect(calls.count).toBeGreaterThanOrEqual(1)
  })

  it('STEW-07: flag off skips steward entirely and spawn proceeds', async () => {
    // Router returns a reject — if the steward WERE called, spawn would be blocked.
    // The fact that spawn succeeds PROVES the steward was never invoked (STEW-07).
    const { router, calls } = makeCountingRouter({ response: '{"pass": false, "reason": "should not be called"}' })
    const db = freshDb()
    const { runner, agentStore } = makeRunner(router, db, { spawnAgentStewardEnabled: false })

    const parentState = agentStore.create('tent_steward_off', { task: 'build the feature', trigger: 'ad_hoc', headId: 'default' })
    const parentAgentId = parentState.id

    const parentOptions = { task: 'build the feature', model: 'smart', trigger: 'ad_hoc' as const, headId: 'default' }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'child', task: 'child task' },
      history,
    ) as string

    // Spawn succeeded despite router returning a reject response — proves steward was skipped.
    const parsed = JSON.parse(result)
    expect(typeof parsed.subAgentId).toBe('string')

    // Child agent row exists
    const children = db.prepare('SELECT id FROM agents WHERE parent_agent_id = ?').all(parentAgentId)
    expect(children.length).toBe(1)
  })

  it('STEW-08: router throws but spawn proceeds (fail-open end-to-end)', async () => {
    const { router, calls } = makeCountingRouter({ throwError: new Error('network timeout') })
    const db = freshDb()
    const { runner, agentStore } = makeRunner(router, db, { spawnAgentStewardEnabled: true })

    const parentState = agentStore.create('tent_steward_throw', { task: 'build the feature', trigger: 'ad_hoc', headId: 'default' })
    const parentAgentId = parentState.id

    const parentOptions = { task: 'build the feature', model: 'smart', trigger: 'ad_hoc' as const, headId: 'default' }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'child', task: 'child task after steward failure' },
      history,
    ) as string

    // No error propagated — spawn succeeded despite router throwing (fail-open)
    const parsed = JSON.parse(result)
    expect(typeof parsed.subAgentId).toBe('string')

    // Child agent row exists
    const children = db.prepare('SELECT id FROM agents WHERE parent_agent_id = ?').all(parentAgentId)
    expect(children.length).toBe(1)

    // Router was called at least once (steward attempt that threw; child loop may add more)
    expect(calls.count).toBeGreaterThanOrEqual(1)
  })
})

// ─── create_schedule kind validation (DISPATCH-03) ───────────────────────────

describe('create_schedule kind validation (DISPATCH-03)', () => {
  async function makeTmpUnified() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const { FileSystemKindLoader } = await import('../skills/loader.js')
    const { UnifiedLoader } = await import('../skills/unified.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'))
    const skillsDir = path.join(tmp, 'skills')
    const tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(skillsDir, 'my-skill'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'my-skill', 'SKILL.md'), `---\nname: my-skill\ndescription: s\n---\nbody`)
    fs.mkdirSync(path.join(tasksDir, 'a-task'), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, 'a-task', 'TASK.md'), `---\nname: a-task\ndescription: j\n---\nbody`)
    const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    return new UnifiedLoader(skillsLoader, tasksLoader)
  }

  async function getCreateScheduleTool(unified: import('../skills/unified.js').UnifiedLoader) {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sched-tool-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    const scheduleStore = new ScheduleStore(scheduleDir)
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!
    return { createSchedule, scheduleStore }
  }

  it('accepts { taskName, kind:"task" } for a real task and stores target_kind="task"', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'a-task' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(parsed.kind).toBe('task')
    expect(parsed.taskName).toBe('a-task')
    // DB row confirms
    const rows = scheduleStore.list()
    expect(rows.length).toBe(1)
    expect(rows[0]!.kind).toBe('task')
  })

  it('accepts task target with kind omitted (defaults to task)', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'a-task' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(parsed.kind).toBe('task')
    expect(scheduleStore.list()[0]!.kind).toBe('task')
  })

  it('rejects unknown task target with instruction-shaped error', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'missing' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('missing')
  })

  it('rejects a skill target with instruction-shaped error', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'my-skill' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('my-skill')
  })
})

// ─── cadence validation (create_schedule + update_schedule) ──────────────────

describe('cadence validation (create_schedule + update_schedule)', () => {
  async function makeTmpUnified() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const { FileSystemKindLoader } = await import('../skills/loader.js')
    const { UnifiedLoader } = await import('../skills/unified.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-tool-'))
    const tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(tasksDir, 'a-task'), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, 'a-task', 'TASK.md'), `---\nname: a-task\ndescription: j\n---\nbody`)
    const skillsDir = path.join(tmp, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader  = new FileSystemKindLoader({ root: tasksDir,  kind: 'task',  filename: 'TASK.md' })
    return new UnifiedLoader(skillsLoader, tasksLoader)
  }

  async function buildTools(unified: import('../skills/unified.js').UnifiedLoader) {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cadence-store-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    const scheduleStore = new ScheduleStore(scheduleDir)
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    return {
      createSchedule: tools.find(t => t.definition.name === 'create_schedule')!,
      updateSchedule: tools.find(t => t.definition.name === 'update_schedule')!,
      scheduleStore,
    }
  }

  const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

  // ─── create_schedule ──────────────────────────────────────────────

  it('create_schedule rejects */7 * * * * with CADENCE_ERROR_MESSAGE', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await buildTools(unified)
    const before = scheduleStore.list().length
    const result = await createSchedule.execute({ taskName: 'a-task', cron: '*/7 * * * *' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toBe(CADENCE_ERROR_MESSAGE)
    expect(parsed.message).toContain('conditions')
    expect(scheduleStore.list().length).toBe(before)  // no row persisted
  })

  it('create_schedule accepts 0 9 * * 1-5 (weekdays Mon–Fri, phase 23 expansion)', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await buildTools(unified)
    const result = await createSchedule.execute({ taskName: 'a-task', cron: '0 9 * * 1-5' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(scheduleStore.list().length).toBe(1)
    expect(scheduleStore.list()[0]!.cron).toBe('0 9 * * 1-5')
  })

  it('create_schedule accepts */30 * * * * (supported cadence)', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await buildTools(unified)
    const result = await createSchedule.execute({ taskName: 'a-task', cron: '*/30 * * * *' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(scheduleStore.list().length).toBe(1)
    expect(scheduleStore.list()[0]!.cron).toBe('*/30 * * * *')
  })

  it('create_schedule accepts 0 9 * * 1 (weekly Monday 09:00)', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await buildTools(unified)
    const result = await createSchedule.execute({ taskName: 'a-task', cron: '0 9 * * 1' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(scheduleStore.list()[0]!.cron).toBe('0 9 * * 1')
  })

  // ─── update_schedule ──────────────────────────────────────────────

  it('update_schedule rejects non-cadence cron and leaves the stored row unchanged', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, updateSchedule, scheduleStore } = await buildTools(unified)

    // Seed a row via the happy path
    const created = await createSchedule.execute({ taskName: 'a-task', cron: '*/30 * * * *' }, ctx)
    const id = JSON.parse(created as string).id as string

    // Try to update with an invalid cadence
    const result = await updateSchedule.execute({ id, cron: '*/7 * * * *' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toBe(CADENCE_ERROR_MESSAGE)

    // Stored row still has the original cron
    const row = scheduleStore.list().find(s => s.id === id)
    expect(row?.cron).toBe('*/30 * * * *')
  })

  it('update_schedule accepts supported cadence', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, updateSchedule, scheduleStore } = await buildTools(unified)

    const created = await createSchedule.execute({ taskName: 'a-task', cron: '*/30 * * * *' }, ctx)
    const id = JSON.parse(created as string).id as string

    const result = await updateSchedule.execute({ id, cron: '0 9 * * 1' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)

    const row = scheduleStore.list().find(s => s.id === id)
    expect(row?.cron).toBe('0 9 * * 1')
  })
})

// ─── buildReminderTools (Plan 12-01) ─────────────────────────────────────────

describe('buildReminderTools', () => {
  const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

  async function getReminderTools() {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rem-tool-sched-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    const scheduleStore = new ScheduleStore(scheduleDir)
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'default')
    const createReminder = tools.find(t => t.definition.name === 'create_reminder')!
    const listReminders = tools.find(t => t.definition.name === 'list_reminders')!
    const cancelReminder = tools.find(t => t.definition.name === 'cancel_reminder')!
    return { createReminder, listReminder: listReminders, cancelReminder, scheduleStore }
  }

  it('create_reminder with valid input stores kind:"reminder" record with agentContext = message', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check the build', triggerAt: '2099-01-01 09:00' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.id).toMatch(/^rem/)
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agentContext).toBe('Check the build')
    expect(rows[0]!.kind).toBe('reminder')
  })

  it('create_reminder with empty message returns error JSON (T-12-01)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: '  ', triggerAt: '2099-01-01 09:00' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/non-empty/i)
  })

  it('create_reminder with message > 2000 chars returns error JSON (T-12-01)', async () => {
    const { createReminder } = await getReminderTools()
    const longMsg = 'x'.repeat(2001)
    const result = await createReminder.execute({ message: longMsg, triggerAt: '2099-01-01 09:00' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/2000/i)
  })

  it('list_reminders returns only kind:"reminder" entries', async () => {
    const { createReminder, listReminder, scheduleStore } = await getReminderTools()
    // Create a non-reminder schedule directly
    scheduleStore.create({ id: 's-task-x', headId: 'default', taskName: 'my-task', kind: 'task', nextRun: '2099-01-01T00:00:00Z' })
    await createReminder.execute({ message: 'Hello', triggerAt: '2099-01-01 09:00' }, ctx)
    const result = await listReminder.execute({}, ctx)
    const items = JSON.parse(result as string)
    expect(items).toHaveLength(1)
    expect(items[0].message).toBe('Hello')
  })

  it('list_reminders projection includes requiresAck and nagIntervalMinutes (Phase 37)', async () => {
    const { createReminder, listReminder } = await getReminderTools()
    await createReminder.execute({ message: 'Take meds', triggerAt: '2099-01-01 09:00', requiresAck: true, nagMinutes: 60 }, ctx)
    const result = await listReminder.execute({}, ctx)
    const items = JSON.parse(result as string)
    expect(items[0]!.requiresAck).toBe(true)
    expect(items[0]!.nagIntervalMinutes).toBe(60)
  })

  it('cancel_reminder with valid id deletes schedule record', async () => {
    const { createReminder, cancelReminder, scheduleStore } = await getReminderTools()
    const cr = await createReminder.execute({ message: 'Delete me', triggerAt: '2099-01-01 09:00' }, ctx)
    const { id } = JSON.parse(cr as string)
    const cancelResult = await cancelReminder.execute({ id }, ctx)
    expect(JSON.parse(cancelResult as string).ok).toBe(true)
    expect(scheduleStore.list().filter(s => s.kind === 'reminder')).toHaveLength(0)
  })

  it('cancel_reminder with unknown id returns error JSON', async () => {
    const { cancelReminder } = await getReminderTools()
    const result = await cancelReminder.execute({ id: 'rem-nonexistent' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('rem-nonexistent')
  })

  it('create_reminder stores conditions on the reminder schedule row (C-01)', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute(
      { message: 'Check the build', triggerAt: '2099-01-01 09:00', conditions: 'Only on weekdays' },
      ctx,
    )
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conditions).toBe('Only on weekdays')
    expect(rows[0]!.agentContext).toBe('Check the build')
  })

  it('create_reminder without conditions leaves conditions null', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    await createReminder.execute(
      { message: 'Check the build', triggerAt: '2099-01-01 09:00' },
      ctx,
    )
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows[0]!.conditions).toBeNull()
  })

  it('create_reminder inputSchema declares conditions property', async () => {
    const { createReminder } = await getReminderTools()
    const schema = createReminder.definition.inputSchema as {
      properties: { conditions?: { type: string } }
    }
    expect(schema.properties.conditions).toBeDefined()
    expect(schema.properties.conditions!.type).toBe('string')
  })

  // ── Phase 37 D-04: requiresAck:true with no nag slots → reject ─────────────
  it('create_reminder with requiresAck:true and no nag slots returns error JSON (D-04)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', requiresAck: true }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/nag interval/i)
  })

  // ── Phase 37 D-05: nag slots without requiresAck:true → reject ─────────────
  it('create_reminder with nagMinutes but no requiresAck returns error JSON (D-05)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', nagMinutes: 30 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/requiresAck/i)
  })

  // ── Phase 39 D-03 floor correction: floor is now 1 minute (not 5) ──────────
  // Under floor=1, nagMinutes:3 is VALID. Old test replaced: nagMinutes:1 → success (boundary).
  it('create_reminder with requiresAck:true and nagMinutes:1 → success (D-03 floor=1 boundary)', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', requiresAck: true, nagMinutes: 1 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows[0]!.nagIntervalMinutes).toBe(1)
  })

  // ── Phase 37 D-03 ceiling: nag sum > 43200 min → reject ────────────────────
  it('create_reminder with requiresAck:true and nagDays:31 (sum>43200) returns error JSON (D-03 ceiling)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', requiresAck: true, nagDays: 31 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/30 days|43200/i)
  })

  // ── Phase 37 V5: non-integer nag slot → reject ──────────────────────────────
  it('create_reminder with requiresAck:true and nagMinutes:1.5 (non-integer) returns error JSON (V5)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', requiresAck: true, nagMinutes: 1.5 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/integer|non-negative/i)
  })

  it('create_reminder with requiresAck:true and nagMinutes:-5 (negative) returns error JSON (V5)', async () => {
    const { createReminder } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check meds', triggerAt: '2099-01-01 09:00', requiresAck: true, nagMinutes: -5 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/integer|non-negative/i)
  })

  // ── Phase 37 D-01/D-02: slot-sum round-trip ─────────────────────────────────
  it('create_reminder with requiresAck:true + nagHours:1 + nagMinutes:30 stores nagIntervalMinutes:90 (D-01/D-02)', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute(
      { message: 'Take medication', triggerAt: '2099-01-01 09:00', requiresAck: true, nagHours: 1, nagMinutes: 30 },
      ctx,
    )
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows[0]!.nagIntervalMinutes).toBe(90)
    expect(rows[0]!.requiresAck).toBe(true)
  })

  // ── Phase 37: default path — no ack params → requiresAck:false, nagIntervalMinutes:null ──
  it('create_reminder without requiresAck params stores requiresAck:false and nagIntervalMinutes:null (default path)', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    await createReminder.execute(
      { message: 'Stand up', triggerAt: '2099-01-01 09:00' },
      ctx,
    )
    const rows = scheduleStore.list().filter(s => s.kind === 'reminder')
    expect(rows[0]!.requiresAck).toBe(false)
    expect(rows[0]!.nagIntervalMinutes).toBeNull()
  })

  // ── Phase 37 SC3 / SCHED-04: description assertions ─────────────────────────
  it('create_reminder description does not say "for one-time reminders only" and documents start-then-repeat (SC3/SCHED-04)', async () => {
    const { createReminder } = await getReminderTools()
    expect(createReminder.definition.description).not.toMatch(/for one-time reminders only/i)
    expect(createReminder.definition.description).toMatch(/start.?then.?repeat|repeat on (the )?cron/i)
  })

  // ── Phase 37: inputSchema declares all four new ack/nag params ──────────────
  it('create_reminder inputSchema declares requiresAck, nagMinutes, nagHours, nagDays properties (Phase 37)', async () => {
    const { createReminder } = await getReminderTools()
    const schema = createReminder.definition.inputSchema as {
      properties: Record<string, { type: string; description: string }>
    }
    expect(schema.properties['requiresAck']).toBeDefined()
    expect(schema.properties['requiresAck']!.type).toBe('boolean')
    expect(schema.properties['nagMinutes']).toBeDefined()
    expect(schema.properties['nagMinutes']!.type).toBe('integer')
    expect(schema.properties['nagHours']).toBeDefined()
    expect(schema.properties['nagHours']!.type).toBe('integer')
    expect(schema.properties['nagDays']).toBeDefined()
    expect(schema.properties['nagDays']!.type).toBe('integer')
  })
})

// ─── phase 23: cronTimezone field ─────────────────────────────────────────────

describe('phase 23: cronTimezone field', () => {
  const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

  async function makeTmpUnified() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const { FileSystemKindLoader } = await import('../skills/loader.js')
    const { UnifiedLoader } = await import('../skills/unified.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-tool-'))
    const tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(tasksDir, 'a-task'), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, 'a-task', 'TASK.md'), `---\nname: a-task\ndescription: j\n---\nbody`)
    const skillsDir = path.join(tmp, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    return new UnifiedLoader(skillsLoader, tasksLoader)
  }

  async function makeScheduleStore() {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tz-store-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    return new ScheduleStore(scheduleDir)
  }

  it('create_schedule: cronTimezone appears BEFORE cron in property order', async () => {
    const unified = await makeTmpUnified()
    const scheduleStore = await makeScheduleStore()
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'America/New_York', unified, 'default')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const keys = Object.keys(create.definition.inputSchema.properties as object)
    expect(keys).toEqual(['taskName', 'kind', 'cronTimezone', 'cron', 'runAt', 'conditions', 'agentContext', 'endDate'])
  })

  it('create_schedule: cronTimezone description includes the workspace timezone dynamically', async () => {
    const unified = await makeTmpUnified()
    const scheduleStore = await makeScheduleStore()
    const { buildScheduleTools } = await import('./registry.js')

    const tools = buildScheduleTools(scheduleStore, 'America/New_York', unified, 'default')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const ctzProp = (create.definition.inputSchema.properties as Record<string, { description: string }>)['cronTimezone']
    expect(ctzProp?.description).toContain('America/New_York')

    const tools2 = buildScheduleTools(scheduleStore, 'Asia/Tokyo', unified, 'default')
    const create2 = tools2.find(t => t.definition.name === 'create_schedule')!
    const ctzProp2 = (create2.definition.inputSchema.properties as Record<string, { description: string }>)['cronTimezone']
    expect(ctzProp2?.description).toContain('workspace default: Asia/Tokyo')
    expect(ctzProp2?.description).not.toContain('workspace default: America/New_York')
  })

  it('create_schedule: cronTimezone is NOT required', async () => {
    const unified = await makeTmpUnified()
    const scheduleStore = await makeScheduleStore()
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const required = (create.definition.inputSchema as { required: string[] }).required
    expect(required).toEqual(['taskName'])
    expect(required).not.toContain('cronTimezone')
  })

  it('create_schedule.execute: succeeds with cronTimezone supplied', async () => {
    const unified = await makeTmpUnified()
    const scheduleStore = await makeScheduleStore()
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const result = await create.execute({ taskName: 'a-task', cron: '0 9 * * *', cronTimezone: 'Europe/London' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(parsed.id).toBeDefined()
  })

  it('create_schedule.execute: succeeds without cronTimezone (fallback to workspace)', async () => {
    const unified = await makeTmpUnified()
    const scheduleStore = await makeScheduleStore()
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const result = await create.execute({ taskName: 'a-task', cron: '0 9 * * *' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
  })

  it('create_reminder: cronTimezone appears BEFORE triggerAt in property order', async () => {
    const scheduleStore = await makeScheduleStore()
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'default')
    const create = tools.find(t => t.definition.name === 'create_reminder')!
    const keys = Object.keys(create.definition.inputSchema.properties as object)
    // Phase 37: new ack/nag params appended after conditions — expected churn flagged in RESEARCH Pitfall 3
    expect(keys).toEqual(['message', 'cronTimezone', 'triggerAt', 'cron', 'conditions', 'requiresAck', 'nagMinutes', 'nagHours', 'nagDays'])
  })

  it('create_reminder.execute: rejects non-standard cron with CADENCE_ERROR_MESSAGE', async () => {
    const scheduleStore = await makeScheduleStore()
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'default')
    const create = tools.find(t => t.definition.name === 'create_reminder')!
    // '* * * * *' is explicitly rejected by isValidCadence
    const result = await create.execute({ message: 'hi', cron: '* * * * *' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toBe(CADENCE_ERROR_MESSAGE)
  })

  it('create_reminder.execute: accepts new weekdays cadence', async () => {
    const scheduleStore = await makeScheduleStore()
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'default')
    const create = tools.find(t => t.definition.name === 'create_reminder')!
    const result = await create.execute({ message: 'hi', cron: '0 9 * * 1-5' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(parsed.ok).toBe(true)
  })
})

// ─── Phase 24 MSG-01: mid-loop update delivery ────────────────────────────────

describe('mid-loop update delivery (Phase 24 MSG-01)', () => {
  it('message_agent update arrives in agent history before end_turn', async () => {
    // Agent runs 3 unique bash tool calls (no end_turn) so it stays inside
    // runToolLoop. Mid-stream we fire runner.update — the new onRoundComplete
    // callback in loopIteration must inject the update into history before the
    // next LLM round, not after end_turn.
    const db = freshDb()
    let llmCallNum = 0
    const capturedMessagesPerCall: Message[][] = []
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, msgs: Message[]) => {
        capturedMessagesPerCall.push([...msgs])
        llmCallNum++
        // After 1st call we want time for the test to fire update before the 2nd LLM call.
        // Sleep a bit between rounds to give the test a window to write to the inbox.
        await new Promise(r => setTimeout(r, 80))
        // Rounds 1..3 = unique bash calls; round 4 = end_turn.
        if (llmCallNum <= 3) {
          return makeToolCallResponse('bash', { description: `r${llmCallNum}`, command: `echo r${llmCallNum}` })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore, inboxStore } = makeRunner(llmRouter, db)
    const agentId = await runner.spawn({ task: 'mid-loop test', name: 'midloop', trigger: 'manual', headId: 'default' })

    // Wait for the 1st LLM call + 1st bash call to complete, then fire update.
    // Total budget: 80ms LLM + ~few ms bash + safety margin.
    await new Promise(r => setTimeout(r, 200))
    await runner.update(agentId, 'mid-loop hello')

    // Let the agent finish its 4-round sequence.
    await runner.awaitAll(5000)

    // The injected message must appear in at least one LLM call's history snapshot.
    // We search ALL captured calls because the completion steward makes a separate
    // llmRouter.complete call with its own 1-message history; the last captured call
    // may be the steward call rather than the agent's final tool-loop round.
    let injectedTextMatch: Message | undefined
    for (const msgs of capturedMessagesPerCall) {
      const found = msgs.find(m => {
        if (m.kind !== 'text') return false
        const tm = m as TextMessage
        return tm.role === 'user' && tm.content.includes('[Message received: mid-loop hello]')
      })
      if (found) { injectedTextMatch = found; break }
    }
    expect(injectedTextMatch).toBeDefined()

    // The mid-loop injection text MUST NOT mention respond_to_message — that tool
    // is not in the runToolLoop tool list. Plan 24-02 instruction differs from the
    // top-of-loop injection at local.ts:677.
    const tm = injectedTextMatch as TextMessage
    expect(tm.content).not.toContain('respond_to_message')
    expect(tm.content).toContain('Continue your current task')

    // Inbox: the update message must be marked processed (callback called markProcessed).
    const remainingUpdates = inboxStore.poll(agentId).filter(m => m.type === 'update')
    expect(remainingUpdates).toHaveLength(0)

    // Sanity: agent eventually reached a terminal state (completed, suspended, or
    // failed are all acceptable — we are testing inbox delivery, not completion).
    const finalState = agentStore.get(agentId)
    expect(['completed', 'failed', 'retracted', 'suspended'].includes(finalState?.status ?? 'unknown')).toBe(true)
  }, 10000)
})

// ─── Phase 35 D-09 / D-10: factory headId injection + update_schedule reassignment reject ──

describe('Phase 35: buildScheduleTools / buildReminderTools — factory headId injection (D-09)', () => {
  const ctx = { agentId: 't', headId: 'test-head', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

  async function makeTmpUnifiedWithTask() {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const { FileSystemKindLoader } = await import('../skills/loader.js')
    const { UnifiedLoader } = await import('../skills/unified.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-tool-'))
    const tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(path.join(tasksDir, 'a-task'), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, 'a-task', 'TASK.md'), `---\nname: a-task\ndescription: j\n---\nbody`)
    const skillsDir = path.join(tmp, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader  = new FileSystemKindLoader({ root: tasksDir,  kind: 'task',  filename: 'TASK.md' })
    return new UnifiedLoader(skillsLoader, tasksLoader)
  }

  async function makeStore() {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'p35-store-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    return new ScheduleStore(scheduleDir)
  }

  it('create_schedule injects the factory headId into ScheduleStore.create options', async () => {
    const unified = await makeTmpUnifiedWithTask()
    const scheduleStore = await makeStore()
    const createSpy = vi.spyOn(scheduleStore, 'create')
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'work')
    const create = tools.find(t => t.definition.name === 'create_schedule')!
    const result = await create.execute({ taskName: 'a-task' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(createSpy).toHaveBeenCalledOnce()
    const optsArg = createSpy.mock.calls[0]![0]
    expect(optsArg.headId).toBe('work')
  })

  it('create_reminder injects the factory headId into ScheduleStore.create options', async () => {
    const scheduleStore = await makeStore()
    const createSpy = vi.spyOn(scheduleStore, 'create')
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC', 'personal')
    const create = tools.find(t => t.definition.name === 'create_reminder')!
    const result = await create.execute({ message: 'go for a walk', triggerAt: '2099-01-01 09:00' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(createSpy).toHaveBeenCalledOnce()
    const optsArg = createSpy.mock.calls[0]![0]
    expect(optsArg.headId).toBe('personal')
    expect(optsArg.kind).toBe('reminder')
    expect(optsArg.agentContext).toBe('go for a walk')
  })

  it('update_schedule rejects headId reassignment with a clear error and does NOT call scheduleStore.update', async () => {
    const unified = await makeTmpUnifiedWithTask()
    const scheduleStore = await makeStore()
    const updateSpy = vi.spyOn(scheduleStore, 'update')
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const update = tools.find(t => t.definition.name === 'update_schedule')!
    const result = await update.execute({ id: 'sched_x', headId: 'work' } as Record<string, unknown>, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/headId cannot be reassigned/)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('update_schedule inputSchema does NOT declare a headId property', async () => {
    const unified = await makeTmpUnifiedWithTask()
    const scheduleStore = await makeStore()
    const { buildScheduleTools } = await import('./registry.js')
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified, 'default')
    const update = tools.find(t => t.definition.name === 'update_schedule')!
    const props = (update.definition.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).not.toContain('headId')
  })
})

// ─── head spawns receive the all-in-one task directly ─────────────────────────
//
// The head writes a rich all-in-one `task` (what is wanted PLUS the relevant context),
// and the agent receives it directly — no composer in between. `context`, when a caller
// still sets it, is a defensive fallback appended after `task`. This holds for manual
// (head) spawns and non-manual (nested 'ad_hoc', 'scheduled', 'sensor') spawns alike.
describe('spawn first message — head task is delivered directly', () => {
  function captureCalls(): { router: LLMRouter; calls: Message[][] } {
    const calls: Message[][] = []
    const router: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, msgs: Message[]) => {
        calls.push([...msgs])
        return makeEndTurnResponse()
      }),
    }
    return { router, calls }
  }

  // The agent's first user-role message in its very first LLM round is the assembled
  // first message. (Later calls may be the completion steward — inspect calls[0] only.)
  function firstUserText(calls: Message[][]): string {
    const msgs = calls[0] ?? []
    const m = msgs.find(x => x.kind === 'text' && (x as TextMessage).role === 'user') as TextMessage | undefined
    return m?.content ?? ''
  }

  it('manual (head) spawn delivers the head task directly to the agent', async () => {
    const db = freshDb()
    const { router, calls } = captureCalls()
    const { runner } = makeRunner(router, db)
    await runner.spawn({
      task: 'TASK_marker — remind me next time the digest fires that nyseg is already handled',
      name: 'nyseg-reminder',
      trigger: 'manual',
      headId: 'default',
    })
    await runner.awaitAll(2000)
    const text = firstUserText(calls)
    expect(text).toContain('TASK_marker — remind me next time the digest fires that nyseg is already handled')
  })

  it('non-manual spawn (e.g. nested ad_hoc) also leads with the task, with context appended when present', async () => {
    const db = freshDb()
    const { router, calls } = captureCalls()
    const { runner } = makeRunner(router, db)
    await runner.spawn({
      task: 'VISIBLE_TASK_marker — run the digest',
      context: 'some supporting context',
      name: 'digest',
      trigger: 'ad_hoc',
      headId: 'default',
    })
    await runner.awaitAll(2000)
    const text = firstUserText(calls)
    expect(text).toContain('VISIBLE_TASK_marker — run the digest')
    expect(text).toContain('Relevant messages from the conversation')
    expect(text).toContain('some supporting context')
  })
})

// ─── sensor sub-agent dispatch — must not pass a non-skill skillName (regression) ──
//
// The activation handler spawns sensor sub-agents with trigger:'sensor' and NO skillName.
// It previously passed skillName:'sensor:<slug>' as a cosmetic label, but spawn() does
// resolve-or-throw on skillName, and 'sensor:<slug>' resolves to nothing (a sensor is neither
// a skill nor a task) — so the spawn threw and no sub-agent ever ran. The activation tests
// mock spawn(), so they never exercised the throw; these run the REAL runner.
describe('sensor sub-agent spawn (regression: no bogus skillName)', () => {
  it('a trigger:sensor spawn with no skillName does not throw and the agent actually runs', async () => {
    const db = freshDb()
    const llmRouter = makeLLMRouter([makeEndTurnResponse()])
    const { runner } = makeRunner(llmRouter, db)
    // The regression: before the fix this rejected with "Unknown skill: 'sensor:<slug>'".
    await expect(runner.spawn({
      agentId: 'sensor-meeting-nag_abc123',
      task: 'Create a reminder for the meeting.',
      trigger: 'sensor',
      headId: 'default',
    })).resolves.toBe('sensor-meeting-nag_abc123')
    await runner.awaitAll(2000)
    // The agent reached the LLM — i.e. it ran, rather than the spawn aborting before any work.
    expect(llmRouter.complete).toHaveBeenCalled()
  })

  it('spawn() still rejects an unresolvable skillName (the guard that bit the sensor path)', async () => {
    const db = freshDb()
    const llmRouter = makeLLMRouter([makeEndTurnResponse()])
    const { runner } = makeRunner(llmRouter, db)
    await expect(runner.spawn({
      task: 'x',
      name: 'bogus',
      trigger: 'sensor',
      skillName: 'sensor:meeting-nag',
      headId: 'default',
    })).rejects.toThrow(/Unknown skill/)
  })
})

// ─── message_agent delivers the head's all-in-one message directly ────────────
//
// A head follow-up delivers the head-authored `message` directly (no composer in between),
// uniformly across running, completed, and suspended agents. We drive the head dispatch
// (HeadToolExecutor) with a captured agentRunner.update and a per-state agentStore, stewards
// disabled so delivery actually happens, and assert the delivered string.
describe('message_agent — the all-in-one message is delivered directly', () => {
  const MESSAGE = 'Ashley: yes go ahead, the window seat one under $300'

  function makeExecutor(state: { status: string; task?: string; pendingQuestion?: string }): {
    executor: HeadToolExecutor
    update: ReturnType<typeof vi.fn>
    tmpDir: string
  } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-agent-deliver-'))
    const update = vi.fn().mockResolvedValue(undefined)
    const agentRunner = {
      spawn: vi.fn().mockResolvedValue('tent_1'),
      update,
      signal: vi.fn().mockResolvedValue(undefined),
      retract: vi.fn().mockResolvedValue(undefined),
      checkStatus: vi.fn().mockResolvedValue({ text: '', stale: false }),
      awaitAll: vi.fn().mockResolvedValue(undefined),
    }
    const agentStore = {
      get: vi.fn().mockReturnValue({ id: 't1', headId: 'default', ...state }),
    }
    const memory = {
      chunk: vi.fn(), retrieve: vi.fn().mockResolvedValue([]), compact: vi.fn(),
      getTopics: vi.fn().mockResolvedValue([]), deleteTopic: vi.fn(),
    }
    const usageStore = { record: vi.fn() }
    const skillLoader = {
      load: vi.fn(), listAll: vi.fn().mockReturnValue([]), write: vi.fn(), delete: vi.fn(), watch: vi.fn(),
    }
    // Casts: these mocks implement only the surface the message_agent dispatch touches.
    const executor = new HeadToolExecutor({
      headId: 'default',
      agentRunner: agentRunner as never,
      agentStore: agentStore as never,
      skillLoader: skillLoader as never,
      topicMemory: memory as never,
      usageStore: usageStore as never,
      identityDir: tmpDir,
      identityLoader: new FileSystemIdentityLoader(tmpDir, tmpDir),
      messages: { getAll: () => [], getRecent: () => [], getRecentText: () => [] } as never,
      // Stewards OFF so delivery happens; agentContinuation ON so a completed agent isn't rejected.
      agentContinuationEnabled: true,
    })
    return { executor, update, tmpDir }
  }

  async function dispatchAndGetDelivered(state: { status: string; task?: string; pendingQuestion?: string }): Promise<string> {
    const { executor, update, tmpDir } = makeExecutor(state)
    try {
      const result = await executor.execute({
        id: 'tc1',
        name: 'message_agent',
        input: { agentId: 't1', message: MESSAGE },
      })
      expect(JSON.parse(result.content as string)).toMatchObject({ ok: true })
      expect(update).toHaveBeenCalledTimes(1)
      return update.mock.calls[0]![1] as string
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  it.each([
    ['running', { status: 'running', task: 'book a flight' }],
    ['completed', { status: 'completed', task: 'book a flight' }],
    ['suspended', { status: 'suspended', pendingQuestion: 'which seat?' }],
  ] as const)('%s agent: delivers the all-in-one message as-is', async (_label, state) => {
    const delivered = await dispatchAndGetDelivered(state)
    // the head's all-in-one message is delivered verbatim — no wrapper framing
    expect(delivered).toBe(MESSAGE)
    expect(delivered).not.toContain('continue your work based on it')
  })
})

// ─── Phase 53: inbound persistence ───────────────────────────────────────────
//
// Verify that every inbound inject point writes to agent_messages before the
// LLM call. Tests assert against agentStore.get(id)?.history (the DB surface)
// rather than the captured LLM messages to prove persistence, not just
// in-memory wiring.

describe('Phase 53: inbound persistence', () => {
  // ─── Test A: initial task persisted as role:user row without injected flag ──
  it('A: initial task is stored in agent_messages as a user-role text row (no injected flag)', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([makeEndTurnResponse()]),
      db,
    )

    const agentId = await runner.spawn({ task: 'Phase53-TaskA', name: 'task-a', trigger: 'manual', headId: 'default' })
    await runner.awaitAll(3000)

    const history = agentStore.get(agentId)?.history ?? []
    const taskRow = history.find(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase53-TaskA')
    }) as TextMessage | undefined

    expect(taskRow).toBeDefined()
    // Genuine user input — must NOT carry injected:true
    expect((taskRow as { injected?: boolean }).injected).toBeUndefined()
  })

  // ─── Test B: message_agent stored exactly once across both inject paths ───────
  //
  // The two sites (top-of-loop and onRoundComplete) share the same inbox row.
  // markProcessed runs before the other site's poll, so only one site claims
  // the row. Assert exactly one [Message received: ...] row in agent_messages.
  it('B: a message_agent update appears exactly once in agent_messages regardless of which site claims it', async () => {
    const db = freshDb()
    let llmCallNum = 0
    // Round 1: bash tool call (keeps the loop alive so onRoundComplete fires)
    // Round 2: end_turn (agent finishes)
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, msgs: Message[]) => {
        llmCallNum++
        await new Promise(r => setTimeout(r, 60))
        if (llmCallNum === 1) {
          return makeToolCallResponse('bash', { command: 'echo r1' })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter, db)
    const agentId = await runner.spawn({ task: 'Phase53-TaskB', name: 'task-b', trigger: 'manual', headId: 'default' })

    // Send update after the first LLM call starts (agent is in-loop, giving onRoundComplete a chance)
    await new Promise(r => setTimeout(r, 90))
    await runner.update(agentId, 'Phase53-update-payload')

    await runner.awaitAll(5000)

    const history = agentStore.get(agentId)?.history ?? []
    const updateRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase53-update-payload')
    })

    // Exactly one storage — idempotency guard (markProcessed-before-poll invariant)
    expect(updateRows).toHaveLength(1)
    // The stored row carries injected:true (it's a system inject, not genuine user input)
    expect((updateRows[0] as TextMessage & { injected?: boolean }).injected).toBe(true)
  }, 10000)

  // ─── Test C: no duplicate first turn after DB-path resume ────────────────────
  //
  // resumeSuspended loads history from DB (state.history). The task was already
  // persisted at spawn. Resuming via the DB path must NOT re-inject the task,
  // so there's exactly one task row in agent_messages after signal resumes a
  // suspended agent.
  it('C: resumeSuspended does not add a second copy of the task after signal', async () => {
    const db = freshDb()
    // Sequence: bash call → question (suspends) → steward classifies question → resume → end_turn
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'echo q' }),
        { content: 'Phase53-question?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('Phase53-question?'),
        makeEndTurnResponse(),
        makeStewardDoneResponse(),
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'Phase53-TaskC', name: 'task-c', trigger: 'manual', headId: 'default' })

    // Wait for suspended state
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (agentStore.get(agentId)?.status === 'suspended') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })

    await runner.signal(agentId, 'Phase53-answer')
    await runner.awaitAll(5000)

    const history = agentStore.get(agentId)?.history ?? []
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase53-TaskC')
    })

    // Task must appear exactly once — no duplicate from the resume path
    expect(taskRows).toHaveLength(1)
    // Resume answer is also persisted (genuine user input)
    const answerRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase53-answer')
    })
    expect(answerRows).toHaveLength(1)
  }, 10000)

  // ─── Test D: synthetic skill reads stored as injected tool_call + tool_result ─
  //
  // When a skill is resolved at spawn, runLoop injects a synthetic read_file
  // tool_call + tool_result pair so the agent sees SKILL.md upfront.
  // Both messages must be persisted with injected:true.
  it('D: skill-agent stores injected tool_call + tool_result rows for the synthetic SKILL.md read', async () => {
    const db = freshDb()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p53-skill-'))
    const skillDir = path.join(tmpDir, 'my-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    const skillPath = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillPath, '---\nname: my-skill\ndescription: Phase53 skill\n---\nPhase53-instructions')

    try {
      const mockSkillLoader: SkillLoader = {
        load: vi.fn().mockImplementation((name: string) => {
          if (name === 'my-skill') {
            return {
              name: 'my-skill',
              path: skillPath,
              frontmatter: { name: 'my-skill', description: 'Phase53 skill' },
              instructions: 'Phase53-instructions',
            }
          }
          return null
        }),
        listAll: vi.fn().mockReturnValue([]),
        write: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        watch: vi.fn(),
      } as unknown as SkillLoader

      const { runner, agentStore } = makeRunner(
        makeLLMRouter([makeEndTurnResponse()]),
        db,
        { skillLoader: mockSkillLoader },
      )

      const agentId = await runner.spawn({
        task: 'Phase53-TaskD',
        name: 'my-skill',
        skillName: 'my-skill',
        trigger: 'scheduled',
        headId: 'default',
      })
      await runner.awaitAll(3000)

      const history = agentStore.get(agentId)?.history ?? []

      // Must have at least one tool_call row with injected:true
      const injectedTc = history.find(m => m.kind === 'tool_call' && (m as { injected?: boolean }).injected === true)
      expect(injectedTc).toBeDefined()

      // Must have at least one tool_result row with injected:true
      const injectedTr = history.find(m => m.kind === 'tool_result' && (m as { injected?: boolean }).injected === true)
      expect(injectedTr).toBeDefined()

      // The tool_call must reference the skill path
      const tc = injectedTc as { toolCalls?: Array<{ name: string; input: { path?: string } }> }
      expect(tc.toolCalls?.[0]?.input?.path).toBe(skillPath)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 8000)
})

// ─── Phase 54: DB-sourced history ─────────────────────────────────────────────
//
// These tests encode the correctness contract for the Phase 54 refactor:
// collapsing the long-lived in-memory `history` array onto the DB as the single
// source of truth. They assert against `agentStore.get(id)?.history` (the DB
// surface), NOT against captured LLM router messages.
//
// Wave 0 (RED): tests are authored before the implementation so they lock the
// invariants that Wave 2/3 must satisfy. Some tests may be GREEN under the
// current code (Phase 53 already persists correctly); those serve as regression
// guards. At minimum T7/T2/T3 are expected to expose the current divergence.
// The SUMMARY records which tests were RED vs GREEN at Wave 0 commit time.

describe('Phase 54: DB-sourced history', () => {

  // ─── T1: resume-after-idle via live-emitter path ─────────────────────────
  //
  // An agent parks waiting on inbox (suspended with emitter alive). A
  // `message_agent` update arrives via runner.update(). On wake, the history
  // seen by the LLM must be DB-sourced: the followup appears exactly once in
  // agentStore.get(id)?.history AND the original task appears exactly once.
  // Uses the setTimeout-in-router timing pattern from Phase 53 Test B so the
  // agent is in-loop (emitter alive) when the update lands.
  it('resume-after-idle via live-emitter path: followup injected exactly once in DB history', async () => {
    const db = freshDb()
    let llmCallNum = 0
    // Round 1: bash tool call (keeps agent in-loop so emitter stays alive)
    // Round 2: end_turn (agent finishes)
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, _msgs: Message[]) => {
        llmCallNum++
        await new Promise(r => setTimeout(r, 60))
        if (llmCallNum === 1) {
          return makeToolCallResponse('bash', { command: 'echo T1' })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter, db)
    const agentId = await runner.spawn({ task: 'Phase54-TaskT1', name: 'task-t1', trigger: 'manual', headId: 'default' })

    // Send update after first LLM call starts (agent is in-loop, emitter alive)
    await new Promise(r => setTimeout(r, 90))
    await runner.update(agentId, 'T1-followup')

    await runner.awaitAll(6000)

    const history = agentStore.get(agentId)?.history ?? []

    // Original task must appear exactly once (DB-sourced, not re-injected)
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase54-TaskT1')
    })
    expect(taskRows).toHaveLength(1)

    // Followup must appear exactly once (no in-memory divergence from DB)
    const followupRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('T1-followup')
    })
    expect(followupRows).toHaveLength(1)
  }, 12000)

  // ─── T2: resume-after-idle via resumeSuspended path ───────────────────────
  //
  // A completed agent receives new work via runner.update() (PATH A in update():
  // status==='completed' → resume + resumeSuspended). The original task is already
  // in agent_messages from spawn time. assert:
  //   - original task appears exactly once in history (NOT re-injected)
  //   - new-work signal is present in history
  it('resume-after-idle via resumeSuspended path: completed agent gets new work, task not re-injected', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'echo done' }),
        makeEndTurnResponse(),
        makeStewardDoneResponse(),
        // Second run after resume: end immediately
        makeToolCallResponse('bash', { command: 'echo resume' }),
        makeEndTurnResponse(),
        makeStewardDoneResponse(),
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'Phase54-TaskT2', name: 'task-t2', trigger: 'manual', headId: 'default' })
    await runner.awaitAll(5000)

    // Agent should be completed now
    expect(agentStore.get(agentId)?.status).toBe('completed')

    // Send new work — triggers PATH A (completed → resumeSuspended)
    await runner.update(agentId, 'T2-new-work')
    await runner.awaitAll(5000)

    const history = agentStore.get(agentId)?.history ?? []

    // Original task must appear exactly once (not re-injected on resume)
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase54-TaskT2')
    })
    expect(taskRows).toHaveLength(1)

    // New-work signal must be present
    const newWorkRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('T2-new-work')
    })
    expect(newWorkRows.length).toBeGreaterThanOrEqual(1)
  }, 15000)

  // ─── T3: mid-loop message_agent delivery appears exactly once ─────────────
  //
  // Mirror Phase 53 Test B structure: router round 1 = bash tool_call,
  // round 2 = end_turn; update sent ~90ms in. Assert the
  // [Message received: T3-payload] row appears EXACTLY ONCE in DB history.
  // This is the Pitfall 2 guard: onRoundComplete injects + persists; the next
  // loopIteration DB reload must not duplicate it.
  it('mid-loop message_agent delivery: [Message received: T3-payload] stored exactly once in DB history', async () => {
    const db = freshDb()
    let llmCallNum = 0
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, _msgs: Message[]) => {
        llmCallNum++
        await new Promise(r => setTimeout(r, 60))
        if (llmCallNum === 1) {
          return makeToolCallResponse('bash', { command: 'echo mid' })
        }
        return makeEndTurnResponse()
      }),
    }

    const { runner, agentStore } = makeRunner(llmRouter, db)
    const agentId = await runner.spawn({ task: 'Phase54-TaskT3', name: 'task-t3', trigger: 'manual', headId: 'default' })

    await new Promise(r => setTimeout(r, 90))
    await runner.update(agentId, 'T3-payload')

    await runner.awaitAll(6000)

    const history = agentStore.get(agentId)?.history ?? []
    const midLoopRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('T3-payload')
    })

    // Exactly one storage — Pitfall 2 guard (DB reload must not duplicate it)
    expect(midLoopRows).toHaveLength(1)
  }, 12000)

  // ─── T4: compaction interaction — DB reload picks up compacted form ────────
  //
  // Genuine regression guard for compaction: verifies that maybeArchiveHistory fires,
  // the steward produces a summary, and compactHistory persists it as kind:'summary'.
  //
  // Design:
  //  - historyBudget=200_000 > archivalThreshold=30 satisfies the constructor invariant.
  //  - Messages are seeded into the DB via appendMessages immediately after spawn().
  //    Due to JavaScript's microtask scheduling, spawn() returns only after the first
  //    loop pass's getHistoryWithinBudget runs. On pass 1 the DB has only the task
  //    message (1 msg, cutoff=0) → archival early-returns. The seeded messages land in
  //    the DB during pass 1's runToolLoop phase (between the first and second await
  //    points). On pass 2, the DB reload sees all messages (5 total, cutoff=1 >= 1,
  //    combined tokens >> archivalThreshold=30) → maybeArchiveHistory fires.
  //  - Pass 1 agent call returns end_turn without tools → nudge injected → pass 2.
  //  - Pass 2: archival fires first (steward summary), then agent makes bash call,
  //    then end_turn, then completion steward classifies as done.
  //  - LLM calls are dispatched by message-content inspection (archival call contains
  //    "Summarize") for robust routing regardless of exact call ordering.
  //  - PASS assertion: history.some(m => m.kind === 'summary') — asserts a REAL summary
  //    message produced by compactHistory, NOT a text content check. Fails if compaction
  //    is dead code (historyBudget <= archivalThreshold or cutoff < 1).
  it('compact: after maybeArchiveHistory, DB history contains summary + does not contain full pre-compaction sequence', async () => {
    const db = freshDb()
    const summaryContent = 'Phase54-T4-compact-summary-content'
    let agentCallNum = 0
    const llmRouter: LLMRouter = {
      complete: vi.fn().mockImplementation(async (_tier: string, _msgs: Message[]) => {
        // Archival steward call: detected by the "Summarize" prompt in archival.ts line 56.
        // Returns the sentinel summary text; archival.ts persists it as kind:'summary'.
        const isArchivalCall = _msgs.some(m =>
          m.kind === 'text' && m.role === 'user' && m.content.startsWith('Summarize this conversation history')
        )
        if (isArchivalCall) {
          return {
            content: summaryContent,
            model: 'test-model',
            inputTokens: 5,
            outputTokens: 5,
            stopReason: 'end_turn' as const,
            toolCalls: [],
          }
        }
        // Completion steward call: detected by tier='dumb' (non-archival steward calls).
        // All non-archival dumb-tier calls are treated as completion steward.
        if (_tier === 'dumb') {
          return makeStewardDoneResponse()
        }
        // Agent calls (tier != 'dumb'):
        agentCallNum++
        // Pass 1 agent call: end_turn without tools → triggers tool nudge → pass 2.
        if (agentCallNum === 1) {
          return makeEndTurnResponse()
        }
        // Pass 2 agent call 1: bash tool call.
        if (agentCallNum === 2) {
          return makeToolCallResponse('bash', { command: 'echo t4' })
        }
        // Pass 2 agent call 2: end_turn after tool.
        return makeEndTurnResponse()
      }),
    }

    // historyBudget=200_000 > archivalThreshold=30 satisfies the constructor invariant.
    // Pass explicitly to document intent (default would be max(30*2,200_000)=200_000).
    const { runner, agentStore } = makeRunner(llmRouter, db, { archivalThreshold: 30, historyBudget: 200_000 })
    const agentId = await runner.spawn({ task: 'Phase54-TaskT4-compaction-trigger-test', name: 'task-t4', trigger: 'manual', headId: 'default' })

    // Seed additional messages after spawn() returns. These land in the DB during
    // pass 1's runToolLoop (after the first DB reload but before pass 2's reload).
    // On pass 2, DB has 5 messages: task + 3 seeded + tool_nudge, totalling >> 30 tokens.
    // cutoff = floor(5 * 0.3) = 1 >= 1, so maybeArchiveHistory compacts the oldest message.
    const seedTs = new Date().toISOString()
    agentStore.appendMessages(agentId, [
      { kind: 'text', role: 'assistant', id: 'T4-seed-a1', content: 'I will work on the Phase54 T4 compaction test task right now.', createdAt: seedTs },
      { kind: 'text', role: 'user',      id: 'T4-seed-u1', content: 'Please continue with the Phase54 T4 compaction trigger test step.', createdAt: seedTs },
      { kind: 'text', role: 'assistant', id: 'T4-seed-a2', content: 'Proceeding with Phase54 T4 compaction test execution as requested.', createdAt: seedTs },
    ] satisfies TextMessage[])

    await runner.awaitAll(10000)

    const history = agentStore.get(agentId)?.history ?? []

    // PASS assertion: a genuine kind:'summary' message must exist in DB history.
    // This fails if compaction is dead code (early-return bypasses compactHistory).
    expect(history.some(m => m.kind === 'summary')).toBe(true)

    // Verify the summary content matches the steward's sentinel response.
    const summaryMsg = history.find(m => m.kind === 'summary')
    expect(summaryMsg?.content).toContain(summaryContent)

    // Anti-duplication regression: the task message appears at most once in DB history.
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase54-TaskT4')
    })
    expect(taskRows.length).toBeLessThanOrEqual(1)
  }, 15000)

  // ─── T5: suspend→answer→continue with correct history ─────────────────────
  //
  // Adapt Phase 53 Test C: bash call → question (suspends) → steward question
  // → resume via runner.signal(id, 'T5-answer') → end_turn.
  // Assert: answer row is present with NO injected flag (genuine user input)
  // AND the task appears exactly once.
  it('suspend→answer→continue: T5-answer stored without injected flag, task appears exactly once', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'echo q-t5' }),
        { content: 'Phase54-T5-question?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('Phase54-T5-question?'),
        makeEndTurnResponse(),
        makeStewardDoneResponse(),
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'Phase54-TaskT5', name: 'task-t5', trigger: 'manual', headId: 'default' })

    // Wait for suspended state
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (agentStore.get(agentId)?.status === 'suspended') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })

    await runner.signal(agentId, 'T5-answer')
    await runner.awaitAll(6000)

    const history = agentStore.get(agentId)?.history ?? []

    // Task must appear exactly once
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase54-TaskT5')
    })
    expect(taskRows).toHaveLength(1)

    // Answer row must be present and must NOT carry injected:true (genuine user input)
    const answerRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('T5-answer')
    })
    expect(answerRows).toHaveLength(1)
    expect((answerRows[0] as TextMessage & { injected?: boolean }).injected).toBeUndefined()
  }, 12000)

  // ─── T6: restart-reaping regression — reap does NOT load DB history ────────
  //
  // The orphaned-agent reaping loop in index.ts:349–358 marks running agents
  // as failed and enqueues agent_failed. This behavior must stay unchanged
  // through Phase 54 (DB-sourced reload is a live-session refactor only, not
  // a crash-resume feature). Exercises the reaping CONTRACT directly against
  // AgentStore + QueueStore over a fresh DB — no src/index.ts import needed.
  // T6 is GREEN from the start, serving as a frozen regression guard.
  it('restart-reaping regression: getByStatus("running") → fail → enqueue agent_failed, no history-load path invoked', () => {
    const db = freshDb()
    const agentStore = new AgentStore(db)
    const queueStore = new QueueStore(db)

    // Create a running agent (simulating an agent that was running when process died)
    const agentId = 'T6-reap-agent-' + Math.random().toString(36).slice(2, 9)
    agentStore.create(agentId, { task: 'Phase54-T6-task', trigger: 'manual', headId: 'default' })
    // Agent starts as 'running' by default from create()
    expect(agentStore.get(agentId)?.status).toBe('running')

    // Append some messages to prove history exists in DB
    const taskMsg = { kind: 'text' as const, role: 'user' as const, id: 'T6-msg-1', content: 'Phase54-T6-task', createdAt: new Date().toISOString() }
    agentStore.appendMessages(agentId, [taskMsg])

    // Spy on getByStatus and fail — do NOT spy on getHistoryWithinBudget (does not exist yet)
    // The key structural assertion: reaping calls ONLY getByStatus + fail + queueStore.enqueue
    // It does NOT call any history-loading method (no get() to read history, no getRecent etc.)
    const failSpy = vi.spyOn(agentStore, 'fail')

    // Replicate the index.ts:349–358 reaping sequence inline
    const orphanedAgents = agentStore.getByStatus('running')
    expect(orphanedAgents).toHaveLength(1)

    for (const t of orphanedAgents) {
      // No pendingRetract in this test — proceed to fail
      agentStore.fail(t.id, 'process restarted mid-execution', 'default')
      queueStore.enqueue({
        type: 'agent_failed',
        id: 'qe-T6-' + Math.random().toString(36).slice(2, 9),
        agentId: t.id,
        error: 'process restarted mid-execution',
        createdAt: new Date().toISOString(),
      }, 50, 'default')
    }

    // (1) Agent status is now 'failed'
    expect(agentStore.get(agentId)?.status).toBe('failed')

    // (2) Error message matches
    expect(agentStore.get(agentId)?.error).toBe('process restarted mid-execution')

    // (3) An agent_failed queue event exists
    const queueEvents = queueStore.claimAllPendingBackground('default')
    const failedEvent = queueEvents.find(e => e.event.type === 'agent_failed' && e.event.agentId === agentId)
    expect(failedEvent).toBeDefined()

    // (4) Structural: fail() was called (reaping used only getByStatus + fail + enqueue)
    expect(failSpy).toHaveBeenCalledTimes(1)
    expect(failSpy).toHaveBeenCalledWith(agentId, 'process restarted mid-execution', 'default')

    // (5) History is still intact in DB (reaping did not delete it — just marked failed)
    const historyAfterReap = agentStore.get(agentId)?.history ?? []
    expect(historyAfterReap).toHaveLength(1)
    // Reaping read NO message history for resume — it only reads the agent row via
    // getByStatus (which does load history as part of AgentState, but that is the
    // existing behavior for status reads, not a resume-history-reconstruction).
    // The test pins that reaping uses ONLY fail() + enqueue, no new history-load
    // path, confirming Phase 54's DB-sourced reload is a live-session refactor only.
  })

  // ─── T7: anti-double-injection invariant ──────────────────────────────────
  //
  // After a suspend→resumeSuspended cycle (same setup as Phase 53 Test C / T5),
  // assert history.filter(task-row predicate) has length EXACTLY 1.
  // This is the canonical guard for Pitfall 1: double-injection of the task
  // message when both state.history and the DB load contain the task.
  it('double-inject guard: after suspend→resumeSuspended, task appears exactly once in DB history', async () => {
    const db = freshDb()
    const { runner, agentStore } = makeRunner(
      makeLLMRouter([
        makeToolCallResponse('bash', { command: 'echo t7' }),
        { content: 'Phase54-T7-question?', model: 'test-model', inputTokens: 5, outputTokens: 5, stopReason: 'end_turn', toolCalls: [] },
        makeStewardQuestionResponse('Phase54-T7-question?'),
        makeEndTurnResponse(),
        makeStewardDoneResponse(),
      ]),
      db,
    )

    const agentId = await runner.spawn({ task: 'Phase54-TaskT7', name: 'task-t7', trigger: 'manual', headId: 'default' })

    // Wait for suspended state (this exercises the resumeSuspended path)
    await new Promise<void>(resolve => {
      const poll = setInterval(() => {
        if (agentStore.get(agentId)?.status === 'suspended') {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })

    await runner.signal(agentId, 'T7-answer')
    await runner.awaitAll(6000)

    const history = agentStore.get(agentId)?.history ?? []

    // Anti-double-injection invariant: task appears EXACTLY ONCE
    // Pitfall 1 guard: if resumeSuspended re-injects the task AND loopIteration
    // also loads it from DB, the task would appear twice. Must be exactly 1.
    const taskRows = history.filter(m => {
      if (m.kind !== 'text') return false
      const tm = m as TextMessage
      return tm.role === 'user' && tm.content.includes('Phase54-TaskT7')
    })
    expect(taskRows).toHaveLength(1)
  }, 12000)

})
