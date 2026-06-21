/**
 * registry.test.ts — sentinel + boundary tests for model↔time invariant (issue #18).
 *
 * Task 2: Input description rewrites + parse/guard tests
 * Task 3: Output renderer tests (list_schedules, list_reminders, get_file_info)
 * Task 4: Final-sweep sentinel (grep descriptions from disk)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildUsageTool, buildScheduleTools, buildReminderTools } from './registry.js'
import { HEAD_TOOLS } from '../head/index.js'
import type { Schedule } from '../db/schedules.js'
import type { AgentContext } from '../types/agent.js'

// ─── Stub factories ───────────────────────────────────────────────────────────

const TIMEZONE = 'America/New_York'

function makeCtx(): AgentContext {
  return {
    agentId: 'test-agent',
    headId: 'default',
    timezone: TIMEZONE,
    suspend: () => {},
    complete: (_out: string) => {},
    fail: (_err: string) => {},
  }
}

function makeUsageStore(overrides?: Partial<{ getSummary: (since?: string) => unknown }>) {
  return {
    getSummary: (_since?: string) => ({
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.0001,
      byModel: {},
      bySourceType: {},
      bySource: [],
    }),
    ...overrides,
  } as unknown as import('../db/usage.js').UsageStore
}

function makeScheduleStore(schedules: Schedule[] = []) {
  const store = {
    list: () => schedules,
    create: (_opts: unknown) => {
      throw new Error('stub: create should not be called in rejection tests')
    },
    update: (_id: string, _patch: unknown) => null,
    get: (_id: string) => null,
    delete: (_id: string) => {},
    markFired: () => {},
    advanceNextRun: () => {},
    markSkipped: () => {},
    deleteAllForHead: () => ({ schedules: 0, reminders: 0 }),
    getDue: () => [],
  }
  return store as unknown as import('../db/schedules.js').ScheduleStore
}

// ─── Task 2: Sentinel — input descriptions ────────────────────────────────────

describe('Sentinel: model-facing input descriptions (Task 2)', () => {
  const usageTool = buildUsageTool(makeUsageStore(), TIMEZONE)
  const scheduleTools = buildScheduleTools(makeScheduleStore(), TIMEZONE, null, 'default')
  const reminderTools = buildReminderTools(makeScheduleStore(), TIMEZONE, 'default')

  const usageDef = usageTool.definition
  const createScheduleDef = scheduleTools.find(t => t.definition.name === 'create_schedule')!.definition
  const updateScheduleDef = scheduleTools.find(t => t.definition.name === 'update_schedule')!.definition
  const createReminderDef = reminderTools.find(t => t.definition.name === 'create_reminder')!.definition

  // get_usage.since
  it('get_usage.since description contains YYYY-MM-DD HH:MM', () => {
    const desc = (usageDef.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).toContain('YYYY-MM-DD HH:MM')
  })

  it('get_usage.since description does not contain Z"', () => {
    const desc = (usageDef.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).not.toMatch(/"[^"]*Z"/)
  })

  it('get_usage.since description does not contain the word ISO as a format prescription', () => {
    const desc = (usageDef.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).not.toMatch(/\bISO\b/)
  })

  it('get_usage.since description does not contain the word UTC as a format prescription', () => {
    const desc = (usageDef.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).not.toMatch(/\bUTC\b/)
  })

  // create_schedule.runAt
  it('create_schedule.runAt description contains YYYY-MM-DD HH:MM', () => {
    const desc = (createScheduleDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['runAt']?.description ?? ''
    expect(desc).toContain('YYYY-MM-DD HH:MM')
  })

  it('create_schedule.runAt description does not contain Z"', () => {
    const desc = (createScheduleDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['runAt']?.description ?? ''
    expect(desc).not.toMatch(/"[^"]*Z"/)
  })

  it('create_schedule.runAt description does not contain ISO/UTC as format prescription', () => {
    const desc = (createScheduleDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['runAt']?.description ?? ''
    expect(desc).not.toMatch(/\bISO\b/)
    expect(desc).not.toMatch(/\bUTC\b/)
  })

  // update_schedule.runAt
  it('update_schedule.runAt description contains YYYY-MM-DD HH:MM', () => {
    const desc = (updateScheduleDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['runAt']?.description ?? ''
    expect(desc).toContain('YYYY-MM-DD HH:MM')
  })

  it('update_schedule.runAt description does not contain Z"', () => {
    const desc = (updateScheduleDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['runAt']?.description ?? ''
    expect(desc).not.toMatch(/"[^"]*Z"/)
  })

  // create_reminder.triggerAt
  it('create_reminder.triggerAt description contains YYYY-MM-DD HH:MM', () => {
    const desc = (createReminderDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['triggerAt']?.description ?? ''
    expect(desc).toContain('YYYY-MM-DD HH:MM')
  })

  it('create_reminder.triggerAt description does not contain Z"', () => {
    const desc = (createReminderDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['triggerAt']?.description ?? ''
    expect(desc).not.toMatch(/"[^"]*Z"/)
  })

  it('create_reminder.triggerAt description does not contain ISO/UTC as format prescription', () => {
    const desc = (createReminderDef.inputSchema as { properties: Record<string, { description?: string }> }).properties['triggerAt']?.description ?? ''
    expect(desc).not.toMatch(/\bISO\b/)
    expect(desc).not.toMatch(/\bUTC\b/)
  })

  // HEAD_TOOLS get_usage.since
  it('HEAD_TOOLS get_usage.since description contains YYYY-MM-DD HH:MM', () => {
    const getUsageTool = HEAD_TOOLS.find(t => t.name === 'get_usage')!
    const desc = (getUsageTool.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).toContain('YYYY-MM-DD HH:MM')
  })

  it('HEAD_TOOLS get_usage.since description does not contain Z"', () => {
    const getUsageTool = HEAD_TOOLS.find(t => t.name === 'get_usage')!
    const desc = (getUsageTool.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).not.toMatch(/"[^"]*Z"/)
  })

  it('HEAD_TOOLS get_usage.since description does not contain ISO/UTC as format prescription', () => {
    const getUsageTool = HEAD_TOOLS.find(t => t.name === 'get_usage')!
    const desc = (getUsageTool.inputSchema as { properties: { since: { description: string } } }).properties.since.description
    expect(desc).not.toMatch(/\bISO\b/)
    expect(desc).not.toMatch(/\bUTC\b/)
  })
})

// ─── Task 2: Boundary — Z-input rejection ─────────────────────────────────────

describe('Boundary: Z-suffixed input rejection (Task 2)', () => {
  const ctx = makeCtx()

  it('get_usage rejects Z-suffixed since', async () => {
    const usageTool = buildUsageTool(makeUsageStore(), TIMEZONE)
    const execute = usageTool.execute
    const result = JSON.parse(await execute({ since: '2026-04-15T00:00:00Z' }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message).toMatch(/YYYY-MM-DD/i)
  })

  it('create_schedule rejects Z-suffixed runAt (rejection short-circuits before store call)', async () => {
    const storeCalledCreate = { value: false }
    const scheduleStore = makeScheduleStore()
    scheduleStore.create = () => { storeCalledCreate.value = true; throw new Error('should not be called') }
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const createSchedule = scheduleTools.find(t => t.definition.name === 'create_schedule')!
    const result = JSON.parse(await createSchedule.execute({ taskName: 'my-task', runAt: '2026-04-15T09:00:00Z' }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message).toMatch(/YYYY-MM-DD/i)
    expect(storeCalledCreate.value).toBe(false)
  })

  it('update_schedule rejects Z-suffixed runAt', async () => {
    const scheduleStore = makeScheduleStore()
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const updateSchedule = scheduleTools.find(t => t.definition.name === 'update_schedule')!
    const result = JSON.parse(await updateSchedule.execute({ id: 'sched-1', runAt: '2026-04-15T09:00:00Z' }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message).toMatch(/YYYY-MM-DD/i)
  })

  it('create_reminder rejects Z-suffixed triggerAt (rejection short-circuits before store call)', async () => {
    const storeCalledCreate = { value: false }
    const scheduleStore = makeScheduleStore()
    scheduleStore.create = () => { storeCalledCreate.value = true; throw new Error('should not be called') }
    const reminderTools = buildReminderTools(scheduleStore, TIMEZONE, 'default')
    const createReminder = reminderTools.find(t => t.definition.name === 'create_reminder')!
    const result = JSON.parse(await createReminder.execute({ message: 'ping', triggerAt: '2026-04-15T09:00:00Z' }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message).toMatch(/YYYY-MM-DD/i)
    expect(storeCalledCreate.value).toBe(false)
  })
})

// ─── Task 2: Past-time guard ───────────────────────────────────────────────────

describe('Past-time guard (Task 2)', () => {
  const ctx = makeCtx()

  it('create_reminder returns past-time error for triggerAt 60s in the past', async () => {
    const scheduleStore = makeScheduleStore()
    scheduleStore.create = () => { throw new Error('should not be called') }
    const reminderTools = buildReminderTools(scheduleStore, TIMEZONE, 'default')
    const createReminder = reminderTools.find(t => t.definition.name === 'create_reminder')!

    // Build a triggerAt 60s in the past in workspace tz
    const pastDate = new Date(Date.now() - 60_000)
    const { formatModelTime } = await import('../util/model-time.js')
    const pastStr = formatModelTime(pastDate, TIMEZONE)

    const result = JSON.parse(await createReminder.execute({ message: 'ping', triggerAt: pastStr }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message.toLowerCase()).toContain('pick a time in the future')
    // Must contain both timestamps in canonical format
    expect(result.message).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('create_schedule returns past-time error for runAt 60s in the past', async () => {
    const scheduleStore = makeScheduleStore()
    scheduleStore.create = () => { throw new Error('should not be called') }
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const createSchedule = scheduleTools.find(t => t.definition.name === 'create_schedule')!

    const pastDate = new Date(Date.now() - 60_000)
    const { formatModelTime } = await import('../util/model-time.js')
    const pastStr = formatModelTime(pastDate, TIMEZONE)

    const result = JSON.parse(await createSchedule.execute({ taskName: 'my-task', runAt: pastStr }, ctx) as string)
    expect(result.error).toBe(true)
    expect(result.message.toLowerCase()).toContain('pick a time in the future')
  })
})

// ─── create_schedule kind:'script' (sensor scheduling) ───────────────────────

describe('create_schedule kind:script (sensor scheduling)', () => {
  const ctx = makeCtx()

  function makeCapturingStore() {
    const created: Array<Record<string, unknown>> = []
    const base = makeScheduleStore() as unknown as Record<string, unknown>
    const store = {
      ...base,
      create: (opts: Record<string, unknown>) => { created.push(opts); return { ...opts } },
    }
    return { store: store as unknown as import('../db/schedules.js').ScheduleStore, created }
  }

  it('creates a kind:script schedule from a bare slug, bypassing the task loader', async () => {
    const { store, created } = makeCapturingStore()
    // A loader that throws if consulted — proves script kind never hits task validation.
    const loader = { loadByName: () => { throw new Error('loader must not be called for script kind') } } as unknown as import('../skills/unified.js').UnifiedLoader
    const tools = buildScheduleTools(store, TIMEZONE, loader, 'default')
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!

    const res = JSON.parse(await createSchedule.execute({ taskName: 'home-status', kind: 'script', cron: '*/15 * * * *' }, ctx) as string)
    expect(res.error).toBeUndefined()
    expect(created).toHaveLength(1)
    const opts = created[0]!
    expect(opts['kind']).toBe('script')
    expect(opts['taskName']).toBe('home-status')
    // Immediate first run seeded to ~now (not the next cron occurrence 15 min out).
    expect(opts['nextRun']).toBeDefined()
    expect(new Date(opts['nextRun'] as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('rejects an invalid sensor slug and does not create', async () => {
    const { store, created } = makeCapturingStore()
    const tools = buildScheduleTools(store, TIMEZONE, null, 'default')
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!

    const res = JSON.parse(await createSchedule.execute({ taskName: 'Home Status', kind: 'script', cron: '*/15 * * * *' }, ctx) as string)
    expect(res.error).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('rejects a script schedule with neither cron nor runAt', async () => {
    const { store, created } = makeCapturingStore()
    const tools = buildScheduleTools(store, TIMEZONE, null, 'default')
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!

    const res = JSON.parse(await createSchedule.execute({ taskName: 'home-status', kind: 'script' }, ctx) as string)
    expect(res.error).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('defaults to kind:task and still validates task existence', async () => {
    const { store, created } = makeCapturingStore()
    const loader = { loadByName: (_n: string) => null } as unknown as import('../skills/unified.js').UnifiedLoader
    const tools = buildScheduleTools(store, TIMEZONE, loader, 'default')
    const createSchedule = tools.find(t => t.definition.name === 'create_schedule')!

    const res = JSON.parse(await createSchedule.execute({ taskName: 'no-such-task', cron: '*/15 * * * *' }, ctx) as string)
    expect(res.error).toBe(true)
    expect(created).toHaveLength(0)
  })
})

// ─── Task 2: get_usage echoes since in canonical local format ─────────────────

describe('get_usage echoes since in canonical local format (Task 2)', () => {
  const ctx = makeCtx()

  it('echoes since as canonical local string (not raw ISO)', async () => {
    const usageTool = buildUsageTool(makeUsageStore(), TIMEZONE)
    const { formatModelTime, parseModelTime } = await import('../util/model-time.js')

    // Use a future date so no parse errors
    const futureDate = new Date(Date.now() + 86400_000)
    const canonicalStr = formatModelTime(futureDate, TIMEZONE)

    const result = JSON.parse(await usageTool.execute({ since: canonicalStr }, ctx) as string)
    // The echoed since must match the canonical format YYYY-MM-DD HH:MM
    expect(result.since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // And must equal the canonical round-trip
    const parsed = parseModelTime(canonicalStr, TIMEZONE)
    expect(result.since).toBe(formatModelTime(parsed, TIMEZONE))
  })

  it('echoes all-time when since is omitted', async () => {
    const usageTool = buildUsageTool(makeUsageStore(), TIMEZONE)
    const result = JSON.parse(await usageTool.execute({}, ctx) as string)
    expect(result.since).toBe('all-time')
  })
})

// ─── Task 3: Output renderer — list_schedules ─────────────────────────────────

describe('Output renderer: list_schedules (Task 3)', () => {
  const ctx = makeCtx()

  const isoNow = '2026-06-01T14:00:00.000Z'
  const schedule: Schedule = {
    id: 'sched-1',
    headId: 'default',
    taskName: 'test-task',
    kind: 'task',
    cron: null,
    runAt: isoNow,
    enabled: true,
    lastRun: null,
    nextRun: isoNow,
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: null,
    cronTimezone: null,
    requiresAck: false,
    nagIntervalMinutes: null,
    ackPending: false,
    endDate: null,
    createdAt: isoNow,
    updatedAt: isoNow,
  }

  it('list_schedules time fields match canonical YYYY-MM-DD HH:MM regex', async () => {
    const scheduleStore = makeScheduleStore([schedule])
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const listSchedules = scheduleTools.find(t => t.definition.name === 'list_schedules')!
    const rows = JSON.parse(await listSchedules.execute({}, ctx) as string)
    const row = rows[0]
    const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    expect(row.runAt).toMatch(canonical)
    expect(row.nextRun).toMatch(canonical)
    expect(row.createdAt).toMatch(canonical)
    expect(row.updatedAt).toMatch(canonical)
  })

  it('list_schedules output contains no T-separator ISO timestamp', async () => {
    const scheduleStore = makeScheduleStore([schedule])
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const listSchedules = scheduleTools.find(t => t.definition.name === 'list_schedules')!
    const raw = await listSchedules.execute({}, ctx) as string
    // Must not contain anything like 2026-06-01T14:00
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('list_schedules output contains no Z" pattern', async () => {
    const scheduleStore = makeScheduleStore([schedule])
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const listSchedules = scheduleTools.find(t => t.definition.name === 'list_schedules')!
    const raw = await listSchedules.execute({}, ctx) as string
    expect(raw).not.toMatch(/Z"/)
  })

  it('list_schedules null time fields remain null', async () => {
    const sched: Schedule = { ...schedule, runAt: null, lastRun: null, nextRun: null, lastSkipped: null }
    const scheduleStore = makeScheduleStore([sched])
    const scheduleTools = buildScheduleTools(scheduleStore, TIMEZONE, null, 'default')
    const listSchedules = scheduleTools.find(t => t.definition.name === 'list_schedules')!
    const rows = JSON.parse(await listSchedules.execute({}, ctx) as string)
    expect(rows[0].runAt).toBeNull()
    expect(rows[0].nextRun).toBeNull()
  })
})

// ─── Task 3: Output renderer — list_reminders ────────────────────────────────

describe('Output renderer: list_reminders (Task 3)', () => {
  const ctx = makeCtx()

  const isoNow = '2026-06-01T14:00:00.000Z'
  const reminder: Schedule = {
    id: 'rem-1',
    headId: 'default',
    taskName: null,
    kind: 'reminder',
    cron: '0 9 * * *',
    runAt: isoNow,
    enabled: true,
    lastRun: null,
    nextRun: isoNow,
    lastSkipped: null,
    lastSkipReason: null,
    conditions: null,
    agentContext: 'Take your meds',
    cronTimezone: null,
    requiresAck: true,
    nagIntervalMinutes: 60,
    ackPending: false,
    endDate: null,
    createdAt: isoNow,
    updatedAt: isoNow,
  }

  it('list_reminders time fields match canonical YYYY-MM-DD HH:MM', async () => {
    const scheduleStore = makeScheduleStore([reminder])
    const reminderTools = buildReminderTools(scheduleStore, TIMEZONE, 'default')
    const listReminders = reminderTools.find(t => t.definition.name === 'list_reminders')!
    const rows = JSON.parse(await listReminders.execute({}, ctx) as string)
    const row = rows[0]
    const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    expect(row.runAt).toMatch(canonical)
    expect(row.createdAt).toMatch(canonical)
  })

  it('list_reminders preserves non-time fields unchanged', async () => {
    const scheduleStore = makeScheduleStore([reminder])
    const reminderTools = buildReminderTools(scheduleStore, TIMEZONE, 'default')
    const listReminders = reminderTools.find(t => t.definition.name === 'list_reminders')!
    const rows = JSON.parse(await listReminders.execute({}, ctx) as string)
    const row = rows[0]
    expect(row.id).toBe('rem-1')
    expect(row.message).toBe('Take your meds')
    expect(row.cron).toBe('0 9 * * *')
    expect(row.requiresAck).toBe(true)
    expect(row.nagIntervalMinutes).toBe(60)
  })

  it('list_reminders output contains no Z" or T-separator patterns', async () => {
    const scheduleStore = makeScheduleStore([reminder])
    const reminderTools = buildReminderTools(scheduleStore, TIMEZONE, 'default')
    const listReminders = reminderTools.find(t => t.definition.name === 'list_reminders')!
    const raw = await listReminders.execute({}, ctx) as string
    expect(raw).not.toMatch(/Z"/)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})

// ─── Task 3: Output renderer — get_file_info ─────────────────────────────────

describe('Output renderer: get_file_info (Task 3)', () => {
  const ctx = makeCtx()
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `shrok-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'hello')
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  })

  it('get_file_info created/modified/accessed match canonical YYYY-MM-DD HH:MM', async () => {
    // get_file_info is in OPTIONAL_TOOLS — exercise it through the AgentToolRegistryImpl
    // resolveOptional path which wraps OPTIONAL_TOOLS entries.
    const { AgentToolRegistryImpl } = await import('./registry.js')
    const registry = new AgentToolRegistryImpl()
    const entries = registry.resolveOptional(['get_file_info'])
    expect(entries.length).toBe(1)
    const result = JSON.parse(await entries[0]!.execute({ path: tmpFile }, ctx) as string)
    const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    expect(result.created).toMatch(canonical)
    expect(result.modified).toMatch(canonical)
    expect(result.accessed).toMatch(canonical)
  })

  it('get_file_info output contains no Z" or T-separator', async () => {
    const { AgentToolRegistryImpl } = await import('./registry.js')
    const registry = new AgentToolRegistryImpl()
    const entries = registry.resolveOptional(['get_file_info'])
    const raw = await entries[0]!.execute({ path: tmpFile }, ctx) as string
    expect(raw).not.toMatch(/Z"/)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('get_file_info preserves size/type/isFile/isDirectory', async () => {
    const { AgentToolRegistryImpl } = await import('./registry.js')
    const registry = new AgentToolRegistryImpl()
    const entries = registry.resolveOptional(['get_file_info'])
    const result = JSON.parse(await entries[0]!.execute({ path: tmpFile }, ctx) as string)
    expect(typeof result.size).toBe('number')
    expect(result.type).toBe('file')
    expect(result.isFile).toBe(true)
    expect(result.isDirectory).toBe(false)
  })
})

// ─── Task 4: Final disk-sweep sentinel ───────────────────────────────────────

describe('Final disk-sweep sentinel: no Z"-suffixed quoted strings in description lines (Task 4)', () => {
  // Read the source files from disk and scan lines with `description:` for the smoking-gun
  // pattern `"...Z"`. This catches any future regression where a model-facing description
  // is accidentally set to a Z-suffixed example.
  //
  // Filter: only check lines that match /description:\s*['"`]/ — the intent is to scan
  // model-facing string literals. Comments and timezone-related prose (e.g. IANA names
  // that happen to end in a capital letter) are not description literals and are excluded.

  const srcRoot = path.join(__dirname, '..')
  const registryPath = path.join(srcRoot, 'sub-agents', 'registry.ts')
  const headIndexPath = path.join(srcRoot, 'head', 'index.ts')

  function descriptionLines(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.split('\n').filter(line => /description:\s*['"`]/.test(line))
  }

  it('registry.ts: no description line contains a Z"-suffixed quoted string', () => {
    const lines = descriptionLines(registryPath)
    const zLines = lines.filter(line => /"[^"]*Z"/.test(line))
    if (zLines.length > 0) {
      throw new Error(`Found Z"-suffixed quoted strings in registry.ts description lines:\n${zLines.join('\n')}`)
    }
    expect(zLines.length).toBe(0)
  })

  it('head/index.ts: no description line contains a Z"-suffixed quoted string', () => {
    const lines = descriptionLines(headIndexPath)
    const zLines = lines.filter(line => /"[^"]*Z"/.test(line))
    if (zLines.length > 0) {
      throw new Error(`Found Z"-suffixed quoted strings in head/index.ts description lines:\n${zLines.join('\n')}`)
    }
    expect(zLines.length).toBe(0)
  })

  it('registry.ts get_usage.since description contains YYYY-MM-DD HH:MM', () => {
    const content = fs.readFileSync(registryPath, 'utf8')
    expect(content).toContain('YYYY-MM-DD HH:MM')
  })

  it('registry.ts create_reminder.triggerAt description contains YYYY-MM-DD HH:MM', () => {
    const content = fs.readFileSync(registryPath, 'utf8')
    // The description may span multiple lines (template literal), so search the full content
    // for the triggerAt property block containing the canonical format
    expect(content).toMatch(/triggerAt[\s\S]{0,500}YYYY-MM-DD HH:MM/)
  })

  it('head/index.ts get_usage.since description contains YYYY-MM-DD HH:MM', () => {
    const content = fs.readFileSync(headIndexPath, 'utf8')
    expect(content).toContain('YYYY-MM-DD HH:MM')
  })
})

// ─── create_reminder head-targeting (issue #39) ──────────────────────────────

describe('create_reminder: optional target head (#39)', () => {
  const ctx = makeCtx()
  const ROSTER = [
    { id: 'default', displayName: 'Ashley' },
    { id: 'zoey', displayName: 'Zoey' },
  ]

  // A schedule store that captures CreateScheduleOptions instead of throwing.
  function makeCapturingStore() {
    const created: Array<{ id: string; headId: string }> = []
    const store = {
      list: () => [],
      create: (opts: { id: string; headId: string }) => { created.push(opts); return opts },
      update: () => null,
      get: () => null,
      delete: () => {},
      markFired: () => {},
      advanceNextRun: () => {},
      markSkipped: () => {},
      deleteAllForHead: () => ({ schedules: 0, reminders: 0 }),
      getDue: () => [],
    }
    return { store: store as unknown as import('../db/schedules.js').ScheduleStore, created }
  }

  function createReminderTool(roster: typeof ROSTER | [], storeOverride?: import('../db/schedules.js').ScheduleStore) {
    const tools = buildReminderTools(storeOverride ?? makeScheduleStore(), TIMEZONE, 'default', roster)
    return tools.find(t => t.definition.name === 'create_reminder')!
  }

  // ── Definition shape ──
  it('exposes a head param listing other heads when a multi-head roster is present', () => {
    const def = createReminderTool(ROSTER).definition
    const props = (def.inputSchema as { properties: Record<string, { description?: string }> }).properties
    expect(props.head).toBeDefined()
    expect(props.head!.description).toContain('Zoey')
    expect(props.head!.description).not.toContain('Ashley') // self is excluded
  })

  it('omits the head param entirely when there are no other heads', () => {
    const single = createReminderTool([{ id: 'default', displayName: 'Ashley' }] as typeof ROSTER).definition
    const empty = createReminderTool([]).definition
    expect((single.inputSchema as { properties: Record<string, unknown> }).properties.head).toBeUndefined()
    expect((empty.inputSchema as { properties: Record<string, unknown> }).properties.head).toBeUndefined()
  })

  // ── Execute / routing ──
  const future = '2030-06-15 09:00'

  it('stores the target head id when head names another person', async () => {
    const { store, created } = makeCapturingStore()
    const tool = createReminderTool(ROSTER, store)
    const res = JSON.parse(await tool.execute({ message: 'm', triggerAt: future, head: 'Zoey' }, ctx) as string)
    expect(res.ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]!.headId).toBe('zoey')
  })

  it('resolves the head name case-insensitively', async () => {
    const { store, created } = makeCapturingStore()
    const tool = createReminderTool(ROSTER, store)
    await tool.execute({ message: 'm', triggerAt: future, head: '  zOeY ' }, ctx)
    expect(created[0]!.headId).toBe('zoey')
  })

  it('defaults to the creating head when head is omitted', async () => {
    const { store, created } = makeCapturingStore()
    const tool = createReminderTool(ROSTER, store)
    await tool.execute({ message: 'm', triggerAt: future }, ctx)
    expect(created[0]!.headId).toBe('default')
  })

  it('errors on an unknown head name and writes nothing', async () => {
    const { store, created } = makeCapturingStore()
    const tool = createReminderTool(ROSTER, store)
    const res = JSON.parse(await tool.execute({ message: 'm', triggerAt: future, head: 'Nobody' }, ctx) as string)
    expect(res.error).toBe(true)
    expect(res.message).toContain('Zoey')
    expect(created).toHaveLength(0)
  })
})
