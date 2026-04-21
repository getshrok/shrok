/**
 * Scenario — Recency Bias
 *
 * Project Kestrel facts planted in three distinct archival epochs (early / middle / late)
 * with 120 filler messages between each to ensure separate archival batches.
 * Three targeted queries test whether recall accuracy degrades for earlier-buried content.
 *
 * Pass criteria: All three epochs recalled with comparable specificity. Early epoch facts
 * (Tomás Vega, €118K, Frankfurt) must survive the deepest burial.
 */

import * as path from 'node:path'
import {
  generateHistoryCached,
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadQuery,
  feedConversation,
  LEAN_EVAL_CONFIG,
  type EvalMessage,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'recency-bias'
export const description = 'Project Kestrel facts spread across 3 archival epochs (120 filler between each) — early facts must survive deepest burial'
export const category = 'memory'
export const estimatedCostUsd = 0.40
export const rubric = [
  'early_facts_recalled — Does Q1 response include specific facts from the early epoch conversation (check the EARLY EPOCH CONVERSATION provided)? Score based on how many key details are accurately recalled.',
  'middle_facts_recalled — Does Q2 response include specific facts from the middle epoch conversation (check the MIDDLE EPOCH CONVERSATION provided)? Score based on accuracy and completeness.',
  'late_facts_recalled — Does Q3 response include specific facts from the late epoch conversation (check the LATE EPOCH CONVERSATION provided)? Score based on accuracy and completeness.',
  'early_vs_late_parity — Is the early-epoch answer as specific and confident as the late-epoch answer, or is there notable degradation in detail or accuracy for the oldest content?',
]

const EARLY_SEED = `A product roadmap planning conversation for "Project Kestrel," an internal SaaS platform.
This is an early-stage session — the project has just been greenlit. Key facts established:
- Lead engineer: Tomás Vega (he/him), based in Berlin
- Infrastructure budget: €118,000 (specifically Euros, not dollars)
- Target deployment region: Frankfurt, AWS eu-central-1
- Tech stack: Django (backend), Celery (task queue), PostgreSQL 15 (database)
- The conversation should feel like early planning: lots of discussion about choices, some
  uncertainty, Tomás asking clarifying questions about the budget ceiling.
Do NOT mention any beta customers, CDN choices, or launch dates — those come later.`

const MIDDLE_SEED = `A milestone review conversation for Project Kestrel, a SaaS platform now in beta.
This is a progress update session. Key new facts (do NOT repeat the budget or stack):
- Tomás Vega's team delivered the core API 12 days ahead of schedule (celebrated this)
- First beta customer onboarded: "Matterway GmbH" — a logistics company based in Hamburg
- Scope expansion: a real-time dashboard feature has been added to the project
- New timeline: beta closes June 14th, 2026 (was originally June 28th, moved up)
- The conversation is upbeat but mentions some challenges with the dashboard feature's
  complexity and a concern about load testing results.
Do NOT mention any CDN choice or final launch date.`

const LATE_SEED = `A launch preparation conversation for Project Kestrel. The team is finalizing
production infrastructure. Key facts (do NOT repeat budget, stack, or beta customer details):
- Production database: 3 RDS instances — 1 primary, 2 read replicas (Multi-AZ)
- CDN provider chosen: Cloudflare (over Fastly and AWS CloudFront — price was the tiebreaker)
- Monitoring stack: Datadog APM with 15-day log retention
- Launch date confirmed: September 8th, 2026 (Monday morning, 09:00 CEST)
- Discussion includes runbook preparation, go-live checklist, and a decision to do a
  soft launch (internal users only) the week before to catch last-minute issues.`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate three epochs ──────────────────────────────────────────────────
  let earlyHistory: EvalMessage[]
  let middleHistory: EvalMessage[]
  let lateHistory: EvalMessage[]

  if (opts.replayHistory) {
    const third = Math.floor(opts.replayHistory.length / 3)
    earlyHistory = opts.replayHistory.slice(0, third)
    middleHistory = opts.replayHistory.slice(third, third * 2)
    lateHistory = opts.replayHistory.slice(third * 2)
  } else {
    console.log('[recency-bias] Generating early epoch (16 turns)…')
    earlyHistory = await generateHistoryCached(llm, 'recency-bias-early', EARLY_SEED, 16)
    console.log('[recency-bias] Generating middle epoch (16 turns)…')
    middleHistory = await generateHistoryCached(llm, 'recency-bias-middle', MIDDLE_SEED, 16)
    console.log('[recency-bias] Generating late epoch (16 turns)…')
    lateHistory = await generateHistoryCached(llm, 'recency-bias-late', LATE_SEED, 16)
  }

  const allHistory = [...earlyHistory, ...middleHistory, ...lateHistory]

  // ── Seed epochs with heavy filler between to ensure separate archival passes ─
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    const baseTime = Date.now() - 90 * 24 * 3_600_000 // 90 days ago

    // Epoch 1: early (deepest)
    feedConversation(env.bundle, earlyHistory, baseTime)
    console.log(`[recency-bias] Fed early epoch: ${earlyHistory.length} messages.`)

    // Epoch 2: middle
    const middleBase = baseTime + earlyHistory.length * 60_000 + 24 * 3_600_000
    feedConversation(env.bundle, middleHistory, middleBase)
    console.log(`[recency-bias] Fed middle epoch: ${middleHistory.length} messages.`)

    // Epoch 3: late (most recent)
    const lateBase = middleBase + middleHistory.length * 60_000 + 24 * 3_600_000
    feedConversation(env.bundle, lateHistory, lateBase)
    console.log(`[recency-bias] Fed late epoch: ${lateHistory.length} messages.`)

    // Add filler to push past archival threshold
    const filler = await generateHistoryCached(llm, 'recency-bias-filler',
      'conversation about planning a road trip — route ideas, places to stop, and packing', 60)
    feedConversation(env.bundle, filler)
    console.log(`[recency-bias] Fed ${filler.length} filler messages for context pressure.`)

    // Warm-up: archive all epochs into topic memory
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[recency-bias] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[recency-bias]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Three targeted queries ─────────────────────────────────────────────────
    console.log('[recency-bias] Q1 (early epoch facts)…')
    const { response: r1, traceFiles: tf1 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "For Project Kestrel — who's the lead engineer, what's the infrastructure budget, and what AWS region are we deploying to?",
    })
    console.log(`[recency-bias] R1: ${r1.slice(0, 150)}…`)

    console.log('[recency-bias] Q2 (middle epoch facts)…')
    const { response: r2, traceFiles: tf2 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: 'What was the beta closing date for Project Kestrel, and who was the first beta customer?',
    })
    console.log(`[recency-bias] R2: ${r2.slice(0, 150)}…`)

    console.log('[recency-bias] Q3 (late epoch facts)…')
    const { response: r3, traceFiles: tf3 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: 'What CDN did we pick for Kestrel, and when does it launch?',
    })
    console.log(`[recency-bias] R3: ${r3.slice(0, 150)}…`)
    const allTraceFiles = { ...tf1, ...tf2, ...tf3 }

    if (opts.noJudge) {
      console.log('\n[recency-bias] Q1 OUTPUT:\n', r1)
      console.log('\n[recency-bias] Q2 OUTPUT:\n', r2)
      console.log('\n[recency-bias] Q3 OUTPUT:\n', r3)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────────
    console.log('[recency-bias] Running judge…')

    const l1 = r1.toLowerCase()
    const l2 = r2.toLowerCase()
    const l3 = r3.toLowerCase()

    const context = `
SCENARIO: Recency bias test for Project Kestrel. Three epochs of conversation were archived.
The judge must compare responses against the ACTUAL CONVERSATION CONTENT below — not against any seed or expected values.

EARLY EPOCH CONVERSATION (${earlyHistory.length} turns — deepest burial):
${earlyHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

MIDDLE EPOCH CONVERSATION (${middleHistory.length} turns):
${middleHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

LATE EPOCH CONVERSATION (${lateHistory.length} turns — most recent):
${lateHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

QUERY 1 (targets early epoch): Lead engineer? Budget? AWS region?
RESPONSE 1:
${r1}
MENTIONS TOMÁS VEGA: ${l1.includes('tomás') || l1.includes('tomas') || l1.includes('vega')}
MENTIONS €118K or 118,000: ${l1.includes('118') || l1.includes('118,000')}
MENTIONS FRANKFURT or eu-central-1: ${l1.includes('frankfurt') || l1.includes('eu-central-1')}

QUERY 2 (targets middle epoch): Beta close date? First beta customer?
RESPONSE 2:
${r2}
MENTIONS JUNE 14: ${l2.includes('june 14') || l2.includes('14th')}
MENTIONS MATTERWAY: ${l2.includes('matterway')}

QUERY 3 (targets late epoch): CDN choice? Launch date?
RESPONSE 3:
${r3}
MENTIONS CLOUDFLARE: ${l3.includes('cloudflare')}
MENTIONS SEPTEMBER 8: ${l3.includes('september 8') || l3.includes('sep 8') || l3.includes('sept 8')}
`

    const judgment = await judge(rubric, context)

    const output = {
      turns: [
        { query: "For Project Kestrel — who's the lead engineer, what's the infrastructure budget, and what AWS region are we deploying to?", response: r1 },
        { query: 'What was the beta closing date for Project Kestrel, and who was the first beta customer?', response: r2 },
        { query: 'What CDN did we pick for Kestrel, and when does it launch?', response: r3 },
      ],
    }
    const txtPath = await writeResults('recency-bias', allHistory, output, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Recency-bias eval results ────────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
