/**
 * Anaphoric reference scenario.
 *
 * Tests the query rewriter: a topic is archived into memory, the user mentions
 * it in live conversation, then sends a vague follow-up ("what were the exact
 * numbers again?"). The rewriter must resolve the reference using recent
 * conversation context so the correct topic is retrieved.
 *
 * Variants: pronoun (vague), implicit (very vague), explicit (control).
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
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'anaphoric-reference'
export const description = 'Vague follow-up query after topic mentioned in live conversation — tests query rewriter for memory retrieval'
export const category = 'memory'
export const estimatedCostUsd = 0.15
export const rubric = [
  'correct_topic_retrieved — Was the renovation topic retrieved from memory and injected into the Head\'s context? Check the MEMORY BLOCK section. Score 1.0 if renovation details appear in the memory block, 0.0 if the memory block is empty or contains unrelated topics.',
  'details_accurate — Does the Head\'s response include specific details from the archived renovation conversation? Look for: contractor name (Mike Delano), budget ($42,000), timeline (8 weeks), flooring (maple hardwood). Score 1.0 if 3+ details correct, 0.5 if 1-2, 0.0 if none.',
  'no_fabrication — Does the Head avoid inventing details not in the archived conversation? Score 1.0 if all stated details match the source material, 0.5 if minor discrepancies, 0.0 if significant fabrication.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface AnaphoricVariant {
  name: string
  query: string
  setup: (skillsDir: string) => void
  liveContext: EvalMessage[]
  vagueQuery: string
}

const LIVE_CONTEXT: EvalMessage[] = [
  { role: 'user', content: "I've been going back and forth on that renovation project we talked about." },
  { role: 'assistant', content: "Yeah, there were a lot of moving pieces with that one. What's on your mind?" },
]

export const variants: EvalVariant[] = [
  {
    name: 'pronoun',
    query: '', setup: () => {},
    liveContext: LIVE_CONTEXT,
    vagueQuery: 'What were the exact numbers again?',
  } satisfies AnaphoricVariant as EvalVariant,
  {
    name: 'implicit',
    query: '', setup: () => {},
    liveContext: LIVE_CONTEXT,
    vagueQuery: 'Can you pull that up for me?',
  } satisfies AnaphoricVariant as EvalVariant,
  {
    name: 'explicit',
    query: '', setup: () => {},
    liveContext: LIVE_CONTEXT,
    vagueQuery: 'What were the renovation budget and timeline details?',
  } satisfies AnaphoricVariant as EvalVariant,
]

// ─── Run ──────────────────────────────────────────────────────────────────────

const HISTORY_SEED = `A detailed home renovation planning conversation. The user is renovating their kitchen and
living room. Key facts that MUST be established clearly in the conversation:
- Contractor: Mike Delano, recommended by a neighbor
- Total budget: $42,000 (kitchen $28,000, living room $14,000)
- Timeline: 8 weeks starting mid-March
- Flooring: maple hardwood throughout both rooms
- Kitchen: new cabinets, quartz countertops, subway tile backsplash
- Living room: built-in bookshelves, new windows
The conversation should feel natural — the user and assistant discuss options, compare prices,
and settle on these specifics over multiple turns.`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = (opts.variant ?? variants[0]!) as AnaphoricVariant
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
  } })

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    // ── Generate or replay the renovation conversation ─────────────────────
    console.log(`[anaphoric-reference:${variant.name}] Generating renovation conversation…`)
    const history = opts.replayHistory ?? await generateHistoryCached(
      llm, 'anaphoric-renovation', HISTORY_SEED, 20,
    )

    // ── Chunk into topic memory ────────────────────────────────────────────
    console.log(`[anaphoric-reference:${variant.name}] Chunking into memory…`)
    await memory.chunk(history)
    const topics = await memory.getTopics()
    console.log(`[anaphoric-reference:${variant.name}] ${topics.length} topic(s) created.`)

    // ── Seed live conversation context ─────────────────────────────────────
    // These turns establish that the user is thinking about the renovation —
    // the vague follow-up only makes sense in this context.
    console.log(`[anaphoric-reference:${variant.name}] Seeding live context (${variant.liveContext.length} turns)…`)
    feedConversation(env.bundle, variant.liveContext)

    // ── Send the vague query ───────────────────────────────────────────────
    console.log(`[anaphoric-reference:${variant.name}] Sending query: "${variant.vagueQuery}"`)
    const result = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: variant.vagueQuery,
      stubAgentRunner: true,
      timeoutMs: 60_000,
    })
    const allTraces = result.traceFiles

    console.log(`[anaphoric-reference:${variant.name}] Response: ${result.response.slice(0, 200)}…`)
    console.log(`[anaphoric-reference:${variant.name}] Memory block: ${result.memoryBlock ? result.memoryBlock.slice(0, 150) + '…' : '(empty)'}`)

    // ── Output ─────────────────────────────────────────────────────────────
    const output = {
      variant: variant.name,
      topicsCreated: topics.map(t => ({ label: t.label, summary: t.summary })),
      memoryBlock: result.memoryBlock,
      response: result.response,
    }

    if (opts.noJudge) {
      console.log(`\n[anaphoric-reference:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log(`[anaphoric-reference:${variant.name}] Running judge…`)
    const context = `
SCENARIO: A renovation conversation was archived into topic memory. The user then mentioned the renovation
in live conversation, followed by a vague query. The query rewriter should resolve the vague reference
using recent conversation context so the correct topic is retrieved.

VARIANT: ${variant.name} — "${variant.vagueQuery}"
${variant.name === 'explicit' ? '(Control variant — self-contained query, should always work)' : '(Vague query — depends on query rewriter resolving the reference)'}

ARCHIVED CONVERSATION (${history.length} turns):
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

TOPICS IN MEMORY (${topics.length}):
${topics.map(t => `- "${t.label}": ${t.summary}`).join('\n')}

LIVE CONTEXT (seeded before the vague query):
${variant.liveContext.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

VAGUE QUERY: "${variant.vagueQuery}"

MEMORY BLOCK (topics injected into Head's system prompt — this shows what was actually retrieved):
${result.memoryBlock || '(empty — no topics retrieved)'}

HEAD RESPONSE:
${result.response}
`

    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('anaphoric-reference', [...history, ...variant.liveContext], output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `anaphoric-reference-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Anaphoric-reference [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
