/**
 * Code execution scenario — with task variants.
 *
 * Each variant sends a natural computation request through the Head.
 * Tests whether the Head delegates to an agent and gets the correct answer.
 * Tasks use inputs the model cannot answer from memory alone.
 */

import * as path from 'node:path'
import {
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
import type { Message } from '../../../src/types/core.js'

export const name = 'code-execution'
export const description = 'Head routes computation to agent and returns correct answer (variants: sha256, sum, wordcount)'
export const category = 'routing'
export const estimatedCostUsd = 0.04
export const rubric = [
  'result_correct — Does the Head\'s response contain the correct answer? Score 1.0 if correct, 0.0 if wrong or missing.',
  'routed_to_agent — Did the Head spawn an agent that ran code (bash tool calls visible in transcript)? Score 1.0 if yes, 0.0 if the Head answered without delegating.',
  'code_actually_ran — Could the answer have been guessed from model memory, or does correctness prove code execution? Score 1.0 if the task requires computation (SHA-256, large sum), 0.5 if the model might know the answer, 0.0 if clearly fabricated.',
]

export const variants: EvalVariant[] = [
  {
    name: 'sha256',
    query: "What is the SHA-256 hash of 'shrok-eval-xK9mP3-2026'?",
    setup: () => {},
    judgeContext: 'The correct SHA-256 hash is a64cdb973b2569efaa7abcb85a7efa0c4aa042c13aa8c0394235499913b19d51. This cannot be computed from model memory — code must run.',
  },
  {
    name: 'sum',
    query: `What is the sum of these numbers?\n847 293 1047 582 914 231 768 445 1203 676 389 821 534 967 112 743 298 1156 623 487 934 271 809 456 1098 345 712 589 167 923 634 278 1041 715 392 867 524 183 976 641 309 857 498 1124 263 731 584 419 952 687`,
    setup: () => {},
    judgeContext: 'The correct sum is 32115. With 50 numbers, the model is unlikely to sum correctly from memory — code should run.',
  },
  {
    name: 'wordcount',
    query: `How many times does the word "the" appear (whole word, case-insensitive) in this paragraph?\n\n"The quick brown fox jumps over the lazy dog. The dog barked at the fox, but the fox ignored the barking and ran into the forest. In the forest, the fox found a den where the other foxes had gathered near the old oak tree."`,
    setup: () => {},
    judgeContext: 'The correct count is 11. The model might get this right from careful counting, but code execution is more reliable.',
  },
]

function renderHistory(history: Message[]): string {
  return history.map(m => {
    if (m.kind === 'text') return `[${m.role}]: ${m.content}`
    if (m.kind === 'tool_call') {
      return m.toolCalls.map(tc =>
        `[tool_call: ${tc.name}] ${JSON.stringify(tc.input).slice(0, 300)}`
      ).join('\n')
    }
    if (m.kind === 'tool_result') {
      return m.toolResults.map(tr =>
        `[tool_result: ${tr.name}] ${tr.content.slice(0, 300)}`
      ).join('\n')
    }
    return `[${m.kind}]`
  }).join('\n\n')
}

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = opts.variant ?? variants[0]!
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment()

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    console.log(`[code-execution:${variant.name}] Query: "${variant.query.slice(0, 80)}"`)

    const agentsBefore = new Set(env.bundle.workers.getByStatus('completed').map(a => a.id))

    const { response, traceFiles } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: variant.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 90_000,
    })

    const newAgents = env.bundle.workers.getByStatus('completed')
      .filter(a => !agentsBefore.has(a.id))

    const agentTranscript = newAgents.length > 0
      ? newAgents.map(a => renderHistory(a.history ?? [])).join('\n\n')
      : '(no agent spawned)'

    const agentSpawned = newAgents.length > 0
    console.log(`[code-execution:${variant.name}] ${response.slice(0, 120)}`)
    console.log(`[code-execution:${variant.name}] agent spawned=${agentSpawned}`)

    const output = {
      variant: variant.name,
      prompt: variant.query,
      headResponse: response,
      agentSpawned,
      agentTranscript,
    }

    if (opts.noJudge) {
      console.log(`\n[code-execution:${variant.name}] OUTPUT:`)
      console.log(JSON.stringify({ ...output, agentTranscript: agentTranscript.slice(0, 500) }, null, 2))
      return
    }

    const context = `VARIANT: ${variant.name}
${variant.judgeContext}

PROMPT: ${variant.query}

AGENT TRANSCRIPT:
${agentTranscript}

HEAD RESPONSE:
${response}`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('code-execution', history, output, judgment, {
      runId: opts.runId, category, traces: traceFiles,
      fileLabel: `code-execution-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Code-execution [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
