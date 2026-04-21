/**
 * Archival-recall scenario (replaces the old isolated archival eval).
 *
 * Generates a long multi-topic conversation, archives it into topic memory,
 * then runs 4 Head queries to verify the archived content is actually
 * retrievable through the full pipeline. Judges the Head's answers, not
 * the intermediate topic summaries.
 *
 * This tests what the user would actually experience: "I talked about X
 * a while ago — does Shrok remember it?"
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
  feedConversation,
  LEAN_EVAL_CONFIG,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'archival-recall'
export const description = 'Archive a multi-topic conversation → query the Head for each topic → judge whether the answers contain the key details'
export const category = 'memory'
export const estimatedCostUsd = 0.30
export const rubric = [
  'health_detail_recalled — Does the health query response include specific details from the health conversation in the fixture (exercise names, rep counts, practitioner name)? Score based on how many key details are accurately recalled.',
  'technical_detail_recalled — Does the CI query response include specific details from the technical conversation in the fixture (test names, root causes, infrastructure details)? Score based on accuracy and completeness.',
  'travel_detail_recalled — Does the travel query response include specific details from the travel conversation in the fixture (destinations, companions, accommodation, dates)? Score based on accuracy and completeness.',
  'no_cross_contamination — Do any of the answers bleed details from other topics? Score 1.0 if all answers are clean, 0.5 if minor bleed, 0.0 if significant confusion.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface ArchivalVariant {
  name: string
  query: string
  setup: (skillsDir: string) => void
  queries: Array<{ label: string; query: string }>
}

export const variants: EvalVariant[] = [
  {
    name: 'direct',
    query: '', setup: () => {},
    queries: [
      { label: 'health', query: 'What exercises did Dr. Chen prescribe for my back pain? Include the specific exercises and rep counts.' },
      { label: 'technical', query: 'What was causing the flaky CI integration test we discussed? What were the root causes?' },
      { label: 'travel', query: 'What are the plans for my Japan trip? Who am I going with and what are the key details?' },
    ],
  } satisfies ArchivalVariant as EvalVariant,
  {
    name: 'indirect',
    query: '', setup: () => {},
    queries: [
      { label: 'health', query: "I've been meaning to get back to those physio exercises. What were they again?" },
      { label: 'technical', query: "That CI test started failing again. Remind me what we figured out last time?" },
      { label: 'travel', query: "I need to start booking things for the trip. What did we settle on for the itinerary?" },
    ],
  } satisfies ArchivalVariant as EvalVariant,
  {
    name: 'contextual',
    query: '', setup: () => {},
    queries: [
      { label: 'health', query: "My back's been acting up again. What did we decide about the exercise routine?" },
      { label: 'technical', query: "The build is red again with a timeout. Didn't we already dig into this — something about the connection pool?" },
      { label: 'travel', query: "Alex just asked me about accommodation for the trip. What was the plan we discussed?" },
    ],
  } satisfies ArchivalVariant as EvalVariant,
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = (opts.variant ?? variants[0]!) as ArchivalVariant
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate or replay history ─────────────────────────────────────────────
  let history: EvalMessage[]

  if (opts.replayHistory) {
    history = opts.replayHistory
  } else {
    console.log(`[archival-recall:${variant.name}] Generating conversation (~120 turns)…`)
    history = await generateHistoryCached(
      llm,
      'archival-main',
      `a long conversation covering 4 distinct areas that a personal assistant would care about:
1. A technical problem at work: debugging a flaky integration test in a CI pipeline (specific details: the test sometimes fails with a timeout on the database connection pool)
2. A personal health concern: recurring lower back pain from sitting too long, trying a standing desk, physiotherapy exercises prescribed by a physio named Dr. Chen
3. A travel plan: upcoming trip to Japan in May, planning to visit Kyoto and Tokyo, needs to book ryokan accommodation, travelling with a partner named Alex
4. A recurring personal preference: the user strongly dislikes being interrupted mid-thought and prefers to finish explaining before getting suggestions`,
      120,
    )
  }

  // ── Populate MessageStore and archive ─────────────────────────────────────
  const allTraces: Record<string, string> = {}

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    // Feed conversation into the store — with dense fixtures and lean config,
    // archival fires naturally during the query activations below.
    feedConversation(env.bundle, history)
    console.log(`[archival-recall:${variant.name}] Fed ${history.length} messages into store.`)

    // ── Query the Head for each topic ──────────────────────────────────────
    const queries = variant.queries

    const responses: Record<string, { response: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }> = {}

    for (const { label, query } of queries) {
      console.log(`[archival-recall:${variant.name}] Querying: ${label}…`)
      const result = await runHeadQuery({
        bundle: env.bundle,
        topicMemory: memory,
        router,
        config: env.config,
        identityDir: env.identityDir,
        workspaceDir: env.workspaceDir,
        query,
        stubAgentRunner: true,
        timeoutMs: 60_000,
      })
      responses[label] = { response: result.response, toolCalls: result.toolCalls }
      Object.assign(allTraces, result.traceFiles)
      console.log(`[archival-recall:${variant.name}]   → ${result.response.slice(0, 120)}…`)
    }

    // ── Output ─────────────────────────────────────────────────────────────
    // Check what topics were created by natural archival during the queries
    const topics = await memory.getTopics()
    console.log(`[archival-recall:${variant.name}] ${topics.length} memory topics after queries.`)

    const output = {
      variant: variant.name,
      topicsCreated: topics.map(t => ({ label: t.label, summary: t.summary })),
      responses: Object.fromEntries(
        Object.entries(responses).map(([k, v]) => [k, { response: v.response, toolCalls: v.toolCalls.map(tc => tc.name) }])
      ),
    }

    if (opts.noJudge) {
      console.log(`\n[archival-recall:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log(`[archival-recall:${variant.name}] Running judge…`)

    const context = `
SCENARIO: A 4-topic conversation was fed into the message store with a lean context window (30k). Archival fires naturally during query activations. 4 separate Head queries test recall.
VARIANT: ${variant.name} — queries use ${variant.name} phrasing style.

ORIGINAL CONVERSATION (${history.length} turns):
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

MEMORY TOPICS CREATED (${topics.length} total):
${topics.map(t => `- "${t.label}": ${t.summary}`).join('\n')}

${queries.map((q, i) => `QUERY ${i + 1} (${q.label}): "${q.query}"
HEAD RESPONSE: ${responses[q.label]?.response || '(no response)'}
TOOL CALLS: ${responses[q.label]?.toolCalls.map(tc => tc.name).join(', ') || '(none)'}`).join('\n\n')}
`

    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('archival-recall', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `archival-recall-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Archival-recall [${variantName}] eval results ─────────────────────`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
