/**
 * Scenario — Negation Preservation
 *
 * Four explicit technical rejections are archived: no MongoDB, no Memcached,
 * not the platform team, not Q1. Queries probe each negation.
 *
 * Pass criteria: Each negation is correctly recalled and applied — not softened
 * into uncertainty or flipped. Keyword-matching retrieval would answer wrong.
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

export const name = 'negation-preservation'
export const description = 'Four archived explicit rejections (no MongoDB, no Memcached, not platform team, not Q1) — negations must survive archival intact'
export const category = 'memory'
export const estimatedCostUsd = 0.20
export const rubric = [
  'database_negation_preserved — Does Q1 response correctly state which database was rejected and which was chosen, matching the fixture conversation?',
  'cache_negation_preserved — Does Q2 response correctly identify which caching layer was chosen and which was rejected, matching the fixture conversation?',
  'team_ownership_correct — Does Q3 response correctly assign team ownership as decided in the fixture conversation (not the rejected alternative)?',
  'timeline_negation_preserved — Does Q4 response correctly state which launch timeline was ruled out and what was decided instead, matching the fixture conversation?',
  'negations_not_hedged_away — Do responses give confident, definitive answers rather than vague hedging?',
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate history ───────────────────────────────────────────────────────
  let history: EvalMessage[]

  if (opts.replayHistory) {
    history = opts.replayHistory
  } else {
    console.log('[negation-preservation] Generating decision session (~26 turns)…')
    history = await generateHistoryCached(
      llm,
      'negation-preservation-decisions',
      `A technical decision-making conversation for a new internal microservice (an audit logging
service). The user and assistant work through four key decisions, and each decision involves
an explicit, motivated rejection of one option:

1. DATABASE: The user considers MongoDB but explicitly rejects it — "We're NOT using MongoDB.
   The document model doesn't fit — we need strong relational consistency for audit chains.
   We're going with CockroachDB." Include a reason (audit log immutability, ACID guarantees).
   The conversation should spend time on this before the decision is made.

2. CACHE: The team evaluated Memcached. User says: "We looked at Memcached but we're NOT
   using it. Redis only — we need pub/sub for real-time audit event streaming to the dashboard."
   Include prior discussion about why Memcached was even considered (simplicity, ops overhead).

3. TEAM OWNERSHIP: Someone suggests the platform team could own this service. User shuts it
   down: "No — this service is NOT under the platform team. Audit logging is a product concern.
   It belongs to product engineering, specifically the growth squad under Naledi's org."
   Include realistic discussion about team boundaries and why this matters.

4. LAUNCH TIMELINE: Someone floats a Q1 launch. User is firm: "We are absolutely not launching
   in Q1. The compliance review isn't done and legal hasn't signed off on the retention policies.
   Q3 at the earliest — probably late Q3." Include discussion of what the compliance review
   involves and why it's blocking.

After each decision, the conversation continues naturally with implementation details,
follow-up questions, and planning. The decisions should feel final and motivated, not casual.
The service name is "AuditCore."`,
      26,
    )
  }

  // ── Seed and archive ───────────────────────────────────────────────────────
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    feedConversation(env.bundle, history)

    const filler1 = await generateHistoryCached(llm, 'negation-preservation-filler-a',
      'conversation about setting up a home office — monitor options, chair recommendations, and desk layout ideas', 60)
    const filler2 = await generateHistoryCached(llm, 'negation-preservation-filler-b',
      'conversation about training for a 10K run — weekly running plans, shoe choices, and race day prep', 60)
    feedConversation(env.bundle, filler1)
    feedConversation(env.bundle, filler2)
    console.log(`[negation-preservation] Fed ${history.length} messages + ${filler1.length + filler2.length} filler into store.`)

    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[negation-preservation] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[negation-preservation]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Four queries probing each negation ────────────────────────────────────
    const QUERIES = [
      'Are we using MongoDB for AuditCore?',
      'Which caching layer did we settle on for AuditCore — Memcached or Redis?',
      'Which team owns AuditCore?',
      'Is there any chance AuditCore launches in Q1?',
    ]

    const responses: string[] = []
    const allTraceFiles: Record<string, string> = {}
    for (const query of QUERIES) {
      console.log(`[negation-preservation] Querying: "${query}"`)
      const { response, traceFiles } = await runHeadQuery({
        bundle: env.bundle,
        topicMemory: memory,
        router,
        config: env.config,
        identityDir: env.identityDir,
        workspaceDir: env.workspaceDir,
        query,
      })
      Object.assign(allTraceFiles, traceFiles)
      responses.push(response)
      console.log(`[negation-preservation] Response: ${response.slice(0, 150)}…`)
    }

    const [r1, r2, r3, r4] = responses as [string, string, string, string]

    if (opts.noJudge) {
      for (let i = 0; i < QUERIES.length; i++) {
        console.log(`\n[negation-preservation] Q${i + 1}: ${QUERIES[i]}\nOUTPUT: ${responses[i]}`)
      }
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────────
    console.log('[negation-preservation] Running judge…')

    const lc1 = r1.toLowerCase()
    const lc2 = r2.toLowerCase()
    const lc3 = r3.toLowerCase()
    const lc4 = r4.toLowerCase()

    const context = `
SCENARIO: Negation preservation test for the AuditCore microservice.

FOUR DECISIONS FROM THE ARCHIVED CONVERSATION (each with an explicit NOT):
1. Database: NOT MongoDB → CockroachDB (relational consistency needed)
2. Cache: NOT Memcached → Redis (pub/sub required)
3. Team: NOT platform team → product engineering / growth squad (under Naledi)
4. Timeline: NOT Q1 → Q3 at earliest (compliance review blocking)

A system that does keyword retrieval without preserving polarity would answer these exactly wrong.

ARCHIVED CONVERSATION (${history.length} turns):
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

QUERY 1: "Are we using MongoDB for AuditCore?"
RESPONSE 1: ${r1}
MENTIONS COCKROACHDB: ${lc1.includes('cockroach')}
AFFIRMS MONGODB: ${lc1.includes('yes') && lc1.includes('mongodb')}

QUERY 2: "Which caching layer — Memcached or Redis?"
RESPONSE 2: ${r2}
MENTIONS REDIS: ${lc2.includes('redis')}
AFFIRMS MEMCACHED: ${lc2.includes('memcached') && !lc2.includes('not') && !lc2.includes("isn't")}

QUERY 3: "Which team owns AuditCore?"
RESPONSE 3: ${r3}
MENTIONS PRODUCT/GROWTH: ${lc3.includes('product') || lc3.includes('growth') || lc3.includes('naledi')}
ASSIGNS TO PLATFORM: ${lc3.includes('platform') && !lc3.includes('not') && !lc3.includes("isn't")}

QUERY 4: "Any chance of Q1 launch?"
RESPONSE 4: ${r4}
REJECTS Q1: ${lc4.includes('q1') && (lc4.includes('not') || lc4.includes("won't") || lc4.includes("no"))}
AFFIRMS Q1: ${lc4.includes('q1') && (lc4.includes('yes') || lc4.includes('possible') || lc4.includes('could'))}
`

    const judgment = await judge(rubric, context)

    const output = {
      turns: QUERIES.map((query, i) => ({ query, response: responses[i]! })),
    }
    const txtPath = await writeResults('negation-preservation', history, output, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Negation-preservation eval results ──────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
