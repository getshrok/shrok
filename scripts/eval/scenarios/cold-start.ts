/**
 * Scenario 26 — Cold Start / Broad Recall
 *
 * Five separate sessions archived out of the live context window. Query: 'what have we been working on lately?'
 *
 * Pass criteria: Head surfaces content from multiple sessions. Breadth is key.
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

export const name = 'cold-start'
export const description = '5 separate sessions across diverse topics — Head must surface breadth of recent activity'
export const category = 'memory'
export const estimatedCostUsd = 0.25
export const rubric = [
  'topics_surfaced — does the response surface at least some of the archived topics? Score 1.0 if 3+, 0.7 if 2, 0.5 if 1, 0.0 if none. Note: memory budget may limit how many topics can be retrieved — surfacing 2-3 of 5 is acceptable.',
  'details_accurate — are the details in the surfaced topics accurate (correct names, dates, specifics from the original sessions)? Score 1.0 if accurate, 0.5 if partially, 0.0 if fabricated.',
  'no_hallucination — does the response avoid inventing topics or details not present in any of the archived sessions? Score 1.0 if clean, 0.5 if minor, 0.0 if a fabricated topic is presented as real.',
  'coherent_overview — does the response read as a natural, well-organized overview? Score 1.0 if natural, 0.5 if awkward, 0.0 if fragmented.',
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate sessions ──────────────────────────────────────────────────────
  const sessionSeeds = [
    {
      key: 'work',
      seed: 'Work feature discussion: building a push notification system for a mobile app. Technical decisions: FCM for Android, APNs for iOS, notification preferences stored per-user, a retry queue for failed deliveries.',
      turns: 12,
    },
    {
      key: 'health',
      seed: 'Health conversation: the user has a right shoulder injury, seeing a physiotherapist named Dr. Park. Exercises prescribed: external rotation with resistance band (3 sets of 15), pendulum swings, doorway stretch. Pain is a 3/10 at rest, 6/10 with overhead movements.',
      turns: 10,
    },
    {
      key: 'learning',
      seed: 'Language learning: the user is learning Spanish. Their teacher is named Elena. Currently on lesson 12 covering past tense (pretérito indefinido). Struggling with irregular verbs. Next lesson is Tuesday.',
      turns: 10,
    },
    {
      key: 'home',
      seed: 'Home project: planning a bathroom remodel. Decided on a wet room style with a frameless glass shower. Budget is $15,000. Contractor named Mike gave a quote. Planning to start in April.',
      turns: 10,
    },
    {
      key: 'side-project',
      seed: 'Side project: building a Python finance tracker to monitor personal spending. Using Pandas for data processing, Plaid API for bank connection, and plotting with Matplotlib. The user just got the Plaid API connected and is parsing transaction data.',
      turns: 12,
    },
  ]

  let sessions: EvalMessage[][]

  if (opts.replayHistory) {
    const chunkSize = Math.floor(opts.replayHistory.length / 5)
    sessions = Array.from({ length: 5 }, (_, i) =>
      opts.replayHistory!.slice(i * chunkSize, i === 4 ? undefined : (i + 1) * chunkSize)
    )
  } else {
    sessions = []
    for (const { key, seed, turns } of sessionSeeds) {
      console.log(`[cold-start] Generating ${key} session (~${turns} turns)…`)
      const session = await generateHistoryCached(llm, `cold-start-${key}`, seed, turns)
      sessions.push(session)
    }
  }

  const allHistory = sessions.flat()

  // ── Populate and compact all sessions ─────────────────────────────────────

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 80_000)

    // Insert sessions with time gaps between them (simulating separate conversations)
    for (let s = 0; s < sessions.length; s++) {
      const baseTime = Date.now() - (sessions.length - s) * 3_600_000
      feedConversation(env.bundle, sessions[s]!, baseTime)
    }

    // Add filler to push past archival threshold
    const filler = await generateHistoryCached(llm, 'cold-start-filler',
      'conversation about planning a birthday party — venue ideas, food options, guest list, and decorations', 60)
    feedConversation(env.bundle, filler)
    console.log(`[cold-start] Fed ${allHistory.length} messages + ${filler.length} filler across ${sessions.length} sessions into store.`)

    // Warm-up: archive sessions into topic memory
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[cold-start] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[cold-start]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Query the Head ─────────────────────────────────────────────────────
    console.log('[cold-start] Querying Head…')
    const { response, traceFiles } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "What have we been working on lately? Give me a quick overview.",
    })

    console.log(`[cold-start] Response: ${response.slice(0, 400)}…`)

    if (opts.noJudge) {
      console.log('\n[cold-start] OUTPUT:\n', response)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log('[cold-start] Running judge…')

    const lc = response.toLowerCase()
    const topicsDetected = {
      work: lc.includes('push notification') || lc.includes('notification') || lc.includes('mobile'),
      health: lc.includes('shoulder') || lc.includes('physio') || lc.includes('dr. park') || lc.includes('exercise'),
      learning: lc.includes('spanish') || lc.includes('elena') || lc.includes('lesson'),
      home: lc.includes('bathroom') || lc.includes('remodel') || lc.includes('shower') || lc.includes('mike'),
      sidProject: lc.includes('python') || lc.includes('finance') || lc.includes('plaid') || lc.includes('pandas'),
    }
    const topicsCovered = Object.values(topicsDetected).filter(Boolean).length
    console.log(`[cold-start] Topics covered: ${topicsCovered}/5`, topicsDetected)

    const context = `
SCENARIO: Five separate sessions across diverse topics were archived into memory, along with additional filler conversation. Memory retrieval has a limited token budget, so the system may not be able to retrieve all 5 topics at once. Surfacing 2-3 topics with accurate details is acceptable.

THE 5 SEEDED TOPICS (any of these are valid to surface):
1. Work: push notification system (FCM/APNs, per-user preferences, retry queue)
2. Health: right shoulder physio with Dr. Park, exercises prescribed
3. Learning: Spanish with teacher Elena, past tense, lesson 12
4. Home: bathroom remodel, wet room, Mike the contractor, $15k budget
5. Side project: Python finance tracker with Plaid API and Pandas

Note: Additional filler conversation was also archived (e.g. birthday party planning). If the response mentions filler topics, that is NOT hallucination — it is legitimately archived content.

QUERY: "What have we been working on lately? Give me a quick overview."

HEAD RESPONSE:
${response}

TOPICS FROM SEEDED SESSIONS DETECTED IN RESPONSE:
- Work/notifications: ${topicsDetected.work}
- Health/physio: ${topicsDetected.health}
- Learning/Spanish: ${topicsDetected.learning}
- Home/bathroom: ${topicsDetected.home}
- Side project/Python: ${topicsDetected.sidProject}
TOTAL: ${topicsCovered}/5 topics covered
`

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('cold-start', allHistory, response, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Cold-start eval results ─────────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
