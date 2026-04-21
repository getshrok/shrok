/**
 * Scenario — Revision Tracking
 *
 * Project Meridian's budget is revised four times in one conversation ($40K → $58K → $73K → $91.5K).
 * After archival, two queries test whether both the original AND final values are retrievable,
 * and whether the system recognizes that revisions occurred.
 *
 * Pass criteria: Final value ($91,500) recalled correctly; original value ($40,000) recalled
 * correctly; system acknowledges the budget changed over time.
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

export const name = 'revision-tracking'
export const description = 'Project Meridian budget revised 4 times ($40K→$91.5K) — Head must recall both original and final values after archival'
export const category = 'memory'
export const estimatedCostUsd = 0.22
export const rubric = [
  'final_budget_recalled — Q1 response states $91,500 (or $91.5K) as the approved figure?',
  'original_budget_recalled — Q2 response states $40,000 (or $40K) as the starting figure?',
  'revision_history_awareness — Q3 response walks through all four budget figures ($40K, $58K, $73K, $91.5K) in order?',
  'no_version_collapse — responses do not conflate intermediate versions ($58K or $73K) with the original or final?',
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
    console.log('[revision-tracking] Generating budget planning session (~30 turns)…')
    history = await generateHistoryCached(
      llm,
      'revision-tracking-budget',
      `A budget planning conversation for a data platform migration project called "Project Meridian."
The project lead is Valentina Cruz.

HARD CONSTRAINT — NO RECAP: The user must NEVER ask for a summary of budget figures,
and the assistant must NEVER produce a numbered list or enumeration of all four budget
values together. Each revision is stated once when it happens and then the conversation
moves on. Violating this constraint defeats the purpose of the test.

The budget is revised exactly four times. Each revision must be stated as it naturally
arises in discussion:

REVISION 1 (around turn 4): Initial estimate stated as $40,000 (internal resources only).
REVISION 2 (around turn 10): ETL rebuild scope added, new total $58,000.
REVISION 3 (around turn 17): Kafka licensing quote comes in, pushes to $73,000.
REVISION 4 (around turn 25): Post-launch support contract approved, finalizes at $91,500.
Valentina Cruz signs off on this number.

After the final revision, the conversation continues with technical and project topics:
architecture decisions, team scheduling, risk management, timeline concerns — nothing
that prompts or produces a budget summary. The last several turns must be about something
other than the budget history.

The four dollar amounts ($40K, $58K, $73K, $91.5K) appear naturally mid-conversation,
each mentioned once when the change happens.`,
      30,
    )
  }

  // ── Seed and archive ───────────────────────────────────────────────────────
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    feedConversation(env.bundle, history)

    const filler1 = await generateHistoryCached(llm, 'revision-tracking-filler-a',
      'conversation about planning a vacation — destination ideas, packing, and what to do there', 60)
    const filler2 = await generateHistoryCached(llm, 'revision-tracking-filler-b',
      'conversation about a kitchen remodel — layout ideas, material preferences, and timeline', 60)
    feedConversation(env.bundle, filler1)
    feedConversation(env.bundle, filler2)
    console.log(`[revision-tracking] Fed ${history.length} messages + ${filler1.length + filler2.length} filler into store.`)

    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[revision-tracking] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[revision-tracking]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Two queries — final then original ─────────────────────────────────────
    console.log('[revision-tracking] Querying for final budget…')
    const { response: finalResponse, traceFiles: tf1 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "What's the current approved budget for Project Meridian?",
    })
    console.log(`[revision-tracking] Final budget response: ${finalResponse.slice(0, 200)}…`)

    console.log('[revision-tracking] Querying for original budget…')
    const { response: originalResponse, traceFiles: tf2 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: 'What was the original budget number for Project Meridian before we started revising it?',
    })
    console.log(`[revision-tracking] Original budget response: ${originalResponse.slice(0, 200)}…`)

    console.log('[revision-tracking] Querying for revision history…')
    const { response: historyResponse, traceFiles: tf3 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: 'Walk me through how the Project Meridian budget changed over time.',
    })
    console.log(`[revision-tracking] History response: ${historyResponse.slice(0, 200)}…`)
    const allTraceFiles = { ...tf1, ...tf2, ...tf3 }

    if (opts.noJudge) {
      console.log('\n[revision-tracking] FINAL OUTPUT:\n', finalResponse)
      console.log('\n[revision-tracking] ORIGINAL OUTPUT:\n', originalResponse)
      console.log('\n[revision-tracking] HISTORY OUTPUT:\n', historyResponse)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────────
    console.log('[revision-tracking] Running judge…')

    const context = `
SCENARIO: Revision tracking test for Project Meridian budget.

GROUND TRUTH — four explicit budget revisions in archived conversation:
1. Starting budget: $40,000 (initial estimate)
2. After ETL scope addition: $58,000
3. After Kafka licensing: $73,000
4. Final approved (with support contract, signed off by Valentina Cruz): $91,500

The memory layer must preserve the full revision chain, not just the latest value.

ARCHIVED CONVERSATION (${history.length} turns):
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

QUERY 1: "What's the current approved budget for Project Meridian?"
FINAL BUDGET RESPONSE:
${finalResponse}

QUERY 2: "What was the original budget before revisions?"
ORIGINAL BUDGET RESPONSE:
${originalResponse}

QUERY 3: "Walk me through how the Project Meridian budget changed over time."
HISTORY RESPONSE:
${historyResponse}
`

    const judgment = await judge(rubric, context)

    const output = {
      turns: [
        { query: "What's the current approved budget for Project Meridian?", response: finalResponse },
        { query: 'What was the original budget number for Project Meridian before we started revising it?', response: originalResponse },
        { query: 'Walk me through how the Project Meridian budget changed over time.', response: historyResponse },
      ],
    }
    const txtPath = await writeResults('revision-tracking', history, output, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Revision-tracking eval results ──────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
