import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileSystemKindLoader, FileSystemSkillLoader } from './loader.js'
import { UnifiedLoader } from './unified.js'
import { log } from '../logger.js'

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
