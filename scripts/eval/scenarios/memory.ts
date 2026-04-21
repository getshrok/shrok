/**
 * Memory-formation scenario (replaces the old isolated memory eval).
 *
 * Generates three realistic conversation sessions covering different life areas,
 * feeds them through memory.chunk(), then runs Head queries to verify the
 * content is retrievable through the full pipeline (not just direct retrieve()).
 *
 * Tests what the user would experience: "I told you about X — do you remember?"
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
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'memory-formation'
export const description = 'Chunk 3 sessions into topic memory → query the Head for each → judge whether answers contain session-specific details'
export const category = 'memory'
export const estimatedCostUsd = 0.12
export const rubric = [
  'health_query_answered — Does the Head\'s response to the health question include session-specific details (sleep problems, tension headaches, magnesium supplement, GP visit)? Score 1.0 if 3+ details, 0.5 if 1-2, 0.0 if none.',
  'preference_query_answered — Does the Head\'s response correctly describe the user\'s communication preferences (short/direct, no bullet points, one question at a time, morning productivity)? Score 1.0 if 3+ prefs, 0.5 if 1-2, 0.0 if none.',
  'project_query_answered — Does the Head\'s response include workshop-specific details (garage, table saw, router, workbench, partner wants it done before summer)? Score 1.0 if 3+ details, 0.5 if 1-2, 0.0 if none.',
  'negative_query_clean — No book was ever recommended in the health session. Does the Head correctly say it didn\'t recommend a book (rather than fabricating a title)? Score 1.0 if clean refusal or correction, 0.5 if hedged, 0.0 if it invents a book name.',
  'no_cross_contamination — Do the 3 positive answers stay within their own topic (health doesn\'t mention workshop, workshop doesn\'t mention sleep, etc.)? Score 1.0 if clean, 0.5 if minor bleed, 0.0 if significant confusion.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface MemoryVariant {
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
      { label: 'health', query: 'What health issues have I mentioned? Any symptoms or treatments?' },
      { label: 'preferences', query: 'How do I prefer you to communicate with me? What are my preferences?' },
      { label: 'project', query: 'Tell me about the workshop project I mentioned.' },
      { label: 'negative', query: 'What was the name of that book you recommended for my sleep issues?' },
    ],
  } satisfies MemoryVariant as EvalVariant,
  {
    name: 'indirect',
    query: '', setup: () => {},
    queries: [
      { label: 'health', query: "I was thinking about those supplements I started. What was the story?" },
      { label: 'preferences', query: "I remember telling you how I like things done. Can you recap that for me?" },
      { label: 'project', query: "My partner was asking about the garage thing. What's the status?" },
      { label: 'negative', query: 'What was the name of that book you recommended for my sleep issues?' },
    ],
  } satisfies MemoryVariant as EvalVariant,
  {
    name: 'vague',
    query: '', setup: () => {},
    queries: [
      { label: 'health', query: "What do you know about my health stuff?" },
      { label: 'preferences', query: "What have I told you about how I like to work?" },
      { label: 'project', query: "What's that project I've been working on at home?" },
      { label: 'negative', query: 'What was the name of that book you recommended for my sleep issues?' },
    ],
  } satisfies MemoryVariant as EvalVariant,
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = (opts.variant ?? variants[0]!) as MemoryVariant
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
  } })

  // ── Generate or replay history ─────────────────────────────────────────────
  let healthHistory: EvalMessage[]
  let prefsHistory: EvalMessage[]
  let projectHistory: EvalMessage[]

  if (opts.replayHistory) {
    const third = Math.floor(opts.replayHistory.length / 3)
    healthHistory = opts.replayHistory.slice(0, third)
    prefsHistory = opts.replayHistory.slice(third, third * 2)
    projectHistory = opts.replayHistory.slice(third * 2)
  } else {
    console.log(`[memory-formation:${variant.name}] Generating session 1: health…`)
    healthHistory = await generateHistoryCached(
      llm,
      'memory-health',
      'health check-ins over several weeks: the user mentions persistent sleep problems, a recurring tension headache, starting a magnesium supplement, and a recent GP visit that ruled out anything serious',
      30,
    )

    console.log(`[memory-formation:${variant.name}] Generating session 2: preferences…`)
    prefsHistory = await generateHistoryCached(
      llm,
      'memory-prefs',
      'the user expresses strong personal preferences: they want short direct responses (no bullet points), they dislike being given too many options, they prefer to be asked one question at a time, and they mention they work best in the mornings',
      20,
    )

    console.log(`[memory-formation:${variant.name}] Generating session 3: project…`)
    projectHistory = await generateHistoryCached(
      llm,
      'memory-project',
      'an ongoing side project: the user is building a small wood workshop in their garage, has bought a table saw and a router, is planning to build a workbench first, and mentions their partner is supportive but wants it finished before summer',
      25,
    )
  }

  const allHistory = [...healthHistory, ...prefsHistory, ...projectHistory]

  // ── Run memory chunking ────────────────────────────────────────────────────
  const allTraces: Record<string, string> = {}

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    console.log(`[memory-formation:${variant.name}] Chunking session 1 (health)…`)
    await memory.chunk(healthHistory)

    console.log(`[memory-formation:${variant.name}] Chunking session 2 (preferences)…`)
    await memory.chunk(prefsHistory)

    console.log(`[memory-formation:${variant.name}] Chunking session 3 (project)…`)
    await memory.chunk(projectHistory)

    const topics = await memory.getTopics()
    console.log(`[memory-formation:${variant.name}] ${topics.length} topics created.`)

    // ── Query the Head for each topic ──────────────────────────────────────
    const queries = variant.queries

    const responses: Record<string, { response: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }> = {}

    for (const { label, query } of queries) {
      console.log(`[memory-formation:${variant.name}] Querying: ${label}…`)
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
      console.log(`[memory-formation:${variant.name}]   → ${result.response.slice(0, 120)}…`)
    }

    // ── Output ─────────────────────────────────────────────────────────────
    const output = {
      variant: variant.name,
      topicsCreated: topics.map(t => ({ label: t.label, summary: t.summary, tags: t.tags })),
      responses: Object.fromEntries(
        Object.entries(responses).map(([k, v]) => [k, { response: v.response, toolCalls: v.toolCalls.map(tc => tc.name) }])
      ),
    }

    if (opts.noJudge) {
      console.log(`\n[memory-formation:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log(`[memory-formation:${variant.name}] Running judge…`)
    const context = `
SCENARIO: Three conversation sessions were chunked into topic memory, then 4 Head queries tested recall.
VARIANT: ${variant.name} — queries use ${variant.name} phrasing style.

SESSION 1 (health, ${healthHistory.length} turns):
${healthHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

SESSION 2 (preferences, ${prefsHistory.length} turns):
${prefsHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

SESSION 3 (project, ${projectHistory.length} turns):
${projectHistory.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

MEMORY TOPICS CREATED (${topics.length} total):
${topics.map(t => `- "${t.label}": ${t.summary} [tags: ${t.tags.join(', ')}]`).join('\n')}

${queries.map((q, i) => `QUERY ${i + 1} (${q.label}): "${q.query}"
HEAD RESPONSE: ${responses[q.label]?.response || '(no response)'}
TOOL CALLS: ${responses[q.label]?.toolCalls.map(tc => tc.name).join(', ') || '(none)'}`).join('\n\n')}
`

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('memory-formation', allHistory, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `memory-formation-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Memory-formation [${variantName}] eval results ────────────────────`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
