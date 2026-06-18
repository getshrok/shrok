/**
 * Phase 47 Plan 01 — Head-loop dispatch tests for agent-registry tools.
 *
 * Proves four behaviors (TOOLCFG-10/11):
 *  1. read_file — dispatched in the head loop, returns file content (NOT 'Unknown tool')
 *  2. create_reminder — creates a reminder owned by the head's own headId (D-11)
 *  3. write_note → list_notes — note round-trips through the global pool (D-10)
 *  4. bash — runs a shell command in the daemon cwd, returns real stdout (D-08)
 *
 * Uses the same HeadToolExecutor harness as head-tools.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { vi } from 'vitest'
import { HeadToolExecutor } from './index.js'
import { FileSystemIdentityLoader } from '../identity/loader.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { NoteStore } from '../db/notes.js'
import { ScheduleStore } from '../db/schedules.js'
import type { AgentRunner } from '../types/agent.js'
import type { Memory } from '../memory/index.js'
import type { SkillLoader } from '../types/skill.js'
import type { UsageStore } from '../db/usage.js'
import type { MessageStore } from '../db/messages.js'

// ─── Harness helpers (mirror head-tools.test.ts) ─────────────────────────────

function makeWorkerRunner(): AgentRunner {
  return {
    spawn: vi.fn().mockResolvedValue('test-agent-1'),
    update: vi.fn().mockResolvedValue(undefined),
    signal: vi.fn().mockResolvedValue(undefined),
    retract: vi.fn().mockResolvedValue(undefined),
    checkStatus: vi.fn().mockResolvedValue({ text: 'working', stale: false }),
    awaitAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRunner
}

function makeTopicMemory(): Memory {
  return {
    chunk: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
    getTopics: vi.fn().mockResolvedValue([]),
    deleteTopic: vi.fn().mockResolvedValue(undefined),
  } as unknown as Memory
}

function makeUsageStore(): UsageStore {
  return {
    summarize: vi.fn().mockReturnValue({ inputTokens: 100, outputTokens: 50 }),
    getBySourceType: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 }),
    getEstimatedCostToday: vi.fn().mockReturnValue(0),
    getCostSince: vi.fn().mockReturnValue(0),
    getSummary: vi.fn().mockReturnValue({ costUsd: 0, inputTokens: 0, outputTokens: 0, byModel: {}, bySourceType: {}, bySource: {} }),
    record: vi.fn(),
  } as unknown as UsageStore
}

const MIGRATIONS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../sql')

// ─── Head dispatch — agent-registry tools ────────────────────────────────────

describe('HeadToolExecutor — dispatch to agent-registry tools (Phase 47)', () => {
  let runner: AgentRunner
  let memory: Memory
  let skillLoader: SkillLoader
  let usageStore: UsageStore
  let tmpDir: string
  let dbTmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-agent-tools-test-'))
    dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-agent-tools-db-'))

    runner = makeWorkerRunner()
    memory = makeTopicMemory()
    usageStore = makeUsageStore()
    skillLoader = {
      load: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      watch: vi.fn(),
    } as unknown as SkillLoader
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(dbTmpDir, { recursive: true, force: true })
  })

  // ── Test 1: read_file ───────────────────────────────────────────────────────
  it('dispatches read_file — reads actual file content, NOT "Unknown tool"', async () => {
    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)
    const executor = new HeadToolExecutor({
      headId: 'default',
      agentRunner: runner,
      skillLoader,
      topicMemory: memory,
      usageStore,
      identityDir: tmpDir,
      identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
      timezone: 'UTC',
    })

    // Write a sentinel file
    const sentinelFile = path.join(tmpDir, 'sentinel.txt')
    fs.writeFileSync(sentinelFile, 'hello-from-head-read-file', 'utf8')

    const result = await executor.execute({ id: 'tc-read', name: 'read_file', input: { path: sentinelFile } })
    const content = result.content as string

    // Must NOT be an unknown-tool error
    expect(content).not.toContain('Unknown tool')
    // Must contain the file body
    expect(content).toContain('hello-from-head-read-file')
  })

  // ── Test 2: create_reminder — reminder owned by head's headId ──────────────
  it('dispatches create_reminder — reminder is stamped with the head\'s own headId (D-11)', async () => {
    const schedulesDir = path.join(dbTmpDir, 'schedules')
    const scheduleStore = new ScheduleStore(schedulesDir)
    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)

    // Use a non-default headId so we can prove the stamp is not hardcoded
    const executor = new HeadToolExecutor({
      headId: 'work',
      agentRunner: runner,
      skillLoader,
      topicMemory: memory,
      usageStore,
      identityDir: tmpDir,
      identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
      scheduleStore,
      timezone: 'UTC',
    })

    // create_reminder requires a future time — use a time 1 day from now in model-time format
    // The field name is 'triggerAt' (workspace-local YYYY-MM-DD HH:MM, no Z/offset)
    const tomorrow = new Date(Date.now() + 86400000)
    const ymd = tomorrow.toISOString().slice(0, 10)
    const reminderTime = `${ymd} 09:00`

    const result = await executor.execute({
      id: 'tc-reminder',
      name: 'create_reminder',
      input: { message: 'test reminder from head', triggerAt: reminderTime },
    })
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>

    // Should not be an error
    expect(parsed['error']).toBeUndefined()

    // The created reminder must exist in the store, stamped with headId: 'work'
    const schedules = scheduleStore.list()
    const reminders = schedules.filter(s => s.kind === 'reminder')
    expect(reminders.length).toBeGreaterThan(0)
    const reminder = reminders[0]!
    expect(reminder.headId).toBe('work')
    expect(reminder.agentContext).toBe('test reminder from head')
  })

  // ── Test 3: note tools are DISABLED — not head-dispatchable ────────────────
  // Note tools were disabled (operator preference; see NOTE_TOOL_NAMES in registry.ts).
  // Even with a NoteStore wired (it still backs the dashboard's read-only view), the head
  // must NOT be able to dispatch write_note/list_notes — they are no longer in the map.
  it('does NOT dispatch write_note/list_notes — note tools are disabled (NOTE_TOOL_NAMES empty)', async () => {
    const db = initDb(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    const noteStore = new NoteStore(db)
    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)

    const executor = new HeadToolExecutor({
      headId: 'default',
      agentRunner: runner,
      skillLoader,
      topicMemory: memory,
      usageStore,
      identityDir: tmpDir,
      identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
      noteStore,
      timezone: 'UTC',
    })

    // write_note is not a known head tool → handled as an unknown tool, never executed
    const writeResult = await executor.execute({
      id: 'tc-note-write',
      name: 'write_note',
      input: { title: 'head-note-title', content: 'head-note-content' },
    })
    expect(writeResult.content as string).toContain('Unknown tool')

    const listResult = await executor.execute({
      id: 'tc-note-list',
      name: 'list_notes',
      input: {},
    })
    expect(listResult.content as string).toContain('Unknown tool')
  })

  // ── Test 4: bash — runs command in daemon cwd (D-08) ──────────────────────
  it('dispatches bash — runs a shell command and returns real stdout (D-08)', async () => {
    const identityLoader = new FileSystemIdentityLoader(tmpDir, tmpDir)
    const executor = new HeadToolExecutor({
      headId: 'default',
      agentRunner: runner,
      skillLoader,
      topicMemory: memory,
      usageStore,
      identityDir: tmpDir,
      identityLoader,
      messages: { getAll: () => [] } as unknown as MessageStore,
      timezone: 'UTC',
    })

    const result = await executor.execute({
      id: 'tc-bash',
      name: 'bash',
      input: { command: 'echo head-ran-bash' },
    })
    const content = result.content as string

    // Must NOT be an unknown-tool error
    expect(content).not.toContain('Unknown tool')
    // Must contain the sentinel output from the echo command
    expect(content).toContain('head-ran-bash')
  })
})
