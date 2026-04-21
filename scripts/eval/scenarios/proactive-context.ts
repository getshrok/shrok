/**
 * Proactive context passthrough scenario.
 *
 * Tests whether the proactive decision provides meaningful context to the
 * skill agent when deciding to run. The skill agent runs blind (no head
 * history), so context from the proactive decision is its only window into
 * what the user cares about.
 *
 * Two sub-scenarios:
 * 1. Specific expectation — user mentioned expecting an important email from
 *    a specific person. The proactive decision should pass that context so
 *    the email-triage agent can prioritize it.
 * 2. No notable context — mundane conversation with nothing particularly
 *    relevant to the skill. Context should be absent or generic.
 */

import { runProactiveDecision, type ProactiveContext } from '../../../src/scheduler/proactive.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeProductionEnvironment,
  cleanupEnvironment,
  type EvalMessage,
  type Judgment,
} from '../harness.js'

export const name = 'proactive-context'
export const description = 'Proactive decision passes meaningful context to skill agents when relevant'
export const category = 'reliability'
export const estimatedCostUsd = 0.04
export const rubric = [
  'context_specific — when the user mentioned expecting an important email from a specific person (David Chen, contract), the proactive decision should include context mentioning that person or topic. Score 1.0 if context references David/contract/expected email, 0.5 if context is present but vague, 0.0 if no context or irrelevant.',
  'context_absent_when_mundane — when the conversation has nothing relevant to email triage, context should be absent or minimal. Score 1.0 if context is empty/absent/generic, 0.5 if context includes irrelevant details, 0.0 if context fabricates relevance.',
]

const EMAIL_SKILL_INSTRUCTIONS = `Check the user's email inbox. Triage messages by urgency:
- Flag anything time-sensitive or from known important contacts
- Archive obvious junk and newsletters
- Summarize what needs the user's attention

Report only if there are items requiring attention. If inbox is clean, say so briefly.`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      llmMaxTokens: 2048,
      proactiveEnabled: true,
    },
  })

  const nowDate = new Date()
  const currentMinute = nowDate.getUTCMinutes()
  const currentHour = nowDate.getUTCHours()
  const scheduleCron = `${currentMinute} ${currentHour} * * *`

  try {
    // ── Sub-scenario 1: specific expectation ──────────────────────────────────
    console.log('[proactive-context] Sub-scenario 1: user expecting important email...')

    const decision1 = await runProactiveDecision({
      skillName: 'email-triage',
      skillDescription: 'Check email inbox and triage messages.',
      skillInstructions: EMAIL_SKILL_INSTRUCTIONS,
      scheduleCron,
      lastRun: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastSkipped: null,
      lastSkipReason: null,
      userMd: 'Software engineer at a startup.',
      recentHistory: [
        { role: 'user', content: "David Chen said he'd send over the signed contract today. It's the Acme deal — really important we don't miss it. Can you keep an eye out?", createdAt: new Date(Date.now() - 45 * 60_000).toISOString() },
        { role: 'assistant', content: "I'll watch for it. David Chen, Acme contract — I'll make sure to flag it when it comes through.", createdAt: new Date(Date.now() - 44 * 60_000).toISOString() },
        { role: 'user', content: "Thanks. Also, what's on my calendar this afternoon?", createdAt: new Date(Date.now() - 30 * 60_000).toISOString() },
        { role: 'assistant', content: 'You have a design review at 2pm and a 1:1 with your manager at 4pm.', createdAt: new Date(Date.now() - 29 * 60_000).toISOString() },
      ],
      ambientContext: '',
      currentTime: new Date().toISOString(),
    }, router, env.config.stewardModel)

    console.log(`[proactive-context] Specific: action=${decision1.action}, context=${decision1.context ?? '(none)'}`)

    // ── Sub-scenario 2: mundane conversation ──────────────────────────────────
    console.log('[proactive-context] Sub-scenario 2: mundane conversation...')

    const decision2 = await runProactiveDecision({
      skillName: 'email-triage',
      skillDescription: 'Check email inbox and triage messages.',
      skillInstructions: EMAIL_SKILL_INSTRUCTIONS,
      scheduleCron,
      lastRun: new Date(Date.now() - 60 * 60_000).toISOString(),
      lastSkipped: null,
      lastSkipReason: null,
      userMd: 'Software engineer at a startup.',
      recentHistory: [
        { role: 'user', content: "What's the weather like today?", createdAt: new Date(Date.now() - 20 * 60_000).toISOString() },
        { role: 'assistant', content: "It's 72°F and sunny. Great day to be outside!", createdAt: new Date(Date.now() - 19 * 60_000).toISOString() },
        { role: 'user', content: 'Nice. Remind me to water the plants later.', createdAt: new Date(Date.now() - 10 * 60_000).toISOString() },
        { role: 'assistant', content: "I'll remind you this evening to water the plants.", createdAt: new Date(Date.now() - 9 * 60_000).toISOString() },
      ],
      ambientContext: '',
      currentTime: new Date().toISOString(),
    }, router, env.config.stewardModel)

    console.log(`[proactive-context] Mundane: action=${decision2.action}, context=${decision2.context ?? '(none)'}`)

    // ── Results ────────────────────────────────────────────────────────────────
    const output = {
      specific: { action: decision1.action, reason: decision1.reason, context: decision1.context ?? null },
      mundane: { action: decision2.action, reason: decision2.reason, context: decision2.context ?? null },
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[SUB-SCENARIO 1: User expecting contract from David Chen — email-triage fires]' },
      { role: 'assistant', content: `action: ${decision1.action}, context: ${decision1.context ?? '(none)'}` },
      { role: 'user', content: '[SUB-SCENARIO 2: Mundane weather/plants conversation — email-triage fires]' },
      { role: 'assistant', content: `action: ${decision2.action}, context: ${decision2.context ?? '(none)'}` },
    ]

    if (opts.noJudge) {
      console.log('\n[proactive-context] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log('[proactive-context] Running judge...')
    const context = `
The proactive decision was tested for context passthrough in two scenarios.

Sub-scenario 1 — User expecting important email from David Chen (Acme contract):
  Action: ${decision1.action}
  Reason: ${decision1.reason}
  Context passed to skill agent: "${decision1.context ?? '(none)'}"
  Expected: context should mention David Chen, Acme, contract, or the expected email

Sub-scenario 2 — Mundane conversation about weather and watering plants:
  Action: ${decision2.action}
  Reason: ${decision2.reason}
  Context passed to skill agent: "${decision2.context ?? '(none)'}"
  Expected: context should be absent, empty, or generic — nothing email-relevant in the conversation
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('proactive-context', history, output, judgment, { runId: opts.runId, category })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Proactive-context eval results ──────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
