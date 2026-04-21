/**
 * Relay judge scenario.
 *
 * Tests the pre-activation relay judge that decides whether a scheduled
 * agent's output is worth surfacing to the user.
 *
 * Two sub-scenarios:
 * 1. Suppress — benign "all clear" email output → judge should suppress,
 *    head never activates, no message sent to user
 * 2. Relay — critical error output → judge should relay,
 *    head activates and sends a message
 *
 * Both use a real LLM for the relay judge call. The relay judge reads skill
 * instructions, USER.md, and recent history — this eval verifies those signals
 * actually influence the decision correctly.
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

export const name = 'relay-judge'
export const description = 'Relay judge correctly suppresses benign scheduled outputs and relays critical ones'
export const category = 'reliability'
export const estimatedCostUsd = 0.04
export const rubric = [
  'suppress_benign — benign "all clear" email output is suppressed (relay=false, 0 messages sent to user). Score 1.0 if silent, 0.0 if the user received a message.',
  'relay_critical — critical disk-full error is relayed (relay=true, head activates and sends a message). Score 1.0 if user received an alert, 0.0 if silently dropped.',
  'relay_content_appropriate — for the relayed case, is the message the head sends appropriate and accurate (mentions the error, not fabricated)? Score 1.0 if appropriate, 0.5 if vague, 0.0 if wrong.',
]

const EMAIL_SKILL = `---
name: email
description: Periodic system check — scans for stale agents, disk usage anomalies, and anything worth surfacing to the user.
---

Check disk usage, agent health, and schedule status. Report only if something is wrong or requires attention. If everything is nominal, there is nothing to report.
`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envConfig = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
  }
  const skillOverride = [{ name: 'email', content: EMAIL_SKILL }]

  const envs: EvalEnvironment[] = []
  try {
    // ── Sub-scenario 1: suppress benign output ─────────────────────────────────
    console.log('[relay-judge] Sub-scenario 1: benign email (expect suppress)...')
    const env1 = makeProductionEnvironment({ config: envConfig, skills: skillOverride })
    envs.push(env1)
    const topicMemory1 = createTopicMemory(path.join(env1.workspaceDir, 'topics'), llm)

    const benignAgentId = generateId('agent')
    env1.bundle.workers.create(benignAgentId, {
      prompt: "Run the scheduled 'email' skill.",
      trigger: 'scheduled',
      skillName: 'email',
    })
    env1.bundle.workers.complete(benignAgentId, 'All systems nominal. Disk usage 61%. No agents running. No issues found.', [])

    const benignEvent: QueueEvent = {
      type: 'agent_completed',
      id: generateId('ev'),
      agentId: benignAgentId,
      output: 'All systems nominal. Disk usage 61%. No agents running. No issues found.',
      createdAt: new Date().toISOString(),
    }

    const result1 = await runHeadEvent({
      bundle: env1.bundle,
      topicMemory: topicMemory1,
      router,
      config: env1.config,
      identityDir: env1.identityDir,
      workspaceDir: env1.workspaceDir,
      event: benignEvent,
      stubAgentRunner: true,
    })
    const benignSent = env1.bundle.channelRouter.sent.length
    console.log(`[relay-judge] Benign: ${benignSent} messages sent`)

    // ── Sub-scenario 2: relay critical output ──────────────────────────────────
    console.log('[relay-judge] Sub-scenario 2: critical disk error (expect relay)...')
    const env2 = makeProductionEnvironment({ config: envConfig, skills: skillOverride })
    envs.push(env2)
    const topicMemory2 = createTopicMemory(path.join(env2.workspaceDir, 'topics'), llm)

    const criticalAgentId = generateId('agent')
    env2.bundle.workers.create(criticalAgentId, {
      prompt: "Run the scheduled 'email' skill.",
      trigger: 'scheduled',
      skillName: 'email',
    })
    env2.bundle.workers.complete(criticalAgentId, 'CRITICAL: Disk at 97% capacity (/dev/sda1). Immediate attention required — system may become unresponsive.', [])

    const criticalEvent: QueueEvent = {
      type: 'agent_completed',
      id: generateId('ev'),
      agentId: criticalAgentId,
      output: 'CRITICAL: Disk at 97% capacity (/dev/sda1). Immediate attention required — system may become unresponsive.',
      createdAt: new Date().toISOString(),
    }

    const result2 = await runHeadEvent({
      bundle: env2.bundle,
      topicMemory: topicMemory2,
      router,
      config: env2.config,
      identityDir: env2.identityDir,
      workspaceDir: env2.workspaceDir,
      event: criticalEvent,
      stubAgentRunner: true,
    })
    const criticalSent = env2.bundle.channelRouter.sent
    console.log(`[relay-judge] Critical: ${criticalSent.length} messages sent`)
    if (criticalSent.length > 0) console.log(`[relay-judge] Message: ${criticalSent[0]?.text}`)

    // ── Results ────────────────────────────────────────────────────────────────
    const output = {
      benignMessagesSent: benignSent,
      benignSuppressed: benignSent === 0,
      criticalMessagesSent: criticalSent.length,
      criticalRelayed: criticalSent.length > 0,
      criticalMessage: criticalSent[0]?.text ?? null,
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[BACKGROUND EVENT: email — all systems nominal, disk 61%]' },
      ...(benignSent > 0 ? [{ role: 'assistant' as const, content: `(head responded): ${env1.bundle.channelRouter.sent.map(s => s.text).join(' | ')}` }] : []),
      { role: 'user', content: '[BACKGROUND EVENT: email — CRITICAL disk at 97%]' },
      ...criticalSent.map(s => ({ role: 'assistant' as const, content: s.text })),
    ]

    const traceFiles = { ...result1.traceFiles, ...result2.traceFiles }

    if (opts.noJudge) {
      console.log('\n[relay-judge] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log('[relay-judge] Running judge...')
    const context = `
The relay judge was tested with two scheduled email completions.

Sub-scenario 1 — Benign output ("All systems nominal. Disk usage 61%. No agents running. No issues found."):
  Messages sent to user: ${benignSent}
  Result: ${benignSent === 0 ? 'SUPPRESSED (correct)' : 'RELAYED (should have been suppressed)'}

Sub-scenario 2 — Critical output ("CRITICAL: Disk at 97% capacity (/dev/sda1). Immediate attention required."):
  Messages sent to user: ${criticalSent.length}
  Message content: ${criticalSent[0]?.text ?? '(none)'}
  Result: ${criticalSent.length > 0 ? 'RELAYED (correct)' : 'SUPPRESSED (should have been relayed)'}
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('relay-judge', history, output, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    for (const env of envs) cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Relay-judge eval results ──────────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
