import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileSystemKindLoader } from './loader.js'
import { UnifiedLoader } from './unified.js'
import { resolveSkill } from './resolver.js'
import { SLASH_NAME_REJECTION } from '../sub-agents/local.js'

describe('resolveSkill (discriminated ResolveResult)', () => {
  let tmp: string
  let skillsDir: string
  let tasksDir: string
  let unified: UnifiedLoader

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'))
    skillsDir = path.join(tmp, 'skills')
    tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.mkdirSync(tasksDir, { recursive: true })

    const skillMd = `---
name: email
description: Email check
---
Check email.`
    const taskMd = `---
name: vacuum
description: DB vacuum
---
Run vacuum.`

    fs.mkdirSync(path.join(skillsDir, 'email'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'email', 'SKILL.md'), skillMd)

    fs.mkdirSync(path.join(tasksDir, 'vacuum'), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, 'vacuum', 'TASK.md'), taskMd)

    const skillsLoader = new FileSystemKindLoader({ root: skillsDir, kind: 'skill', filename: 'SKILL.md' })
    const tasksLoader = new FileSystemKindLoader({ root: tasksDir, kind: 'task', filename: 'TASK.md' })
    unified = new UnifiedLoader(skillsLoader, tasksLoader)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns { ok:true, skill } for a known skill', () => {
    const r = resolveSkill(unified, 'email')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.skill.name).toBe('email')
      expect(r.skill.frontmatter.description).toBe('Email check')
    }
  })

  it('returns { ok:false, reason:"is_task" } for a known task', () => {
    const r = resolveSkill(unified, 'vacuum')
    expect(r).toEqual({ ok: false, reason: 'is_task' })
  })

  it('returns { ok:false, reason:"not_found" } for an unknown name', () => {
    const r = resolveSkill(unified, 'missing')
    expect(r).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rejects slash-containing name with invalid_slash_name reason (guard #1)', () => {
    const r = resolveSkill(unified, 'parent/child')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason === 'invalid_slash_name').toBe(true)
  })

  it('rejects task-rooted slash path with invalid_slash_name (no filesystem fallthrough)', () => {
    const r = resolveSkill(unified, 'vacuum/anything')
    expect(r).toEqual({ ok: false, reason: 'invalid_slash_name' })
  })

  it("surfaces instruction-shaped rejection message (guard #1b)", () => {
    expect(SLASH_NAME_REJECTION).toMatch(/must not contain '\/'/)
    expect(SLASH_NAME_REJECTION).toMatch(/Flat skills only/)
    expect(SLASH_NAME_REJECTION).toMatch(/skills\/skills\/SKILL\.md/)
  })
})
