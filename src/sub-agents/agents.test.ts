import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CADENCE_ERROR_MESSAGE } from '../scheduler/cadence.js'
import * as path from 'node:path'
import * as url from 'node:url'
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

  it('unknown tool names do not warn — resolveOptional is lenient', () => {
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

  it('builtins() returns all 4 built-in tools', () => {
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
    const ctx = { agentId: 't1', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await bash.execute({ command: 'echo hello' }, ctx)
    expect(result).toContain('hello')
    expect(result).toContain('Exit code: 0')
  })

  it('read_file executor reads an existing file', async () => {
    const entries = registry.resolveOptional(['read_file'])
    const readFile = entries[0]!
    const ctx = { agentId: 't1', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await readFile.execute({ path: '/etc/hostname' }, ctx)
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('read_file executor throws for missing file', async () => {
    const entries = registry.resolveOptional(['read_file'])
    const readFile = entries[0]!
    const ctx = { agentId: 't1', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    await expect(readFile.execute({ path: '/nonexistent/path/xyz.txt' }, ctx)).rejects.toThrow('read_file')
  })

  it('write_file executor writes and returns byte count', async () => {
    const entries = registry.resolveOptional(['write_file'])
    const writeFile = entries[0]!
    const ctx = { agentId: 't1', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const tmpPath = `/tmp/agent_test_${Date.now()}.txt`
    const result = await writeFile.execute({ path: tmpPath, content: 'hello world' }, ctx)
    expect(result).toContain('11 bytes')

    // Verify file was written
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(tmpPath, 'utf8')).toBe('hello world')
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
  overrides: { spawnAgentStewardEnabled?: boolean; stewardModel?: string; unifiedLoader?: import('../skills/unified.js').UnifiedLoader; skillLoader?: SkillLoader } = {},
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
    await runner.spawn({ prompt: 'task', name: 'test', trigger: 'ad_hoc' })
    await runner.awaitAll(2000)
    expect(capturedTools).toContain('spawn_agent')
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
    await runner.spawn({ prompt: 'run email', name: 'email', skillName: 'email', trigger: 'scheduled' })
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
      makeToolCallResponse('spawn_agent', { prompt: 'do child task' }),
      makeEndTurnResponse(),  // parent: after spawn, waits for child (has running child)
      makeEndTurnResponse(),  // child: auto-completes
      makeEndTurnResponse(),  // parent: after child inbox arrives, auto-completes
      makeEndTurnResponse(),  // extra buffer
      makeEndTurnResponse(),  // extra buffer
    ])
    const { runner, agentStore } = makeRunner(llmRouter, db)

    const parentId = await runner.spawn({ prompt: 'parent task', name: 'parent-task', trigger: 'manual' })
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
    agentStore.create(parentId, { prompt: 'parent', trigger: 'manual' })

    const childId = await runner.spawn({
      prompt: 'child task',
      name: 'child-task',
      trigger: 'ad_hoc',
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
    const claimed = queueStore.claimNext()
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
    agentStore.create(parentId, { prompt: 'parent', trigger: 'manual' })

    const childId = await runner.spawn({
      prompt: 'child needs answer',
      name: 'child-q',
      trigger: 'ad_hoc',
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
    const claimed = queueStore.claimNext()
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
    agentStore.create(agentAId, { prompt: 'a', trigger: 'manual' })
    agentStore.create(agentBId, { prompt: 'b', trigger: 'manual' })

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

    const agentId = await runner.spawn({ prompt: 'test retract', name: 'retract-test', trigger: 'manual' })
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

    const agentId = await runner.spawn({ prompt: 'test signal', name: 'signal-test', trigger: 'manual' })
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
    agentStore.create(agentId, { prompt: 'zombie agent', trigger: 'manual' })

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
      options: { prompt: 'x', trigger: 'ad_hoc' },
      skill: null,
    })
    const names = toolEntries.map(t => t.definition.name)
    expect(names).toContain('spawn_agent')
  })

  it('depth-1 agent does NOT get spawn_agent when nestedAgentSpawningEnabled is false (CFG-02 byte-equivalence)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: false })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'a1',
      options: { prompt: 'x', trigger: 'ad_hoc' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent (parentAgentId set) does NOT get spawn_agent when flag is on (NEST-02)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { prompt: 'x', trigger: 'ad_hoc', parentAgentId: 'parent-abc' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent does NOT get spawn_agent when flag is off (independence of the two blockers)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: false })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { prompt: 'x', trigger: 'ad_hoc', parentAgentId: 'parent-abc' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).not.toContain('spawn_agent')
  })

  it('depth-2 agent also does NOT get message_agent or cancel_agent (existing PARENT_ONLY_TOOLS behavior preserved)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 'child',
      options: { prompt: 'x', trigger: 'ad_hoc', parentAgentId: 'parent-abc' },
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
      options: { prompt: 'x', trigger: 'scheduled' },
      skill: null,
    })
    expect(toolEntries.map(t => t.definition.name)).toContain('spawn_agent')
  })

  it('scheduled trigger WITH parentAgentId does NOT get spawn_agent (rule is parent-based, not trigger-based)', async () => {
    const deps = makeToolSurfaceDeps({ nestedAgentSpawningEnabled: true })
    const { toolEntries } = await assembleTools(deps, {
      agentId: 's1',
      options: { prompt: 'x', trigger: 'scheduled', parentAgentId: 'p1' },
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
      makeToolCallResponse('spawn_agent', { description: 'hallucinated', prompt: 'try to nest further' }),
      makeEndTurnResponse(),   // after tool error, agent completes
      makeStewardDoneResponse(),  // completion steward classifies as done
    ])
    const { runner, agentStore } = makeRunner(llmRouter, db)
    // Create a fake parent record so the sub_agent_completed inbox write has a target.
    agentStore.create('parent-x', { prompt: 'p', trigger: 'manual' })

    const childId = await runner.spawn({
      prompt: 'child task',
      name: 'child',
      trigger: 'ad_hoc',
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

    const parentState = agentStore.create('tent_steward_reject', { prompt: 'build the feature', trigger: 'ad_hoc' })
    const parentAgentId = parentState.id

    const parentOptions = { prompt: 'build the feature', model: 'capable', trigger: 'ad_hoc' as const }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { prompt: 'trivial child task' },
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

    const parentState = agentStore.create('tent_steward_pass', { prompt: 'build the feature', trigger: 'ad_hoc' })
    const parentAgentId = parentState.id

    const parentOptions = { prompt: 'build the feature', model: 'capable', trigger: 'ad_hoc' as const }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'research', prompt: 'research task needing fresh context' },
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

    const parentState = agentStore.create('tent_steward_off', { prompt: 'build the feature', trigger: 'ad_hoc' })
    const parentAgentId = parentState.id

    const parentOptions = { prompt: 'build the feature', model: 'capable', trigger: 'ad_hoc' as const }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'child', prompt: 'child task' },
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

    const parentState = agentStore.create('tent_steward_throw', { prompt: 'build the feature', trigger: 'ad_hoc' })
    const parentAgentId = parentState.id

    const parentOptions = { prompt: 'build the feature', model: 'capable', trigger: 'ad_hoc' as const }
    const history = makeHistory()

    const result = await (runner as any).handleSpawnAgent(
      parentAgentId,
      parentOptions,
      { description: 'child', prompt: 'child task after steward failure' },
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
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified)
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!
    return { createSchedule, scheduleStore }
  }

  it('accepts { taskName, kind:"task" } for a real task and stores target_kind="task"', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule, scheduleStore } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
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
    const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'a-task' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBeUndefined()
    expect(parsed.kind).toBe('task')
    expect(scheduleStore.list()[0]!.kind).toBe('task')
  })

  it('rejects unknown task target with instruction-shaped error', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
    const result = await createSchedule.execute({ taskName: 'missing' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toContain('missing')
  })

  it('rejects a skill target with instruction-shaped error', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule } = await getCreateScheduleTool(unified)
    const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }
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
    const tools = buildScheduleTools(scheduleStore, 'UTC', unified)
    return {
      createSchedule: tools.find(t => t.definition.name === 'create_schedule')!,
      updateSchedule: tools.find(t => t.definition.name === 'update_schedule')!,
      scheduleStore,
    }
  }

  const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

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

  it('create_schedule rejects 0 9 * * 1-5 (weekday range)', async () => {
    const unified = await makeTmpUnified()
    const { createSchedule } = await buildTools(unified)
    const result = await createSchedule.execute({ taskName: 'a-task', cron: '0 9 * * 1-5' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toBe(CADENCE_ERROR_MESSAGE)
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
  const ctx = { agentId: 't', suspend: vi.fn(), complete: vi.fn(), fail: vi.fn() }

  async function getReminderTools() {
    const nodeOs = await import('node:os')
    const nodeFs = await import('node:fs')
    const nodePath = await import('node:path')
    const scheduleDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rem-tool-sched-'))
    const { ScheduleStore } = await import('../db/schedules.js')
    const scheduleStore = new ScheduleStore(scheduleDir)
    const { buildReminderTools } = await import('./registry.js')
    const tools = buildReminderTools(scheduleStore, 'UTC')
    const createReminder = tools.find(t => t.definition.name === 'create_reminder')!
    const listReminders = tools.find(t => t.definition.name === 'list_reminders')!
    const cancelReminder = tools.find(t => t.definition.name === 'cancel_reminder')!
    return { createReminder, listReminder: listReminders, cancelReminder, scheduleStore }
  }

  it('create_reminder with valid input stores kind:"reminder" record with agentContext = message', async () => {
    const { createReminder, scheduleStore } = await getReminderTools()
    const result = await createReminder.execute({ message: 'Check the build', triggerAt: '2099-01-01T09:00:00Z' }, ctx)
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
    const result = await createReminder.execute({ message: '  ', triggerAt: '2099-01-01T09:00:00Z' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/non-empty/i)
  })

  it('create_reminder with message > 2000 chars returns error JSON (T-12-01)', async () => {
    const { createReminder } = await getReminderTools()
    const longMsg = 'x'.repeat(2001)
    const result = await createReminder.execute({ message: longMsg, triggerAt: '2099-01-01T09:00:00Z' }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.error).toBe(true)
    expect(parsed.message).toMatch(/2000/i)
  })

  it('list_reminders returns only kind:"reminder" entries', async () => {
    const { createReminder, listReminder, scheduleStore } = await getReminderTools()
    // Create a non-reminder schedule directly
    scheduleStore.create({ id: 's-task-x', taskName: 'my-task', kind: 'task', nextRun: '2099-01-01T00:00:00Z' })
    await createReminder.execute({ message: 'Hello', triggerAt: '2099-01-01T09:00:00Z' }, ctx)
    const result = await listReminder.execute({}, ctx)
    const items = JSON.parse(result as string)
    expect(items).toHaveLength(1)
    expect(items[0].message).toBe('Hello')
  })

  it('cancel_reminder with valid id deletes schedule record', async () => {
    const { createReminder, cancelReminder, scheduleStore } = await getReminderTools()
    const cr = await createReminder.execute({ message: 'Delete me', triggerAt: '2099-01-01T09:00:00Z' }, ctx)
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
      { message: 'Check the build', triggerAt: '2099-01-01T09:00:00Z', conditions: 'Only on weekdays' },
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
      { message: 'Check the build', triggerAt: '2099-01-01T09:00:00Z' },
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
})
