/**
 * Scenario 14 — Correction Handling
 *
 * User says meeting is Tuesday, then corrects to Wednesday.
 * The full conversation is archived out of the live context window before querying.
 * Query: "when is my meeting?"
 *
 * Pass criteria: Head recalls Wednesday (corrected value) via recall_memory.
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

export const name = 'correction-handling'
export const description = 'User corrects meeting day from Tuesday to Wednesday — Head must recall corrected value'
export const category = 'identity'
export const estimatedCostUsd = 0.12
export const rubric = [
  'corrected_value_recalled — Does the response mention the corrected meeting day from the fixture conversation (the day the user corrected TO, not the original wrong day)?',
  'original_value_not_asserted — Does the response avoid asserting the original wrong day as the meeting day?',
  'confidence_appropriate — Does the response convey appropriate certainty without fabricating details?',
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
    console.log('[correction-handling] Generating conversation (~20 turns)…')
    history = await generateHistoryCached(
      llm,
      'correction-handling',
      `A conversation with the assistant Shrok. Early on, the user mentions a team meeting scheduled for Tuesday. Later in the same conversation, the user corrects themselves: "Actually, I got that wrong — the meeting is Wednesday, not Tuesday." The conversation also covers some unrelated topics (work tasks, maybe a question about weather or a recipe) to ensure archival happens.`,
      20,
    )
  }

  // ── Seed messages and archive until gone ──────────────────────────────────
  // The correction (Tuesday → Wednesday) must be in topic memory, not context,
  // for recall_memory to be genuinely required.
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    feedConversation(env.bundle, history)

    // Add filler to create context pressure for archival
    const filler1 = await generateHistoryCached(llm, 'correction-handling-filler-a',
      'conversation about planning a weekend camping trip — campsite options, gear to bring, and meals to cook', 60)
    const filler2 = await generateHistoryCached(llm, 'correction-handling-filler-b',
      'conversation about learning guitar — chords to practice, songs to learn, and a practice schedule', 60)
    feedConversation(env.bundle, filler1)
    feedConversation(env.bundle, filler2)
    console.log(`[correction-handling] Fed ${history.length} messages + ${filler1.length + filler2.length} filler into store.`)

    // Warm-up: trigger archival so the correction moves to topic memory
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[correction-handling] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[correction-handling]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Query the Head ─────────────────────────────────────────────────────
    console.log('[correction-handling] Querying Head…')
    const { response, traceFiles } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: 'Quick reminder — when is my meeting?',
    })

    console.log(`[correction-handling] Response: ${response.slice(0, 200)}…`)

    if (opts.noJudge) {
      console.log('\n[correction-handling] OUTPUT:\n', response)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log('[correction-handling] Running judge…')

    const context = `
SCENARIO: User mentioned meeting on Tuesday, then corrected to Wednesday.
The Head should know the corrected day is Wednesday.

CONVERSATION HISTORY:
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

QUERY: "Quick reminder — when is my meeting?"

HEAD RESPONSE:
${response}

`

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('correction-handling', history, response, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Correction-handling eval results ────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
