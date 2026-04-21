import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { injectSkillMemory } from './skill-memory.js'
import type { Message, ToolCallMessage, ToolResultMessage, ToolCall, ToolResult } from '../types/core.js'

/**
 * ISO-03 regression lock.
 *
 * injectSkillMemory walks `<skillsDir>/<dep>/SKILL.md` paths derived from
 * frontmatter `skill-deps`. It must only resolve deps under the skills
 * directory — a skill declaring `skill-deps: [some-task]` must silently
 * no-op (no crash, no task body leakage into skill context). This is a
 * mitigation for threat T-04-10 (Tampering).
 */

describe('skill-memory.injectSkillMemory ISO-03', () => {
  let tmp: string
  let skillsDir: string
  let tasksDir: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-memory-iso-'))
    skillsDir = path.join(tmp, 'skills')
    tasksDir = path.join(tmp, 'tasks')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.mkdirSync(tasksDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function writeSkill(name: string, frontmatter: string, body = 'body') {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, name, 'SKILL.md'),
      `---\n${frontmatter}\n---\n${body}`
    )
  }

  function writeTask(name: string, frontmatter: string, body = 'task body') {
    fs.mkdirSync(path.join(tasksDir, name), { recursive: true })
    fs.writeFileSync(
      path.join(tasksDir, name, 'TASK.md'),
      `---\n${frontmatter}\n---\n${body}`
    )
  }

  function makeReadHistory(readPath: string, content: string): { history: Message[]; resultMsg: ToolResultMessage } {
    const tcId = 'tc_test1'
    const callMsg: ToolCallMessage = {
      kind: 'tool_call',
      id: 'msg_call',
      createdAt: new Date().toISOString(),
      content: '',
      toolCalls: [{ id: tcId, name: 'read_file', input: { path: readPath } } as ToolCall],
    }
    const resultMsg: ToolResultMessage = {
      kind: 'tool_result',
      id: 'msg_result',
      createdAt: new Date().toISOString(),
      toolResults: [{ toolCallId: tcId, name: 'read_file', content } as ToolResult],
    }
    return { history: [callMsg, resultMsg], resultMsg }
  }

  it('silently no-ops when a skill declares skill-deps pointing at a task name (no task body leaked)', () => {
    // Task 'secret-task' exists; a skill tries to pull its body via skill-deps
    writeTask('secret-task', 'name: secret-task\ndescription: nuclear codes', 'TOP SECRET CONTENT')
    const skillContent = `---\nname: leaky\ndescription: tries to leak\nskill-deps:\n  - secret-task\n---\nSkill body.`
    writeSkill('leaky', 'name: leaky\ndescription: tries to leak\nskill-deps:\n  - secret-task', 'Skill body.')

    const { history, resultMsg } = makeReadHistory(path.join(skillsDir, 'leaky', 'SKILL.md'), skillContent)
    const before = history.length

    injectSkillMemory(skillsDir, resultMsg, history)

    // No new tool_call messages for secret-task — the dep resolves under skillsDir
    // and secret-task does NOT exist there. Only MEMORY.md for the skill itself
    // could be queued (and it doesn't exist → no-op).
    const appended = history.slice(before)
    const appendedJson = JSON.stringify(appended)
    expect(appendedJson).not.toContain('secret-task')
    expect(appendedJson).not.toContain('TOP SECRET CONTENT')
    expect(appendedJson).not.toContain(tasksDir)
  })

  it('regression guard: injects MEMORY.md + skill-deps entries for skills that declare other skills', () => {
    writeSkill('helper', 'name: helper\ndescription: helper skill', 'Helper body.')
    // helper has a MEMORY.md
    fs.writeFileSync(path.join(skillsDir, 'helper', 'MEMORY.md'), 'helper memory')

    const skillContent = `---\nname: main\ndescription: the main\nskill-deps:\n  - helper\n---\nMain body.`
    writeSkill('main', 'name: main\ndescription: the main\nskill-deps:\n  - helper', 'Main body.')
    fs.writeFileSync(path.join(skillsDir, 'main', 'MEMORY.md'), 'main memory')

    const { history, resultMsg } = makeReadHistory(path.join(skillsDir, 'main', 'SKILL.md'), skillContent)

    injectSkillMemory(skillsDir, resultMsg, history)

    // Expect appended tool_call + tool_result with helper paths present
    const json = JSON.stringify(history)
    expect(json).toContain(path.join(skillsDir, 'main', 'MEMORY.md'))
    expect(json).toContain(path.join(skillsDir, 'helper', 'SKILL.md'))
    expect(json).toContain(path.join(skillsDir, 'helper', 'MEMORY.md'))
  })

  it('source audit: skill-memory.ts never references unifiedLoader or tasks dir', () => {
    // Structural guarantee: this file resolves paths under skillsDir only.
    const source = fs.readFileSync(path.resolve('src/sub-agents/skill-memory.ts'), 'utf8')
    expect(source).not.toContain('unifiedLoader')
    expect(source).not.toMatch(/tasksDir|TASK\.md|jobsLoader|tasksLoader/)
  })
})
