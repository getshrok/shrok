import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileSystemKindLoader } from './skills/loader.js'
import { UnifiedLoader } from './skills/unified.js'

/**
 * Focused tests for the Plan 04-01 system-wiring contract:
 *   1. The tasks directory is auto-created at boot (mkdir recursive).
 *   2. A skills-scoped FileSystemKindLoader + a tasks-scoped one can be wrapped
 *      in a UnifiedLoader and respond correctly to loadByName.
 *   3. With zero TASK.md files, loadByName(<existing-skill>) returns
 *      kind: 'skill' identical to the legacy skills-only loader.
 *
 * These mirror the wiring in src/system.ts without booting the full
 * ActivationLoop. The end-to-end wiring is exercised indirectly by the
 * existing head.test.ts and eval harness, which import system.ts.
 */
describe('system wiring (Plan 04-01)', () => {
  let tmpWorkspace: string
  let skillsPath: string
  let tasksPath: string

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-sys-test-'))
    skillsPath = path.join(tmpWorkspace, 'skills')
    tasksPath = path.join(tmpWorkspace, 'tasks')
  })

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true })
  })

  function writeSkill(name: string) {
    const dir = path.join(skillsPath, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.`, 'utf8')
  }

  function simulateBoot() {
    // Mirrors system.ts: mkdir skills + tasks, construct two kind-loaders,
    // wrap in UnifiedLoader.
    fs.mkdirSync(skillsPath, { recursive: true })
    fs.mkdirSync(tasksPath, { recursive: true })
    const skillLoader = new FileSystemKindLoader({ root: skillsPath, kind: 'skill', filename: 'SKILL.md' })
    const taskLoader = new FileSystemKindLoader({ root: tasksPath, kind: 'task', filename: 'TASK.md' })
    const unifiedLoader = new UnifiedLoader(skillLoader, taskLoader)
    return { skillLoader, taskLoader, unifiedLoader }
  }

  it('creates <workspace>/tasks/ on boot', () => {
    expect(fs.existsSync(tasksPath)).toBe(false)
    simulateBoot()
    expect(fs.existsSync(tasksPath)).toBe(true)
    expect(fs.statSync(tasksPath).isDirectory()).toBe(true)
  })

  it('creates <workspace>/tasks/ even when workspace already exists', () => {
    fs.mkdirSync(tmpWorkspace, { recursive: true })
    simulateBoot()
    expect(fs.existsSync(tasksPath)).toBe(true)
  })

  it('constructs skills + tasks loaders with matching kinds', () => {
    const { skillLoader, taskLoader } = simulateBoot()
    expect(skillLoader.kind).toBe('skill')
    expect(taskLoader.kind).toBe('task')
  })

  it('UnifiedLoader exposes kind-scoped loaders via getters', () => {
    const { unifiedLoader } = simulateBoot()
    expect(unifiedLoader.skillsLoader.kind).toBe('skill')
    expect(unifiedLoader.tasksLoader.kind).toBe('task')
  })

  it('with zero TASK.md files, loadByName(<existing-skill>) returns kind: skill with byte-equivalent meta/body', () => {
    writeSkill('email')
    const { skillLoader, unifiedLoader } = simulateBoot()

    const direct = skillLoader.load('email')
    const viaUnified = unifiedLoader.loadByName('email')

    expect(direct).not.toBeNull()
    expect(viaUnified).not.toBeNull()
    expect(viaUnified!.kind).toBe('skill')
    expect(viaUnified!.meta).toEqual(direct!.frontmatter)
    expect(viaUnified!.body).toBe(direct!.instructions)
  })

  it('loadByName returns null for missing entries across both loaders', () => {
    const { unifiedLoader } = simulateBoot()
    expect(unifiedLoader.loadByName('nope')).toBeNull()
  })
})
