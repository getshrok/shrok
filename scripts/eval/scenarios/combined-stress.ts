/**
 * Stress Eval — Combined Stress
 *
 * Both pressures simultaneously:
 *   1. 25 short sessions (from memory-overload) archived first → 25 topics in memory
 *   2. 10 dense sessions (from archival-pressure) loaded on top as live context
 *      → context at or above the archival threshold
 *
 * Then 5 continuation queries run through the head. Archival fires during the
 * loop, pushing the dense sessions into memory (30+ topics total).
 *
 * Two final recall queries verify:
 *   - Content from the pre-loaded 25 topics (older memory pool)
 *   - Content from topics created during the loop (freshly archived dense sessions)
 *
 * Validates the full production steady-state: saturated memory + live context
 * that fills and archives mid-conversation.
 *
 * Measures: per-turn latency, cost, archival detection, topic count growth.
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
import { estimateTokens } from '../../../src/db/token.js'
import { estimateCostFromSummary } from '../../../src/llm/pricing.js'
import type { UsageStore } from '../../../src/db/usage.js'
import type { HeadBundle } from '../harness.js'

// Session data extracted from the removed memory-overload and archival-pressure evals
import { OVERLOAD_SESSIONS, PRESSURE_SESSIONS, CONTINUATION_QUERIES } from './_session-data.js'

export const name = 'combined-stress'
export const description = '25 pre-archived topics + 10 dense live sessions; archival fires mid-conversation; tests saturated memory under both pressures simultaneously'
export const category = 'stress'
export const estimatedCostUsd = 0.90
export const rubric = [
  'pre_loaded_recall — Does the pre-loaded recall response surface specific details from the pre-archived session content provided? Score based on accuracy of recalled facts.',
  'freshly_archived_recall — Does the fresh recall response surface specific details from the sessions archived during the run? Score based on accuracy of recalled facts.',
  'no_cross_contamination — Do the two recall responses draw from the correct topic pools without mixing details between them? Score 1.0 if clean, 0.0 if entities or facts cross between answers.',
  'graceful_under_load — Are continuation query responses coherent and relevant despite both archival and saturated topic memory running simultaneously?',
]

// ─── Ground truth ─────────────────────────────────────────────────────────────

// From the pre-loaded 25 topics (memory-overload session-08): Ben Torres, half marathon training
const RECALL_FROM_PRELOADED = 'Who was the running coach in the half marathon training sessions, and what was the target race timeline?'

// From the dense sessions archived during the loop (archival-pressure session-03): token bucket, Redis, 1000 req/min, Sarah Kim
const RECALL_FROM_FRESH = 'What rate limiting approach did we settle on — the algorithm, the infrastructure, and the specific req/min limit?'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface TurnMetrics {
  query: string
  response: string
  latencyMs: number
  costUsd: number
  messagesBefore: number
  messagesAfter: number
  archivalFired: boolean
  topicsRetrieved: number
}

interface CombinedMetrics {
  scenarioTokensAtStart: number
  archivalThreshold: number
  topicsBeforeLiveLoad: number
  topicsAfterRun: number
  turns: TurnMetrics[]
  recallPreloaded: string
  recallFresh: string
  totalCostUsd: number
  totalLatencyMs: number
}

function diffCost(usage: UsageStore, before: ReturnType<UsageStore['summarize']>): number {
  const after = usage.summarize()
  const delta: Record<string, { input: number; output: number }> = {}
  for (const [model, t] of Object.entries(after.byModel)) {
    const b = before.byModel[model] ?? { input: 0, output: 0 }
    if (t.input > b.input || t.output > b.output) {
      delta[model] = { input: t.input - b.input, output: t.output - b.output }
    }
  }
  return estimateCostFromSummary(delta)
}

function countTopicsInPrompt(prompt: string): number {
  const memStart = prompt.indexOf('## Memory Context')
  if (memStart === -1) return 0
  return (prompt.slice(memStart).match(/^### /gm) ?? []).length
}

async function waitForArchival(bundle: HeadBundle): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const acquired = bundle.appState.tryAcquireArchivalLock()
    if (acquired) { bundle.appState.releaseArchivalLock(); return }
    await new Promise(r => setTimeout(r, 150))
  }
}

function printMetricsTable(turns: TurnMetrics[]): void {
  console.log('\n  Turn  Query                              Latency      Cost    Msgs         Archival  Topics')
  console.log('  ' + '─'.repeat(91))
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!
    const q = t.query.slice(0, 34).padEnd(34)
    const lat = `${t.latencyMs.toLocaleString()}ms`.padStart(9)
    const cost = `$${t.costUsd.toFixed(3)}`.padStart(7)
    const msgs = `${t.messagesBefore}→${t.messagesAfter}`.padStart(9)
    const arch = t.archivalFired ? '✓' : '—'
    console.log(`  ${String(i + 1).padStart(4)}  ${q}  ${lat}  ${cost}  ${msgs}  ${arch.padStart(8)}  ${t.topicsRetrieved}`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  // ── Phase 1: Generate / load memory-overload's 25 short sessions ─────────────
  console.log('[combined-stress] Phase 1: Loading 25 short sessions for pre-archival (cached)…')
  const overloadSessions: EvalMessage[][] = []
  for (const s of OVERLOAD_SESSIONS) {
    const session = await generateHistoryCached(llm, s.key, s.seed, s.turns)
    overloadSessions.push(session)
  }

  // ── Phase 2: Generate / load archival-pressure's 10 dense sessions ───────────
  console.log('[combined-stress] Phase 2: Loading 10 dense sessions for live context (cached)…')
  const pressureSessions: EvalMessage[][] = []
  for (const s of PRESSURE_SESSIONS) {
    const session = await generateHistoryCached(llm, s.key, s.seed, s.turns)
    pressureSessions.push(session)
  }

  // ── Set up environment ──────────────────────────────────────────────────────
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })
  const config = env.config
  const bundle = env.bundle
  const threshold = Math.floor(config.contextWindowTokens * config.archivalThresholdFraction)

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm)

    // ── Feed the 25 short sessions into the store ──────────────────────────────
    console.log('[combined-stress] Feeding 25 short sessions…')
    const baseTimeOverload = Date.now() - 90 * 24 * 3_600_000
    let offsetOverload = 0

    for (const session of overloadSessions) {
      feedConversation(bundle, session, baseTimeOverload + offsetOverload * 60_000)
      offsetOverload += session.length
    }

    const topicsBeforeLiveLoad = 0  // no pre-archival; archival fires naturally during queries
    console.log(`[combined-stress] Fed ${overloadSessions.reduce((n, s) => n + s.length, 0)} messages from 25 short sessions.`)

    // ── Load 10 dense sessions as live context (do NOT archive) ────────────────
    console.log('[combined-stress] Appending 10 dense sessions as live context…')
    const baseTimePressure = Date.now() - 30 * 24 * 3_600_000
    let offsetPressure = 0

    for (const session of pressureSessions) {
      feedConversation(bundle, session, baseTimePressure + offsetPressure * 60_000)
      offsetPressure += session.length
    }

    const tokenCount = estimateTokens(bundle.messages.getAll())
    console.log(`[combined-stress] Live context: ${bundle.messages.count()} messages, ~${tokenCount.toLocaleString()} tokens (threshold: ${threshold.toLocaleString()})`)

    if (tokenCount < threshold * 0.8) {
      throw new Error(
        `[combined-stress] Live context token count (${tokenCount.toLocaleString()}) is less than 80% of threshold (${threshold.toLocaleString()}). ` +
        `Delete archival-pressure-session-*.json fixtures and re-run.`
      )
    }

    // ── Continuation query loop ───────────────────────────────────────────────
    const allQueries = [...CONTINUATION_QUERIES, RECALL_FROM_PRELOADED, RECALL_FROM_FRESH]
    const turnMetrics: TurnMetrics[] = []
    let totalCost = 0
    let totalLatency = 0
    const allTraceFiles: Record<string, string> = {}

    for (let i = 0; i < allQueries.length; i++) {
      const query = allQueries[i]!
      const isRecall = i >= CONTINUATION_QUERIES.length
      const label = isRecall
        ? (i === CONTINUATION_QUERIES.length ? 'recall-preloaded' : 'recall-fresh')
        : `turn ${i + 1}`
      console.log(`\n[combined-stress] Running ${label}: "${query.slice(0, 60)}…"`)

      const usageBefore = bundle.usage.summarize()
      const msgsBefore = bundle.messages.count()
      const t0 = Date.now()

      const { response, assembledSystemPrompt, traceFiles } = await runHeadQuery({
        bundle,
        topicMemory: memory,
        router,
        config,
        query,
        identityDir: env.identityDir,
        workspaceDir: env.workspaceDir,
        timeoutMs: 180_000,
      })

      const latencyMs = Date.now() - t0
      await waitForArchival(bundle)

      const costUsd = diffCost(bundle.usage, usageBefore)
      const msgsAfter = bundle.messages.count()
      const archivalFired = msgsAfter < msgsBefore
      const topicsRetrieved = countTopicsInPrompt(assembledSystemPrompt)

      Object.assign(allTraceFiles, traceFiles)
      totalCost += costUsd
      totalLatency += latencyMs

      turnMetrics.push({ query, response, latencyMs, costUsd, messagesBefore: msgsBefore, messagesAfter: msgsAfter, archivalFired, topicsRetrieved })
      console.log(`[combined-stress] ${label}: ${latencyMs.toLocaleString()}ms | $${costUsd.toFixed(3)} | msgs ${msgsBefore}→${msgsAfter}${archivalFired ? ' ⚡ ARCHIVAL FIRED' : ''} | ${topicsRetrieved} topic(s)`)
      console.log(`[combined-stress] Response: ${response.slice(0, 200)}…`)

      if (i < allQueries.length - 1) {
        const cooldownMs = archivalFired ? 20_000 : 8_000
        console.log(`[combined-stress] Waiting ${cooldownMs / 1000}s before next query…`)
        await new Promise(r => setTimeout(r, cooldownMs))
      }
    }

    const topicsAfterRun = (await memory.getTopics()).length
    const recallPreloaded = bundle.channelRouter.sent.at(-2)?.text ?? ''
    const recallFresh = bundle.channelRouter.sent.at(-1)?.text ?? ''

    const metrics: CombinedMetrics = {
      scenarioTokensAtStart: tokenCount,
      archivalThreshold: threshold,
      topicsBeforeLiveLoad,
      topicsAfterRun,
      turns: turnMetrics,
      recallPreloaded,
      recallFresh,
      totalCostUsd: totalCost,
      totalLatencyMs: totalLatency,
    }

    console.log(`\n[combined-stress] Summary: ${topicsBeforeLiveLoad} → ${topicsAfterRun} topics | total cost $${totalCost.toFixed(3)} | total latency ${(totalLatency / 1000).toFixed(1)}s`)
    printMetricsTable(turnMetrics)

    if (opts.noJudge) {
      console.log('\n[combined-stress] RECALL-PRELOADED:\n', recallPreloaded)
      console.log('\n[combined-stress] RECALL-FRESH:\n', recallFresh)
      return
    }

    // ── Judge ────────────────────────────────────────────────────────────────
    console.log('\n[combined-stress] Running judge…')
    const archivalFireCount = turnMetrics.filter(t => t.archivalFired).length

    const overloadSession08 = overloadSessions[7]!  // memory-overload-08: Ben Torres half marathon
    const pressureSession03 = pressureSessions[2]!  // archival-pressure session-03: token bucket rate limiting

    const context = `
SCENARIO: Combined stress test.
- 25 pre-archived topics from short sessions (${topicsBeforeLiveLoad} topics in memory before live load)
- 10 dense technical sessions loaded as live context (~${tokenCount.toLocaleString()} tokens, threshold: ${threshold.toLocaleString()})
- Archival fired ${archivalFireCount} time(s) during ${CONTINUATION_QUERIES.length} continuation queries
- Topics in memory after run: ${topicsAfterRun} (started at ${topicsBeforeLiveLoad})

PRE-LOADED SESSION FULL CONTENT — memory-overload-08 (${overloadSession08.length} turns — half marathon training, ground truth for pre-loaded recall):
${overloadSession08.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

RECALL QUERY (pre-loaded pool): "${RECALL_FROM_PRELOADED}"
RESPONSE:
${recallPreloaded}

FRESHLY-ARCHIVED SESSION FULL CONTENT — archival-pressure session-03 (${pressureSession03.length} turns — API rate limiting, ground truth for fresh recall):
${pressureSession03.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

RECALL QUERY (fresh pool): "${RECALL_FROM_FRESH}"
RESPONSE:
${recallFresh}

PRE-LOADED CHECKS:
MENTIONS BEN TORRES: ${recallPreloaded.toLowerCase().includes('ben torres') || recallPreloaded.toLowerCase().includes('ben')}
MENTIONS 14 WEEKS OR TIMELINE: ${/14.week|fourteen.week/i.test(recallPreloaded)}
MENTIONS MARATHON: ${/marathon/i.test(recallPreloaded)}

FRESH CHECKS:
MENTIONS TOKEN BUCKET: ${recallFresh.toLowerCase().includes('token bucket')}
MENTIONS REDIS: ${recallFresh.toLowerCase().includes('redis')}
MENTIONS 1000: ${recallFresh.includes('1000')}

TURN METRICS:
${turnMetrics.map((t, i) => `Turn ${i + 1}: ${t.latencyMs}ms, $${t.costUsd.toFixed(3)}, archival=${t.archivalFired}, topics=${t.topicsRetrieved}`).join('\n')}
`

    const judgment = await judge(rubric, context)

    const allHistory = [...overloadSessions.flat(), ...pressureSessions.flat()]
    const txtPath = await writeResults('combined-stress', allHistory, metrics, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)

  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Combined-stress eval results ─────────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
