import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as url from 'node:url'
import { FileSystemKindLoader, FileSystemSkillLoader } from './loader.js'
import { UnifiedLoader } from './unified.js'
import { log } from '../logger.js'
import { initDb } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { UsageStore } from '../db/usage.js'
import { ScheduleStore } from '../db/schedules.js'

const __dirnameUnified = url.fileURLToPath(new URL('.', import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirnameUnified, '../../sql')

// ─── FileSystemKindLoader ─────────────────────────────────────────────────────

describe('FileSystemKindLoader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindloader-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFile(relPath: string, content: string) {
    const fullPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf8')
  }

  const skillContent = `---
name: email
description: Periodic health check
---
Check that all systems are operational.`

  const jobContent = `---
name: vacuum
description: Nightly DB vacuum
---
Run the vacuum.`

  it('loads a skill from root/name/SKILL.md', () => {
    writeFile('email/SKILL.md', skillContent)
    const loader = new FileSystemKindLoader({ root: tmpDir, kind: 'skill', filename: 'SKILL.md' })
    const s = loader.load('email')
    expect(s).not.toBeNull()
    expect(s!.frontmatter.name).toBe('email')
  })

  it('loads a task from root/name/TASK.md', () => {
    writeFile('vacuum/TASK.md', jobContent)
    const loader = new FileSystemKindLoader({ root: tmpDir, kind: 'task', filename: 'TASK.md' })
    const j = loader.load('vacuum')
    expect(j).not.toBeNull()
    expect(j!.frontmatter.name).toBe('vacuum')
    expect(j!.instructions).toContain('Run the vacuum')
  })

  it('exposes readonly kind matching the constructor', () => {
    const skills = new FileSystemKindLoader({ root: tmpDir, kind: 'skill', filename: 'SKILL.md' })
    const tasks = new FileSystemKindLoader({ root: tmpDir, kind: 'task', filename: 'TASK.md' })
    expect(skills.kind).toBe('skill')
    expect(tasks.kind).toBe('task')
  })

  it('auto-creates the root directory if missing', () => {
    const sub = path.join(tmpDir, 'missing-root')
    expect(fs.existsSync(sub)).toBe(false)
    const loader = new FileSystemKindLoader({ root: sub, kind: 'task', filename: 'TASK.md' })
    expect(fs.existsSync(sub)).toBe(true)
    expect(loader.load('anything')).toBeNull()
  })

  it('FileSystemSkillLoader back-compat shim still works', () => {
    writeFile('email/SKILL.md', skillContent)
    const loader = new FileSystemSkillLoader(tmpDir)
    const s = loader.load('email')
    expect(s).not.toBeNull()
    expect(s!.frontmatter.description).toBe('Periodic health check')
    expect(loader.kind).toBe('skill')
  })

  it('listAll returns entries tagged in the configured kind directory only', () => {
    writeFile('vacuum/TASK.md', jobContent)
    writeFile('other/TASK.md', `---\nname: other\ndescription: Other\n---\nOther.`)
    const loader = new FileSystemKindLoader({ root: tmpDir, kind: 'task', filename: 'TASK.md' })
    const names = loader.listAll().map(s => s.name).sort()
    expect(names).toEqual(['other', 'vacuum'])
  })
})

// ─── UnifiedLoader ────────────────────────────────────────────────────────────

describe('UnifiedLoader', () => {
  let skillsDir: string
  let tasksDir: string

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-test-'))
    skillsDir = path.join(base, 'skills')
    tasksDir = path.join(base, 'tasks')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.mkdirSync(tasksDir, { recursive: true })
  })

  function writeSkill(name: string, body = 'skill body') {
    const dir = path.join(skillsDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`, 'utf8')
  }

  function writeTask(name: string, body = 'task body') {
    const dir = path.join(tasksDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'TASK.md'),
      `---\nname: ${name}\ndescription: ${name} task\n---\n${body}`, 'utf8')
  }

  function makeUnified(): UnifiedLoader {
    const skills = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasks = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    return new UnifiedLoader(skills, tasks)
  }

  it('returns {kind:skill} when only SKILL.md exists', () => {
    writeSkill('foo')
    const entry = makeUnified().loadByName('foo')
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe('skill')
    expect(entry!.meta.name).toBe('foo')
    expect(entry!.body).toContain('skill body')
    expect(entry!.skill.name).toBe('foo')
  })

  it('returns {kind:task} when only TASK.md exists', () => {
    writeTask('bar')
    const entry = makeUnified().loadByName('bar')
    expect(entry).not.toBeNull()
    expect(entry!.kind).toBe('task')
    expect(entry!.meta.name).toBe('bar')
    expect(entry!.body).toContain('task body')
  })

  it('skills win on name collision (D-03)', () => {
    writeSkill('dup', 'from skill')
    writeTask('dup', 'from task')
    const entry = makeUnified().loadByName('dup')
    expect(entry!.kind).toBe('skill')
    expect(entry!.body).toContain('from skill')
  })

  it('returns null for unknown name', () => {
    expect(makeUnified().loadByName('missing')).toBeNull()
  })

  it('warnCollisions emits log.warn for intersecting names and does not throw when none', () => {
    writeSkill('a')
    writeTask('b')
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      makeUnified().warnCollisions()
      expect(warnSpy).not.toHaveBeenCalled()

      writeSkill('shared')
      writeTask('shared')
      makeUnified().warnCollisions()
      expect(warnSpy).toHaveBeenCalled()
      const args = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(args).toContain('shared')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('exposes skillsLoader and tasksLoader getters', () => {
    const unified = makeUnified()
    expect(unified.skillsLoader.kind).toBe('skill')
    expect(unified.tasksLoader.kind).toBe('task')
  })
})

// ─── UnifiedLoader.rename ─────────────────────────────────────────────────────

describe('UnifiedLoader.rename', () => {
  let skillsDir: string
  let tasksDir: string
  let schedulesDir: string
  let scheduleStore: ScheduleStore
  let usageStore: UsageStore

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-rename-'))
    skillsDir = path.join(base, 'skills')
    tasksDir = path.join(base, 'tasks')
    schedulesDir = path.join(base, 'schedules')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.mkdirSync(schedulesDir, { recursive: true })

    const db = initDb(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    usageStore = new UsageStore(db, 'UTC')
    scheduleStore = new ScheduleStore(schedulesDir)
  })

  function writeSkill(name: string, deps: string[] = [], body = `${name} skill body`) {
    const dir = path.join(skillsDir, name)
    fs.mkdirSync(dir, { recursive: true })
    const depsYaml = deps.length > 0 ? `\nskill-deps:\n${deps.map(d => `  - ${d}`).join('\n')}` : ''
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill${depsYaml}\n---\n${body}`, 'utf8')
  }

  function writeTask(name: string, deps: string[] = [], body = `${name} task body`) {
    const dir = path.join(tasksDir, name)
    fs.mkdirSync(dir, { recursive: true })
    const depsYaml = deps.length > 0 ? `\nskill-deps:\n${deps.map(d => `  - ${d}`).join('\n')}` : ''
    fs.writeFileSync(path.join(dir, 'TASK.md'),
      `---\nname: ${name}\ndescription: ${name} task${depsYaml}\n---\n${body}`, 'utf8')
  }

  function makeUnified(): UnifiedLoader {
    const skills = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasks = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    return new UnifiedLoader(skills, tasks)
  }

  it('returns kind:skill when renaming a skill', async () => {
    writeSkill('weather')
    const result = await makeUnified().rename('weather', 'forecast', {})
    expect(result.kind).toBe('skill')
  })

  it('returns kind:task when renaming a task', async () => {
    writeTask('briefing')
    const result = await makeUnified().rename('briefing', 'briefing-v2', {})
    expect(result.kind).toBe('task')
  })

  it('cross-kind dep cascade: renaming a SKILL updates a TASK that depends on it (D2)', async () => {
    writeSkill('weather')
    writeTask('morning-task', ['weather'])
    const result = await makeUnified().rename('weather', 'forecast', {})
    expect(result.updatedDeps).toContain('morning-task')
    const taskMd = fs.readFileSync(path.join(tasksDir, 'morning-task', 'TASK.md'), 'utf8')
    expect(taskMd).toContain('- forecast')
    expect(taskMd).not.toContain('- weather')
  })

  it('schedule cascade runs only for kind===task; skill rename leaves schedules untouched (D3)', async () => {
    writeSkill('weather')
    writeTask('briefing')
    scheduleStore.create({ id: 'sched-1', headId: 'default', kind: 'task', taskName: 'weather', runAt: '2099-01-01T00:00:00Z', nextRun: '2099-01-01T00:00:00Z' })

    const skillResult = await makeUnified().rename('weather', 'forecast', { scheduleStore })
    // Skill rename must NOT cascade to schedules
    expect(skillResult.updatedSchedules).toBe(0)
    expect(scheduleStore.get('sched-1')!.taskName).toBe('weather')

    // Task rename DOES cascade
    scheduleStore.create({ id: 'sched-2', headId: 'default', kind: 'task', taskName: 'briefing', runAt: '2099-01-01T00:00:00Z', nextRun: '2099-01-01T00:00:00Z' })
    const taskResult = await makeUnified().rename('briefing', 'briefing-v2', { scheduleStore })
    expect(taskResult.updatedSchedules).toBe(1)
    expect(scheduleStore.get('sched-2')!.taskName).toBe('briefing-v2')
  })

  it('usage.target_name is updated for both skill and task renames (D4)', async () => {
    writeSkill('email-skill')
    usageStore.record({ sourceType: 'agent', sourceId: null, model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.01, targetName: 'email-skill' })
    const result = await makeUnified().rename('email-skill', 'email-new', { usageStore })
    expect(result.updatedUsageRows).toBe(1)
  })

  it('agents.skill_name is NOT modified after a rename', async () => {
    const db = initDb(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    const agentId = 'agent-test-1'
    db.prepare(`INSERT INTO agents (id, skill_name, status, task) VALUES (?, ?, 'completed', '')`).run(agentId, 'old-skill')
    const localUsage = new UsageStore(db, 'UTC')
    writeSkill('old-skill')
    await makeUnified().rename('old-skill', 'new-skill', { usageStore: localUsage })
    const row = db.prepare('SELECT skill_name FROM agents WHERE id = ?').get(agentId) as { skill_name: string }
    expect(row.skill_name).toBe('old-skill')
  })

  it('warns when oldName appears in the renamed entry own body (D5)', async () => {
    writeSkill('my-skill', [], 'This skill uses my-skill capabilities')
    const result = await makeUnified().rename('my-skill', 'my-new-skill', {})
    expect(result.warnings.some(w => w.includes('my-skill'))).toBe(true)
  })

  it('warns when oldName appears in an updated dependent body (D5)', async () => {
    writeSkill('dep-skill')
    writeTask('dep-task', ['dep-skill'], 'This task uses dep-skill logic')
    const result = await makeUnified().rename('dep-skill', 'dep-new', {})
    expect(result.warnings.some(w => w.includes('dep-task'))).toBe(true)
  })

  it('throws Invalid new name on bad newName', async () => {
    writeSkill('my-skill')
    await expect(makeUnified().rename('my-skill', 'bad name!', {})).rejects.toThrow(/Invalid new name/)
  })

  it('throws not found when oldName is not in skills or tasks', async () => {
    await expect(makeUnified().rename('nonexistent', 'something', {})).rejects.toThrow(/not found/)
  })

  it('throws already exists when newName exists in the target kind', async () => {
    writeSkill('alpha')
    writeSkill('beta')
    await expect(makeUnified().rename('alpha', 'beta', {})).rejects.toThrow(/already exists/)
  })
})
