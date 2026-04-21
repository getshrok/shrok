/**
 * Schedule management lifecycle scenario.
 *
 * Tests the full schedule CRUD lifecycle through the agent pipeline:
 *   create, list, modify, pause, resume, delete
 *
 * Schedule tools are agent-only — the head must spawn an agent for each
 * operation. Each variant seeds the appropriate state (schedules, skills)
 * and verifies store state after the agent completes.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { createTopicMemory } from '../../../src/memory/index.js'
import type { Message } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  freshHeadBundle,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'

export const name = 'schedule-management'
export const description = 'Schedule lifecycle: create, list, modify, pause, resume, delete — each via agent-delegated tool calls'
export const category = 'routing'
export const estimatedCostUsd = 0.50
export const rubric = [
  'correct_tool_called — Did the agent call the appropriate schedule tool for the requested operation? (create_schedule for create, list_schedules for list, update_schedule for modify/pause/resume, delete_schedule for delete.) Score 1.0 if the right tool was called, 0.0 if not called or wrong tool used.',
  'operation_correct — Was the operation performed with the right parameters? For create: correct cron (0 9 * * *) and skill name. For list: all seeded schedules surfaced. For modify: cron updated to 30 8 * * *. For pause: enabled set to false. For resume: enabled set to true. For delete: schedule removed. Score 1.0 if fully correct, 0.5 if partially correct, 0.0 if wrong.',
  'no_collateral_damage — Did the operation avoid unintended side effects? For pause: schedule still exists (not deleted). For delete: skill file still present. For modify/resume: correct schedule targeted (not a different one). For all: no extra schedules created or removed beyond what was requested. Score 1.0 if clean, 0.0 if side effects detected.',
  'clean_confirmation — Does the head confirm the operation naturally to the user? Should not leak raw JSON, schedule IDs, cron syntax without explanation, or system internals. For list: response should be human-readable (not raw JSON). Score 1.0 if clean and natural, 0.5 if minor leakage, 0.0 if raw data dump.',
]

// ─── Skill file ──────────────────────────────────────────────────────────────

const EMAIL_SKILL_MD = `---
name: email-check
description: Check email inbox and summarize new messages.
trigger-tools:
  - bash
---

Check the user's email inbox and provide a summary of new messages.
`

const STANDUP_SKILL_MD = `---
name: daily-standup-notes
description: Compile daily standup notes from recent activity.
trigger-tools:
  - bash
---

Compile standup notes from recent activity.
`

const BACKUP_SKILL_MD = `---
name: weekly-backup
description: Run weekly backup of important files.
trigger-tools:
  - bash
---

Run a weekly backup of important user files.
`

// ─── Variants ─────────────────────────────────────────────────────────────────

interface ScheduleVariant {
  name: string
  query: string
  /** Skills to write into the skills dir before running. */
  skills: Array<{ name: string; content: string }>
  /** Schedules to seed into the store before running. */
  seedSchedules: Array<{ id: string; skillName: string; cron: string; enabled: boolean }>
  /** Per-variant context for the judge explaining what "correct" means. */
  judgeContext: string
  /** Verify store state after the query. Returns description of findings. */
  verifyState: (bundle: ReturnType<typeof freshHeadBundle>, skillsDir: string) => string
}

const EMAIL_SCHEDULE_ID = 'sched-email-check'

const SCHEDULE_VARIANTS: ScheduleVariant[] = [
  {
    name: 'create',
    query: 'Check my email every morning at 9am.',
    skills: [{ name: 'email-check', content: EMAIL_SKILL_MD }],
    seedSchedules: [],
    judgeContext: `The agent should call create_schedule with skillName "email-check" (or similar) and cron "0 9 * * *" (9am daily). After the turn, a schedule should exist in the store with that cron.`,
    verifyState: (bundle) => {
      const schedules = bundle.schedules.list()
      const emailSchedule = schedules.find(s => s.skillName.includes('email'))
      return `Schedules in store: ${schedules.length}. Email schedule found: ${!!emailSchedule}. ${emailSchedule ? `Cron: "${emailSchedule.cron}", enabled: ${emailSchedule.enabled}` : '(none)'}`
    },
  },
  {
    name: 'list',
    query: 'What do I have scheduled?',
    skills: [
      { name: 'email-check', content: EMAIL_SKILL_MD },
      { name: 'daily-standup-notes', content: STANDUP_SKILL_MD },
      { name: 'weekly-backup', content: BACKUP_SKILL_MD },
    ],
    seedSchedules: [
      { id: 'sched-email', skillName: 'email-check', cron: '0 9 * * *', enabled: true },
      { id: 'sched-standup', skillName: 'daily-standup-notes', cron: '0 10 * * 1-5', enabled: true },
      { id: 'sched-backup', skillName: 'weekly-backup', cron: '0 2 * * 0', enabled: false },
    ],
    judgeContext: `The agent should call list_schedules and return all 3 seeded schedules: email-check (9am daily, enabled), daily-standup-notes (10am weekdays, enabled), weekly-backup (2am Sundays, disabled). The head's response should be human-readable — not raw JSON or unexplained cron strings.`,
    verifyState: (bundle) => {
      const schedules = bundle.schedules.list()
      return `Schedules in store: ${schedules.length} (expected 3). Names: ${schedules.map(s => s.skillName).join(', ')}`
    },
  },
  {
    name: 'modify',
    query: 'Change the email check to 8:30 instead.',
    skills: [{ name: 'email-check', content: EMAIL_SKILL_MD }],
    seedSchedules: [
      { id: EMAIL_SCHEDULE_ID, skillName: 'email-check', cron: '0 9 * * *', enabled: true },
    ],
    judgeContext: `The agent should call update_schedule targeting the email-check schedule (ID "${EMAIL_SCHEDULE_ID}") and update the cron to "30 8 * * *" (8:30am daily). The schedule should remain enabled.`,
    verifyState: (bundle) => {
      const s = bundle.schedules.get(EMAIL_SCHEDULE_ID)
      return `Email schedule: ${s ? `cron="${s.cron}", enabled=${s.enabled}` : '(not found — may have been deleted!)'}`
    },
  },
  {
    name: 'pause',
    query: 'Pause the email check for now.',
    skills: [{ name: 'email-check', content: EMAIL_SKILL_MD }],
    seedSchedules: [
      { id: EMAIL_SCHEDULE_ID, skillName: 'email-check', cron: '0 9 * * *', enabled: true },
    ],
    judgeContext: `The agent should call update_schedule with enabled=false on the email-check schedule (ID "${EMAIL_SCHEDULE_ID}"). The schedule must remain in the store — NOT deleted. After the turn, the schedule should exist with enabled=false.`,
    verifyState: (bundle) => {
      const s = bundle.schedules.get(EMAIL_SCHEDULE_ID)
      return `Email schedule: ${s ? `exists=true, enabled=${s.enabled}` : 'MISSING (was deleted instead of paused!)'}`
    },
  },
  {
    name: 'resume',
    query: 'Turn the email check back on.',
    skills: [{ name: 'email-check', content: EMAIL_SKILL_MD }],
    seedSchedules: [
      { id: EMAIL_SCHEDULE_ID, skillName: 'email-check', cron: '0 9 * * *', enabled: false },
    ],
    judgeContext: `The agent should call update_schedule with enabled=true on the email-check schedule (ID "${EMAIL_SCHEDULE_ID}"). After the turn, the schedule should exist with enabled=true.`,
    verifyState: (bundle) => {
      const s = bundle.schedules.get(EMAIL_SCHEDULE_ID)
      return `Email schedule: ${s ? `exists=true, enabled=${s.enabled}` : '(not found)'}`
    },
  },
  {
    name: 'delete',
    query: 'Get rid of the email check schedule.',
    skills: [{ name: 'email-check', content: EMAIL_SKILL_MD }],
    seedSchedules: [
      { id: EMAIL_SCHEDULE_ID, skillName: 'email-check', cron: '0 9 * * *', enabled: true },
    ],
    judgeContext: `The agent should call delete_schedule on the email-check schedule (ID "${EMAIL_SCHEDULE_ID}"). After the turn, the schedule should be gone from the store. The skill file (email-check/SKILL.md) should still exist — only the schedule is removed, not the skill.`,
    verifyState: (bundle, skillsDir) => {
      const s = bundle.schedules.get(EMAIL_SCHEDULE_ID)
      const skillExists = fs.existsSync(path.join(skillsDir, 'email-check', 'SKILL.md'))
      return `Schedule exists: ${!!s}. Skill file preserved: ${skillExists}`
    },
  },
]

export const variants: EvalVariant[] = SCHEDULE_VARIANTS.map(v => ({
  name: v.name,
  query: v.query,
  setup: () => {},
  judgeContext: v.judgeContext,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderHistory(history: Message[]): string {
  return history.map(m => {
    if (m.kind === 'text') return `[${m.role}]: ${m.content}`
    if (m.kind === 'tool_call') {
      return m.toolCalls.map(tc =>
        `[tool_call: ${tc.name}] ${JSON.stringify(tc.input).slice(0, 300)}`
      ).join('\n')
    }
    if (m.kind === 'tool_result') {
      return m.toolResults.map(tr =>
        `[tool_result: ${tr.name}] ${tr.content.slice(0, 300)}`
      ).join('\n')
    }
    return `[${m.kind}]`
  }).join('\n\n')
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variantName = opts.variant?.name ?? SCHEDULE_VARIANTS[0]!.name
  const sv = SCHEDULE_VARIANTS.find(v => v.name === variantName) ?? SCHEDULE_VARIANTS[0]!

  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
    },
    skills: sv.skills.map(s => ({ name: s.name, content: s.content })),
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    // Seed schedules
    for (const sched of sv.seedSchedules) {
      env.bundle.schedules.create({
        id: sched.id,
        skillName: sched.skillName,
        cron: sched.cron,
      })
      if (!sched.enabled) {
        env.bundle.schedules.update(sched.id, { enabled: false })
      }
    }

    console.log(`\n[schedule-management:${sv.name}] Query: "${sv.query}"`)
    console.log(`[schedule-management:${sv.name}] Seeded ${sv.seedSchedules.length} schedule(s), ${sv.skills.length} skill(s)`)

    const agentsBefore = new Set(env.bundle.workers.getByStatus('completed').map(a => a.id))

    const { response, traceFiles, toolCalls } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: sv.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 120_000,
    })

    // Collect agent info
    const allAgents = [
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('running'),
      ...env.bundle.workers.getByStatus('suspended'),
      ...env.bundle.workers.getByStatus('failed'),
    ]
    const newAgents = allAgents.filter(a => !agentsBefore.has(a.id))
    const completedAgents = newAgents.filter(a => a.status === 'completed')
    const agentTranscript = completedAgents.length > 0
      ? completedAgents.map(a => renderHistory(a.history ?? [])).join('\n\n')
      : newAgents.length > 0
        ? `Agent spawned but status: ${newAgents.map(a => a.status).join(', ')}`
        : '(no agent spawned)'

    // Verify store state
    const stateVerification = sv.verifyState(env.bundle, env.skillsDir)

    console.log(`[schedule-management:${sv.name}] Agent spawned: ${newAgents.length > 0}, completed: ${completedAgents.length > 0}`)
    console.log(`[schedule-management:${sv.name}] State: ${stateVerification}`)
    console.log(`[schedule-management:${sv.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: sv.name,
      agentSpawned: newAgents.length > 0,
      agentCompleted: completedAgents.length > 0,
      agentStatuses: newAgents.map(a => ({ id: a.id, status: a.status })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
      stateVerification,
      schedulesAfter: env.bundle.schedules.list(),
    }

    if (opts.noJudge) {
      console.log(`\n[schedule-management:${sv.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      console.log('\nAgent transcript:')
      console.log(agentTranscript)
      return
    }

    console.log(`[schedule-management:${sv.name}] Running judge...`)

    const context = `
SCENARIO: Schedule management lifecycle test — variant "${sv.name}".
USER QUERY: "${sv.query}"

VARIANT EXPECTATIONS:
${sv.judgeContext}

HEAD TOOL CALLS (in order):
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

AGENTS SPAWNED: ${newAgents.length}
${newAgents.map(a => `- Agent ${a.id}: status=${a.status}`).join('\n') || '(none)'}

AGENT TRANSCRIPT (tool calls and results from the agent):
${agentTranscript}

HEAD FINAL RESPONSE TO USER:
${response}

STORE STATE AFTER OPERATION:
${stateVerification}
Schedules in store: ${JSON.stringify(env.bundle.schedules.list().map(s => ({ id: s.id, skillName: s.skillName, cron: s.cron, enabled: s.enabled })), null, 2)}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: sv.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('schedule-management', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `schedule-management-${sv.name}`,
    })
    printJudgment(sv.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Schedule-management [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
