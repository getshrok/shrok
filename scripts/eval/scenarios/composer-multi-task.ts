/**
 * Composer eval — Multi-Task Delegation
 *
 * Tests the agent context composer's EXTRACT capability. A single user message
 * contains two tasks; the head spawns two agents. With agentContextComposer on,
 * the classifier should EXTRACT only each agent's assigned portion from the
 * shared user message, preventing agents from doing each other's work.
 *
 * This is the premium-mode counterpart to multi-agent-coordination (which tests
 * the base mode where agents get only their spawn prompt).
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

export const name = 'composer-multi-task'
export const description = 'Agent context composer EXTRACT: two agents from one message, each sees only its task (variants: research, mixed)'
export const category = 'composer'
export const estimatedCostUsd = 0.25
export const rubric = [
  'agents_spawned — Did the Head spawn 2 separate agents? Score 1.0 if 2 agents, 0.0 if fewer.',
  'task_isolation — Did each agent ONLY do its assigned task? Check each agent\'s tool calls: if agent A (task 1) never called tools related to task 2, and agent B (task 2) never called tools related to task 1, score 1.0. Score 0.5 if one agent stayed focused but the other did both. Score 0.0 if both agents did both tasks.',
  'result_a_present — Does the response include a substantive answer to the first task? Score 1.0 if correct, 0.5 if partial, 0.0 if missing.',
  'result_b_present — Does the response include a substantive answer to the second task? Score 1.0 if correct, 0.5 if partial, 0.0 if missing.',
  'no_cross_contamination — Are the two results correctly attributed to their respective tasks? Score 1.0 if clear, 0.5 if ambiguous, 0.0 if mixed up.',
]

export const variants: EvalVariant[] = [
  {
    name: 'research',
    query: "I need two things looked up: what's the weather in Denver right now, and what's the current price of AAPL stock?",
    setup: () => {},
    judgeContext: 'Task A: Denver weather (temperature, conditions). Task B: AAPL stock price. Each agent should search for ONLY its assigned task — not both.',
  },
  {
    name: 'mixed',
    query: "Two things: count the lines in /etc/hostname, and search the web for the latest news about TypeScript.",
    setup: () => {},
    judgeContext: 'Task A: /etc/hostname line count (typically 1). Task B: TypeScript news. Agent A should use bash, Agent B should use web_search — no overlap.',
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
  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
      agentContextComposer: true,
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    console.log(`[composer-multi-task:${variant.name}] Query: "${variant.query.slice(0, 80)}"`)

    const agentsBefore = new Set([
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('running'),
    ].map(a => a.id))

    const { response, traceFiles, toolCalls } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: variant.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 120_000,
      agentContextComposer: true,
    })

    const allAgents = [
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('running'),
      ...env.bundle.workers.getByStatus('suspended'),
      ...env.bundle.workers.getByStatus('failed'),
    ]
    const newAgents = allAgents.filter(a => !agentsBefore.has(a.id))
    const spawnCalls = toolCalls.filter(tc => tc.name === 'spawn_agent')

    const agentTranscripts = newAgents.map(a => ({
      id: a.id, status: a.status, skill: a.skillName,
      transcript: renderHistory(a.history ?? []),
    }))

    console.log(`[composer-multi-task:${variant.name}] spawn_agent: ${spawnCalls.length}, agents: ${newAgents.length}`)
    console.log(`[composer-multi-task:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      spawnCalls: spawnCalls.length,
      agentsSpawned: newAgents.length,
      agentStatuses: newAgents.map(a => ({ id: a.id, status: a.status, skill: a.skillName })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
    }

    if (opts.noJudge) {
      console.log(`\n[composer-multi-task:${variant.name}] OUTPUT:`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`[composer-multi-task:${variant.name}] Running judge…`)

    const context = `
SCENARIO: User asked for two tasks in a single message. Head delegates both. Agent context composer (EXTRACT mode) is ON — each agent should see only its assigned task from the shared user message.
VARIANT: ${variant.name}
${variant.judgeContext}

USER QUERY: "${variant.query}"

HEAD TOOL CALLS:
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

AGENTS (${newAgents.length}):
${newAgents.map(a => `- ${a.id}: status=${a.status}`).join('\n') || '(none)'}

AGENT TRANSCRIPTS (check each agent's tool calls for task isolation):
${agentTranscripts.map(at => `--- Agent ${at.id} (${at.status}) ---\n${at.transcript}`).join('\n\n') || '(none)'}

HEAD RESPONSE:
${response}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('composer-multi-task', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `composer-multi-task-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Composer-multi-task [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
