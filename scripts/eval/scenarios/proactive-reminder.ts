/**
 * Proactive reminder decision scenario.
 *
 * Tests the proactive decision layer for reminders — whether it correctly
 * injects relevant reminders and skips ones that have been overtaken by
 * recent conversation.
 *
 * Three sub-scenarios:
 * 1. Relevant — reminder to "follow up with Sarah about the proposal" with
 *    no prior discussion of Sarah. Should inject.
 * 2. Already handled — reminder to "follow up with Sarah" but the user just
 *    discussed the proposal with Sarah 10 minutes ago. Should skip.
 * 3. Cancelled need — reminder to "book dentist appointment" but the user
 *    said they already booked it yesterday. Should skip.
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

export const name = 'proactive-reminder'
export const description = 'Proactive reminder decision correctly injects relevant reminders and skips handled ones'
export const category = 'reliability'
export const estimatedCostUsd = 0.06
export const rubric = [
  'inject_relevant — when the reminder is about something not yet discussed, it should be injected (not skipped). Score 1.0 if injected, 0.0 if skipped.',
  'skip_already_handled — when the reminded task was clearly completed in recent conversation, it should be skipped. Score 1.0 if skipped, 0.0 if injected.',
  'skip_cancelled — when the user explicitly said they already handled the reminded thing, it should be skipped. Score 1.0 if skipped, 0.0 if injected.',
  'skip_reason_sensible — for skipped cases, are the reasons clear and accurate? Score 1.0 if reasons reference the actual conversation context, 0.5 if vague, 0.0 if fabricated.',
]

const REMINDER_ID = 'rem-test'

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envConfig = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
    proactiveEnabled: true,
  }

  const envs: EvalEnvironment[] = []
  try {
    // ── Sub-scenario 1: relevant reminder → should INJECT ─────────────────────
    console.log('[proactive-reminder] Sub-scenario 1: relevant reminder (expect inject)...')
    const env1 = makeProductionEnvironment({ config: envConfig })
    envs.push(env1)
    const topicMemory1 = createTopicMemory(path.join(env1.workspaceDir, 'topics'), llm)

    // Normal conversation, no mention of Sarah or proposals
    env1.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user',
      content: 'Can you help me plan my presentation for Thursday?',
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })
    env1.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant',
      content: 'Sure! What topic is the presentation on? I can help you structure the slides and talking points.',
      createdAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    })

    const event1: QueueEvent = {
      type: 'reminder_trigger',
      id: generateId('ev'),
      reminderId: REMINDER_ID,
      message: 'Follow up with Sarah about the proposal',
      channel: 'eval',
      createdAt: new Date().toISOString(),
    }

    const result1 = await runHeadEvent({
      bundle: env1.bundle,
      topicMemory: topicMemory1,
      router,
      config: env1.config,
      identityDir: env1.identityDir,
      workspaceDir: env1.workspaceDir,
      event: event1,
      stubAgentRunner: true,
    })

    // Check if reminder was injected (head responded) or skipped (no response)
    const sent1 = env1.bundle.channelRouter.sent.length
    const allMsgs1 = env1.bundle.messages.getAll()
    const reminderInjected1 = allMsgs1.some(m => m.kind === 'text' && m.content.includes('Follow up with Sarah'))
    console.log(`[proactive-reminder] Relevant: injected = ${reminderInjected1}, messages sent = ${sent1}`)

    // ── Sub-scenario 2: already handled → should SKIP ─────────────────────────
    console.log('[proactive-reminder] Sub-scenario 2: already handled (expect skip)...')
    const env2 = makeProductionEnvironment({ config: envConfig })
    envs.push(env2)
    const topicMemory2 = createTopicMemory(path.join(env2.workspaceDir, 'topics'), llm)

    // Conversation where the user just discussed the proposal with Sarah
    env2.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user',
      content: 'Just got off a call with Sarah. We went through the proposal line by line and she approved it with minor edits. She\'ll send the signed version by end of day.',
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    env2.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant',
      content: 'Great news! So the proposal is approved with minor edits, and Sarah will send the signed version by end of day. Want me to set a reminder to check for it this evening?',
      createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    })

    const event2: QueueEvent = {
      type: 'reminder_trigger',
      id: generateId('ev'),
      reminderId: REMINDER_ID,
      message: 'Follow up with Sarah about the proposal',
      channel: 'eval',
      createdAt: new Date().toISOString(),
    }

    const result2 = await runHeadEvent({
      bundle: env2.bundle,
      topicMemory: topicMemory2,
      router,
      config: env2.config,
      identityDir: env2.identityDir,
      workspaceDir: env2.workspaceDir,
      event: event2,
      stubAgentRunner: true,
    })

    const allMsgs2 = env2.bundle.messages.getAll()
    const reminderInjected2 = allMsgs2.some(m => m.kind === 'text' && m.content.includes('Follow up with Sarah'))
    console.log(`[proactive-reminder] Already handled: injected = ${reminderInjected2}`)

    // ── Sub-scenario 3: cancelled need → should SKIP ──────────────────────────
    console.log('[proactive-reminder] Sub-scenario 3: cancelled need (expect skip)...')
    const env3 = makeProductionEnvironment({ config: envConfig })
    envs.push(env3)
    const topicMemory3 = createTopicMemory(path.join(env3.workspaceDir, 'topics'), llm)

    // User said they already handled it
    env3.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'user',
      content: 'Oh by the way, I already booked that dentist appointment yesterday. Got one for next Tuesday at 2pm.',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    })
    env3.bundle.messages.append({
      kind: 'text', id: generateId('msg'), role: 'assistant',
      content: 'Good to hear! I\'ll note that — dentist appointment next Tuesday at 2pm.',
      createdAt: new Date(Date.now() - 59 * 60_000).toISOString(),
    })

    const event3: QueueEvent = {
      type: 'reminder_trigger',
      id: generateId('ev'),
      reminderId: REMINDER_ID,
      message: 'Book a dentist appointment',
      channel: 'eval',
      createdAt: new Date().toISOString(),
    }

    const result3 = await runHeadEvent({
      bundle: env3.bundle,
      topicMemory: topicMemory3,
      router,
      config: env3.config,
      identityDir: env3.identityDir,
      workspaceDir: env3.workspaceDir,
      event: event3,
      stubAgentRunner: true,
    })

    const allMsgs3 = env3.bundle.messages.getAll()
    const reminderInjected3 = allMsgs3.some(m => m.kind === 'text' && m.content.includes('Book a dentist'))
    console.log(`[proactive-reminder] Cancelled: injected = ${reminderInjected3}`)

    // ── Results ────────────────────────────────────────────────────────────────
    const output = {
      relevantInjected: reminderInjected1,
      alreadyHandledInjected: reminderInjected2,
      cancelledInjected: reminderInjected3,
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[SUB-SCENARIO 1: No prior discussion of Sarah — reminder "Follow up with Sarah about the proposal"]' },
      { role: 'assistant', content: reminderInjected1 ? '(reminder injected to head)' : '(reminder skipped)' },
      { role: 'user', content: '[SUB-SCENARIO 2: User just discussed proposal with Sarah 10 min ago — same reminder fires]' },
      { role: 'assistant', content: reminderInjected2 ? '(reminder injected — should have been skipped!)' : '(reminder skipped)' },
      { role: 'user', content: '[SUB-SCENARIO 3: User said "I already booked the dentist" — reminder "Book a dentist appointment"]' },
      { role: 'assistant', content: reminderInjected3 ? '(reminder injected — should have been skipped!)' : '(reminder skipped)' },
    ]

    const traceFiles = { ...result1.traceFiles, ...result2.traceFiles, ...result3.traceFiles }

    if (opts.noJudge) {
      console.log('\n[proactive-reminder] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log('[proactive-reminder] Running judge...')
    const context = `
The proactive reminder decision was tested with three scenarios.

Sub-scenario 1 — Relevant reminder (no prior discussion of Sarah or proposals):
  Reminder: "Follow up with Sarah about the proposal"
  Injected: ${reminderInjected1}
  Result: ${reminderInjected1 ? 'INJECTED (correct — reminder is relevant)' : 'SKIPPED (should have been injected — nothing in conversation addresses this)'}

Sub-scenario 2 — Already handled (user discussed proposal with Sarah 10 minutes ago, got approval):
  Reminder: "Follow up with Sarah about the proposal"
  Injected: ${reminderInjected2}
  Result: ${!reminderInjected2 ? 'SKIPPED (correct — follow-up already completed)' : 'INJECTED (should have been skipped — Sarah already approved the proposal)'}

Sub-scenario 3 — Cancelled need (user said "I already booked the dentist appointment yesterday"):
  Reminder: "Book a dentist appointment"
  Injected: ${reminderInjected3}
  Result: ${!reminderInjected3 ? 'SKIPPED (correct — user already booked it)' : 'INJECTED (should have been skipped — appointment already booked)'}
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('proactive-reminder', history, output, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    for (const env of envs) cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Proactive-reminder eval results ──────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
