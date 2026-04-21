/**
 * Ambient context scenario.
 *
 * Tests whether AMBIENT.md content is actually used by the system when
 * making decisions. Seeds a workspace with specific ambient context and
 * verifies it influences behavior.
 *
 * Two sub-scenarios:
 * 1. Proactive decision with ambient — AMBIENT.md says the user has a
 *    dentist appointment at 2pm. A schedule fires for email-triage.
 *    The proactive decision's context field should mention the appointment
 *    so the skill agent knows to be brief / flag anything about the dentist.
 * 2. Head uses ambient — AMBIENT.md says there's a package delivery expected
 *    today. User asks "anything I should know about today?" The head should
 *    mention the delivery without the user having previously discussed it.
 */

import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId } from '../../../src/llm/util.js'
import type { QueueEvent } from '../../../src/types/core.js'
import { runProactiveDecision, type ProactiveContext } from '../../../src/scheduler/proactive.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  type EvalEnvironment,
  runHeadQuery,
  type EvalMessage,
  type Judgment,
} from '../harness.js'

export const name = 'ambient-context'
export const description = 'System uses AMBIENT.md content when making decisions and answering questions'
export const category = 'reliability'
export const estimatedCostUsd = 0.06
export const rubric = [
  'proactive_ambient_aware — when AMBIENT.md mentions a dentist appointment at 2pm, the proactive decision for email-triage should still allow the skill to run (not skip based on the appointment). The proactive decision sees ambient context and should not treat a busy schedule as a reason to skip a background task. Score 1.0 if action is "run", 0.0 if skipped.',
  'head_uses_ambient — when AMBIENT.md mentions a package delivery and the user asks "anything I should know about today?", the head should mention the delivery. Score 1.0 if delivery is mentioned, 0.5 if response is relevant but misses the delivery, 0.0 if no mention at all.',
  'agent_uses_ambient — when the head spawns an agent to help the user and AMBIENT.md is present, the agent should be aware of ambient context. User asks "write me a quick summary of my day so far" — agent output should reference ambient items (dentist, delivery, sprint retro). Score 1.0 if output references ambient items, 0.5 if partial, 0.0 if agent ignores ambient context entirely.',
]

const AMBIENT_CONTENT = `Last updated: ${new Date().toISOString()}

- Dentist appointment today at 2:00 PM at Dr. Miller's office (123 Oak St)
- Package delivery expected today �� new monitor from Amazon, tracking says "out for delivery"
- Sprint retro moved from Thursday to Friday at 3pm
- Grocery list: milk, eggs, bread (added yesterday)
`

const EMAIL_SKILL_INSTRUCTIONS = `Check the user's email inbox. Triage messages by urgency.
Flag anything time-sensitive or from known important contacts.
Report only if there are items requiring attention.`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envConfig = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
    proactiveEnabled: true,
  }

  const nowDate = new Date()
  const currentMinute = nowDate.getUTCMinutes()
  const currentHour = nowDate.getUTCHours()
  const scheduleCron = `${currentMinute} ${currentHour} * * *`

  // Create a single env for proactive config, plus separate envs for head sub-scenarios
  const env = makeProductionEnvironment({ config: envConfig, ambientContent: AMBIENT_CONTENT })
  const envs: EvalEnvironment[] = [env]
  try {
    // ── Sub-scenario 1: proactive decision with ambient context ────────────────
    console.log('[ambient-context] Sub-scenario 1: proactive decision with ambient...')

    const decision = await runProactiveDecision({
      skillName: 'email-triage',
      skillDescription: 'Check email inbox and triage messages.',
      skillInstructions: EMAIL_SKILL_INSTRUCTIONS,
      scheduleCron,
      lastRun: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastSkipped: null,
      lastSkipReason: null,
      userMd: 'Software engineer, busy schedule.',
      recentHistory: [
        { role: 'user', content: 'Good morning!', createdAt: new Date(Date.now() - 30 * 60_000).toISOString() },
        { role: 'assistant', content: 'Good morning! Ready for the day?', createdAt: new Date(Date.now() - 29 * 60_000).toISOString() },
      ],
      ambientContext: AMBIENT_CONTENT,
      currentTime: new Date().toISOString(),
    }, router, env.config.stewardModel)

    console.log(`[ambient-context] Proactive: action=${decision.action}, context=${decision.context ?? '(none)'}`)

    // ── Sub-scenario 2: head uses ambient context ─────────────────────────────
    console.log('[ambient-context] Sub-scenario 2: head answering with ambient context...')

    const env2 = makeProductionEnvironment({ config: envConfig, ambientContent: AMBIENT_CONTENT })
    envs.push(env2)
    const topicMemory = createTopicMemory(path.join(env2.workspaceDir, 'topics'), llm)

    const { response } = await runHeadQuery({
      bundle: env2.bundle,
      topicMemory,
      router,
      config: env2.config,
      query: 'Hey, anything I should know about today?',
      identityDir: env2.identityDir,
      workspaceDir: env2.workspaceDir,
    })

    console.log(`[ambient-context] Head response: ${response.slice(0, 200)}`)

    // ── Sub-scenario 3: agent uses ambient context ────────────────────────────
    console.log('[ambient-context] Sub-scenario 3: agent task using ambient context...')
    const env3 = makeProductionEnvironment({ config: envConfig, ambientContent: AMBIENT_CONTENT })
    envs.push(env3)
    const topicMemory2 = createTopicMemory(path.join(env3.workspaceDir, 'topics'), llm)

    const { response: agentResponse } = await runHeadQuery({
      bundle: env3.bundle,
      topicMemory: topicMemory2,
      router,
      config: env3.config,
      query: 'Write me a quick note summarizing what I have going on today so I can reference it later.',
      identityDir: env3.identityDir,
      workspaceDir: env3.workspaceDir,
      timeoutMs: 120_000,
    })

    console.log(`[ambient-context] Agent response: ${agentResponse.slice(0, 200)}`)

    // ── Results ────────────────────────────────────────────────────────────────
    const output = {
      proactiveAction: decision.action,
      proactiveContext: decision.context ?? null,
      headResponse: response,
      agentResponse,
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[SUB-SCENARIO 1: AMBIENT.md has dentist at 2pm + package delivery — email-triage proactive fires]' },
      { role: 'assistant', content: `proactive action: ${decision.action}, reason: ${decision.reason}` },
      { role: 'user', content: '[SUB-SCENARIO 2: Same AMBIENT.md — user asks "anything I should know about today?"]' },
      { role: 'assistant', content: response },
      { role: 'user', content: '[SUB-SCENARIO 3: Same AMBIENT.md — user asks to write a summary note of their day]' },
      { role: 'assistant', content: agentResponse },
    ]

    if (opts.noJudge) {
      console.log('\n[ambient-context] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log('[ambient-context] Running judge...')
    const context = `
AMBIENT.md content provided to the system:
${AMBIENT_CONTENT}

Sub-scenario 1 — Proactive decision for email-triage with ambient context:
  Action: ${decision.action}
  Reason: ${decision.reason}
  Expected: action should be "run" — a dentist appointment is not a reason to skip a background email triage

Sub-scenario 2 — User asks "anything I should know about today?" with ambient context:
  Head response: "${response}"
  Expected: response should mention the package delivery (and possibly other ambient items)

Sub-scenario 3 — User asks to "write a summary note of what I have going on today":
  Response: "${agentResponse}"
  Expected: response should reference ambient items — dentist at 2pm, package delivery, sprint retro on Friday. Whether answered by head directly or via spawned agent, the ambient context should be reflected.
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('ambient-context', history, output, judgment, { runId: opts.runId, category })
    printJudgment(judgment, txtPath)
  } finally {
    for (const e of envs) cleanupEnvironment(e)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Ambient-context eval results ──────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
