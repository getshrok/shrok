/**
 * Agent lifecycle scenario — with task variants.
 *
 * Tests the full agent pipeline end-to-end:
 *   user asks → Head spawns agent → agent does real work → agent completes →
 *   work summary judge condenses → relay judge passes → Head relays result
 *
 * Variants exercise different tool patterns (bash, web search, file ops)
 * while the rubric tests the same pipeline behavior.
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

export const name = 'agent-lifecycle'
export const description = 'Full agent pipeline: spawn → work → complete → relay (variants: computation, web-search, file-operation, code-analysis)'
export const category = 'routing'
export const estimatedCostUsd = 0.15
export const rubric = [
  'agent_spawned — Did the Head spawn an agent for the task? Score 1.0 if spawn_agent was called, 0.0 if not.',
  'agent_completed — Did the spawned agent reach completed status? Score 1.0 if completed, 0.5 if still running/suspended, 0.0 if failed or not spawned.',
  'result_relayed — Does the Head\'s final response contain substantive, accurate results from the task? Score 1.0 if correct and complete, 0.5 if partial, 0.0 if wrong or missing.',
  'no_raw_leakage — Does the Head\'s response avoid leaking raw tool output, HTML, system markers (<system-trigger>, <agent-result>, etc.), or verbose metadata? Score 1.0 if clean natural response, 0.5 if minor leakage, 0.0 if raw dumps.',
  'pipeline_complete — Did the full pipeline fire: (1) agent completed event was queued, (2) Head processed the completion and responded to the user? Check that the Head\'s response came AFTER the agent completed (not a premature guess). Score 1.0 if the pipeline clearly completed, 0.5 if ambiguous, 0.0 if the Head answered before the agent finished.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

export const variants: EvalVariant[] = [
  {
    name: 'computation',
    query: "What is the SHA-256 hash of 'shrok-eval-xK9mP3-2026'?",
    setup: () => {},
    judgeContext: 'The correct SHA-256 hash is a64cdb973b2569efaa7abcb85a7efa0c4aa042c13aa8c0394235499913b19d51. The agent must run code to compute this — it cannot be guessed.',
  },
  {
    name: 'web-search',
    query: 'What are the current standings in the NBA Eastern Conference?',
    setup: () => {},
    judgeContext: 'The agent should have searched the web and returned current NBA Eastern Conference standings with team names and records. Exact data will vary by date.',
  },
  {
    name: 'file-read',
    query: 'What is the contents of /etc/os-release?',
    setup: () => {},
    judgeContext: 'The agent should read /etc/os-release and return its contents. The file contains OS name, version, and ID fields. The head should relay the key information.',
  },
  {
    name: 'code-analysis',
    query: 'How many lines are in the file /etc/hostname?',
    setup: () => {},
    judgeContext: 'The file /etc/hostname typically has 1 line. The agent should run bash (wc -l or similar) and return the count.',
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Run ──────────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = opts.variant ?? variants[0]!
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    // Set up variant-specific files
    variant.setup(env.skillsDir)

    console.log(`[agent-lifecycle:${variant.name}] Sending query: "${variant.query.slice(0, 80)}"`)

    const agentsBefore = new Set(env.bundle.workers.getByStatus('completed').map(a => a.id))

    const { response, traceFiles, toolCalls } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: variant.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 120_000,
    })

    const allAgents = [...env.bundle.workers.getByStatus('completed'), ...env.bundle.workers.getByStatus('running'), ...env.bundle.workers.getByStatus('suspended'), ...env.bundle.workers.getByStatus('failed')]
    const newAgents = allAgents.filter(a => !agentsBefore.has(a.id))
    const agentSpawned = toolCalls.some(tc => tc.name === 'spawn_agent')
    const completedAgents = newAgents.filter(a => a.status === 'completed')
    const agentCompleted = completedAgents.length > 0
    const agentTranscript = completedAgents.length > 0
      ? completedAgents.map(a => renderHistory(a.history ?? [])).join('\n\n')
      : newAgents.length > 0
        ? `Agent spawned but status: ${newAgents.map(a => a.status).join(', ')}`
        : '(no agent spawned)'

    console.log(`[agent-lifecycle:${variant.name}] Agent spawned: ${agentSpawned}, completed: ${agentCompleted}`)
    console.log(`[agent-lifecycle:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      agentSpawned,
      agentCompleted,
      agentStatuses: newAgents.map(a => ({ id: a.id, status: a.status, skill: a.skillName })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
    }

    if (opts.noJudge) {
      console.log(`\n[agent-lifecycle:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      console.log('\nAgent transcript:')
      console.log(agentTranscript)
      return
    }

    console.log(`[agent-lifecycle:${variant.name}] Running judge…`)

    const context = `
SCENARIO: Full agent lifecycle test. The user asked a question that requires agent delegation.
VARIANT: ${variant.name}
${variant.judgeContext ? `EXPECTED: ${variant.judgeContext}` : ''}

USER QUERY: "${variant.query}"

HEAD TOOL CALLS (in order):
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

AGENTS SPAWNED: ${newAgents.length}
${newAgents.map(a => `- Agent ${a.id}: status=${a.status}, skill=${a.skillName || 'none'}`).join('\n') || '(none)'}

AGENT TRANSCRIPT:
${agentTranscript}

HEAD FINAL RESPONSE TO USER:
${response}

PIPELINE NOTES:
- spawn_agent called: ${agentSpawned}
- Agent reached completed status: ${agentCompleted}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('agent-lifecycle', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `agent-lifecycle-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-lifecycle [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
