/**
 * Proactive decision scenario.
 *
 * Tests the pre-spawn proactive decision that decides whether a scheduled
 * skill should run or be skipped based on head context.
 *
 * Three sub-scenarios:
 * 1. Run — normal context, skill is relevant → proactive decision should allow run,
 *    agent spawns and completes normally
 * 2. Skip (vacation) — user recently said they're on vacation → proactive decision
 *    should skip, no agent spawned
 * 3. Skip (just done manually) — user just ran the skill manually minutes ago →
 *    proactive decision should skip, no agent spawned
 *
 * All use a real LLM for the proactive decision call. The proactive decision reads
 * skill instructions, USER.md, schedule history, and recent conversation — this eval
 * verifies those signals actually influence the decision correctly.
 */

import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId } from '../../../src/llm/util.js'
import type { QueueEvent } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  type EvalEnvironment,
  runHeadEvent,
  type EvalMessage,
  type Judgment,
} from '../harness.js'

export const name = 'proactive-decision'
export const description = 'Proactive decision correctly runs relevant schedules and skips irrelevant ones'
export const category = 'reliability'
export const estimatedCostUsd = 0.08
export const rubric = [
  'run_relevant — when context is normal (no reason to skip), the proactive decision allows the schedule to run (not skipped). Score 1.0 if not skipped, 0.0 if skipped.',
  'skip_vacation — when the user recently said they are on vacation, the proactive decision skips the schedule. Score 1.0 if skipped, 0.0 if allowed to run.',
  'skip_just_done — when the user just manually ran the same task minutes ago, the proactive decision skips the schedule. Score 1.0 if skipped, 0.0 if allowed to run.',
  'skip_reason_sensible — for the skipped cases, does the skip reason stored in the schedule make sense? (mentions vacation, or recently done manually.) Score 1.0 if reason is clear and accurate, 0.5 if vague, 0.0 if nonsensical.',
]

const EMAIL_SKILL = `---
name: email-triage
description: Check email inbox and triage messages — flag urgent items, archive junk, summarize what needs attention.
---

Check the user's email inbox. Triage messages by urgency:
- Flag anything time-sensitive or from known important contacts
- Archive obvious junk and newsletters
- Summarize what needs the user's attention

Report only if there are items requiring attention. If inbox is clean, say so briefly.
`

const SCHEDULE_ID = 'sched-email-triage'

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envConfig = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
    proactiveEnabled: true,
  }
  const skillOverride = [{ name: 'email-triage', content: EMAIL_SKILL }]

  // Build a cron expression matching the current time so the model doesn't
  // see a mismatch between the schedule and the clock (the scheduler already
  // validated timing — we don't want the proactive decision second-guessing it).
  const nowDate = new Date()
  const currentMinute = nowDate.getUTCMinutes()
  const currentHour = nowDate.getUTCHours()
  const scheduleCron = `${currentMinute} ${currentHour} * * *`

  const scheduleEvent: QueueEvent = {
    type: 'schedule_trigger',
    id: generateId('ev'),
    scheduleId: SCHEDULE_ID,
    skillName: 'email-triage',
    kind: 'skill',
    createdAt: new Date().toISOString(),
  }

  const envs: EvalEnvironment[] = []
  try {
    // ── Sub-scenario 1: normal context → should RUN ───────────────────────────
    console.log('[proactive-decision] Sub-scenario 1: normal context (expect run)...')
    const env1 = makeProductionEnvironment({ config: envConfig, skills: skillOverride })
    envs.push(env1)
    const topicMemory1 = createTopicMemory(path.join(env1.workspaceDir, 'topics'), llm)

    // Seed schedule — cron matches current time so there's no timing ambiguity
    env1.bundle.schedules.create({
      id: SCHEDULE_ID,
      skillName: 'email-triage',
      cron: scheduleCron,
      nextRun: new Date().toISOString(),
    })

    // Seed some normal recent conversation
    env1.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user', content: 'Good morning! Can you check what meetings I have today?', createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })
    env1.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant', content: 'Good morning! Let me check your calendar. You have a standup at 10am and a 1:1 with Sarah at 2pm.', createdAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    })

    const result1 = await runHeadEvent({
      bundle: env1.bundle,
      topicMemory: topicMemory1,
      router,
      config: env1.config,
      identityDir: env1.identityDir,
      workspaceDir: env1.workspaceDir,
      event: { ...scheduleEvent, id: generateId('ev') },
      stubAgentRunner: true,
    })

    // Check whether the proactive decision allowed the run or skipped it.
    // We use lastSkipped as the signal — stubAgentRunner means no real agent is created,
    // but the proactive decision still records skips in the schedule store.
    const schedule1 = env1.bundle.schedules.get(SCHEDULE_ID)
    const wasSkipped1 = !!schedule1?.lastSkipped
    console.log(`[proactive-decision] Normal: skipped = ${wasSkipped1}`)

    // ── Sub-scenario 2: user on vacation → should SKIP ────────────────────────
    console.log('[proactive-decision] Sub-scenario 2: user on vacation (expect skip)...')
    const env2 = makeProductionEnvironment({ config: envConfig, skills: skillOverride })
    envs.push(env2)
    const topicMemory2 = createTopicMemory(path.join(env2.workspaceDir, 'topics'), llm)

    env2.bundle.schedules.create({
      id: SCHEDULE_ID,
      skillName: 'email-triage',
      cron: scheduleCron,
      nextRun: new Date().toISOString(),
    })

    // Seed conversation where user explicitly says they're on vacation
    env2.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user', content: "I'm heading out on vacation for the next two weeks starting today. Don't need any work updates until I'm back.", createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    })
    env2.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant', content: "Enjoy your vacation! I'll hold off on work-related updates until you're back. Have a great time!", createdAt: new Date(Date.now() - 59 * 60_000).toISOString(),
    })

    const result2 = await runHeadEvent({
      bundle: env2.bundle,
      topicMemory: topicMemory2,
      router,
      config: env2.config,
      identityDir: env2.identityDir,
      workspaceDir: env2.workspaceDir,
      event: { ...scheduleEvent, id: generateId('ev') },
      stubAgentRunner: true,
    })

    const schedule2 = env2.bundle.schedules.get(SCHEDULE_ID)
    const wasSkipped2 = !!schedule2?.lastSkipped
    console.log(`[proactive-decision] Vacation: skipped = ${wasSkipped2}, reason = ${schedule2?.lastSkipReason ?? '(none)'}`)

    // ── Sub-scenario 3: just done manually → should SKIP ──────────────────────
    console.log('[proactive-decision] Sub-scenario 3: just done manually (expect skip)...')
    const env3 = makeProductionEnvironment({ config: envConfig, skills: skillOverride })
    envs.push(env3)
    const topicMemory3 = createTopicMemory(path.join(env3.workspaceDir, 'topics'), llm)

    env3.bundle.schedules.create({
      id: SCHEDULE_ID,
      skillName: 'email-triage',
      cron: scheduleCron,
      nextRun: new Date().toISOString(),
    })
    // Mark as having run before so the model doesn't treat this as a first-ever run
    env3.bundle.schedules.markFired(SCHEDULE_ID, new Date(Date.now() - 24 * 60 * 60_000).toISOString(), new Date().toISOString())

    // Seed conversation where user just asked to check email manually
    env3.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user', content: 'Check my email for me.', createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    })
    env3.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant', content: "I've checked your inbox. You have 3 new messages — one urgent from your manager about the Q2 deadline, one newsletter, and a shipping notification. I've flagged the manager's email for you.", createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    })

    const result3 = await runHeadEvent({
      bundle: env3.bundle,
      topicMemory: topicMemory3,
      router,
      config: env3.config,
      identityDir: env3.identityDir,
      workspaceDir: env3.workspaceDir,
      event: { ...scheduleEvent, id: generateId('ev') },
      stubAgentRunner: true,
    })

    const schedule3 = env3.bundle.schedules.get(SCHEDULE_ID)
    const wasSkipped3 = !!schedule3?.lastSkipped
    console.log(`[proactive-decision] Just done: skipped = ${wasSkipped3}, reason = ${schedule3?.lastSkipReason ?? '(none)'}`)

    // ── Results ────────────────────────────────────────────────────────────────
    const output = {
      normalSkipped: wasSkipped1,
      vacationSkipped: wasSkipped2,
      vacationSkipReason: schedule2?.lastSkipReason ?? null,
      justDoneSkipped: wasSkipped3,
      justDoneSkipReason: schedule3?.lastSkipReason ?? null,
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[SUB-SCENARIO 1: Normal context — user asked about meetings, email-triage schedule fires]' },
      { role: 'assistant', content: wasSkipped1 ? `(schedule skipped: ${schedule1?.lastSkipReason ?? 'unknown'})` : '(proactive decision: run — agent would be spawned)' },
      { role: 'user', content: '[SUB-SCENARIO 2: User said "on vacation for two weeks, no work updates" — email-triage schedule fires]' },
      { role: 'assistant', content: wasSkipped2 ? `(schedule skipped: ${schedule2?.lastSkipReason ?? 'unknown reason'})` : '(proactive decision: run — should have been skipped!)' },
      { role: 'user', content: '[SUB-SCENARIO 3: User manually checked email 5 minutes ago — email-triage schedule fires]' },
      { role: 'assistant', content: wasSkipped3 ? `(schedule skipped: ${schedule3?.lastSkipReason ?? 'unknown reason'})` : '(proactive decision: run — should have been skipped!)' },
    ]

    const traceFiles = { ...result1.traceFiles, ...result2.traceFiles, ...result3.traceFiles }

    if (opts.noJudge) {
      console.log('\n[proactive-decision] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log('[proactive-decision] Running judge...')
    const context = `
The proactive decision was tested with three scheduled email-triage trigger scenarios.
The proactive decision either allows the schedule to run (no lastSkipped set) or skips it (lastSkipped + reason recorded).

Sub-scenario 1 — Normal context (user asked about meetings, normal workday):
  Skipped: ${wasSkipped1}
  Skip reason: "${schedule1?.lastSkipReason ?? '(none)'}"
  Result: ${!wasSkipped1 ? 'RAN (correct — task is relevant, no reason to skip)' : 'SKIPPED (should have run — no reason to skip)'}

Sub-scenario 2 — User on vacation ("I'm heading out on vacation for two weeks, don't need any work updates"):
  Skipped: ${wasSkipped2}
  Skip reason: "${schedule2?.lastSkipReason ?? '(none)'}"
  Result: ${wasSkipped2 ? 'SKIPPED (correct — user is on vacation)' : 'RAN (should have been skipped — user explicitly said no work updates)'}

Sub-scenario 3 — Just done manually (user said "check my email" 5 minutes ago, got a full triage):
  Skipped: ${wasSkipped3}
  Skip reason: "${schedule3?.lastSkipReason ?? '(none)'}"
  Result: ${wasSkipped3 ? 'SKIPPED (correct — task was just done manually)' : 'RAN (should have been skipped — identical task completed minutes ago)'}
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('proactive-decision', history, output, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    for (const env of envs) cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Proactive-decision eval results ──────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
