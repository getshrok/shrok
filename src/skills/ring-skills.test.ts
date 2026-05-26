import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { parseSkillFile } from './parser.js'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../')

const timerSkillPath = path.join(repoRoot, 'skills', 'timer', 'SKILL.md')
const setAlarmSkillPath = path.join(repoRoot, 'skills', 'set-alarm', 'SKILL.md')

const timerContent = fs.readFileSync(timerSkillPath, 'utf8')
const setAlarmContent = fs.readFileSync(setAlarmSkillPath, 'utf8')

const { frontmatter: timerFrontmatter, instructions: timerInstructions } = parseSkillFile(timerContent)
const { frontmatter: alarmFrontmatter, instructions: alarmInstructions } = parseSkillFile(setAlarmContent)

// TIMER-01: timer SKILL.md contains ring_device(start) call in step 3
describe('TIMER-01: timer skill ring_device call', () => {
  it('timer instructions include ring_device', () => {
    expect(timerInstructions).toContain('ring_device')
  })

  it('timer instructions include action "start"', () => {
    expect(timerInstructions).toContain('"start"')
  })

  it('timer instructions include source "timer"', () => {
    expect(timerInstructions).toContain('"timer"')
  })
})

// TIMER-02: timer SKILL.md describes the single bash/sleep mechanism (no competing path)
describe('TIMER-02: timer skill single mechanism (additive only)', () => {
  it('timer instructions still describe the sleep mechanism', () => {
    expect(timerInstructions).toContain('sleep')
  })

  it('timer numbered steps do not introduce create_reminder as the timer path', () => {
    // create_reminder is the alarm mechanism — it must NOT appear in the numbered steps
    // (it may appear in guidance text as a "use this instead" recommendation)
    // Extract only the numbered steps section (before "## Guidance")
    const stepsSection = timerInstructions.split('## Guidance')[0] ?? timerInstructions
    expect(stepsSection).not.toContain('create_reminder')
  })

  it('timer instructions do not introduce create_schedule as a timer path', () => {
    // create_schedule is a scheduling mechanism — should NOT appear in timer instructions
    expect(timerInstructions).not.toContain('create_schedule')
  })

  it('timer frontmatter is unchanged (name: timer)', () => {
    expect(timerFrontmatter.name).toBe('timer')
  })
})

// ALARM-01: set-alarm SKILL.md parses with parseSkillFile; name === 'set-alarm'; non-empty description
describe('ALARM-01: set-alarm frontmatter valid', () => {
  it('set-alarm skill parses without error', () => {
    // parsing already succeeded above — just assert the result shape
    expect(alarmFrontmatter).toBeDefined()
  })

  it('set-alarm frontmatter name is "set-alarm"', () => {
    expect(alarmFrontmatter.name).toBe('set-alarm')
  })

  it('set-alarm frontmatter description is a non-empty string', () => {
    expect(typeof alarmFrontmatter.description).toBe('string')
    expect(alarmFrontmatter.description.length).toBeGreaterThan(0)
  })
})

// ALARM-02: set-alarm SKILL.md fire-time message instructs ring_device with action 'start'
describe('ALARM-02: set-alarm fire-time message calls ring_device(start)', () => {
  it('set-alarm instructions contain ring_device', () => {
    expect(alarmInstructions).toContain('ring_device')
  })

  it("set-alarm instructions contain action 'start'", () => {
    // The fire-time message must contain the action instruction
    expect(alarmInstructions).toContain("action 'start'")
  })

  it("set-alarm instructions contain source 'alarm'", () => {
    // The fire-time message must specify source alarm
    expect(alarmInstructions).toContain("source 'alarm'")
  })

  it('set-alarm fire-time message uses imperative phrasing (MUST call ring_device)', () => {
    // Pitfall 6: must be an explicit tool-call instruction, not soft narration
    const upperContent = setAlarmContent.toUpperCase()
    expect(upperContent).toContain('MUST CALL RING_DEVICE')
  })
})

// ALARM-03: set-alarm SKILL.md forbids requiresAck/nag fields in create_reminder usage
describe('ALARM-03: set-alarm never sets requiresAck or nag fields', () => {
  it('set-alarm instructions contain a NEVER directive for requiresAck', () => {
    // The skill must explicitly forbid requiresAck
    const upperInstructions = alarmInstructions.toUpperCase()
    expect(upperInstructions).toContain('REQUIRESACK')
  })

  it('set-alarm instructions contain a NEVER directive for nag fields', () => {
    // The skill must explicitly forbid nag fields
    const upperInstructions = alarmInstructions.toUpperCase()
    expect(upperInstructions).toContain('NAGMINUTES')
  })

  it('create_reminder call examples do not set requiresAck', () => {
    // The call examples inside code blocks must not include requiresAck as a field
    // (The constraint section may reference the name to say NEVER set it — that is expected)
    const codeBlocks = (alarmInstructions.match(/```[\s\S]*?```/g) ?? []).join('\n')
    expect(codeBlocks).not.toContain('requiresAck')
  })

  it('create_reminder call example does not set nagMinutes, nagHours, or nagDays', () => {
    // None of the nag fields should appear in the call example
    const callExampleMatch = alarmInstructions.match(/create_reminder\s*\(\s*\{[\s\S]*?\}\s*\)/g) ?? []
    for (const example of callExampleMatch) {
      expect(example).not.toContain('nagMinutes')
      expect(example).not.toContain('nagHours')
      expect(example).not.toContain('nagDays')
    }
  })
})
