/**
 * Multi-agent coordination scenario — with task variants.
 *
 * Tests the Head's ability to manage two concurrent tasks from a single user
 * message. Each variant exercises a different combination of tool patterns.
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

export const name = 'multi-agent-coordination'
export const description = 'Single user message with two tasks → Head delegates both → both results relayed (variants: computation, research, mixed)'
export const category = 'routing'
export const estimatedCostUsd = 0.20
export const rubric = [
  'agents_spawned — Did the Head delegate the work via spawn_agent? Score 1.0 if 2 agents spawned, 0.8 if 1 agent handled both, 0.0 if none.',
  'result_a_present — Does the response include a substantive answer to the first task? Score 1.0 if correct, 0.5 if partial, 0.0 if missing.',
  'result_b_present — Does the response include a substantive answer to the second task? Score 1.0 if correct, 0.5 if partial, 0.0 if missing.',
  'no_confusion — Are the two results correctly attributed to their respective tasks? Score 1.0 if clear, 0.5 if ambiguous, 0.0 if mixed up.',
  'coherent_response — Does the Head present both results cohesively? Score 1.0 if natural, 0.5 if awkward, 0.0 if fragmented.',
  'no_impatient_messaging — The Head may attempt to call message_agent to check on or hurry a running agent — that is expected LLM behavior. What matters is whether the judge gate blocked it. Check the MESSAGE_AGENT CALLS section: if message_agent was never called, score 1.0. If it was called but the tool result shows it was blocked (error: "agent is still working"), score 1.0 — the guardrail worked. If it was called and succeeded (ok: true) on an unprompted check-in or nudge with no user-provided context, score 0.0 — the guardrail failed to catch impatient messaging.',
]

// printf 'shrok-eval-2026' | sha256sum = 1b4bb6c1f6d98a998cb5f9dcd5a0c226149205ec8ef502039c3cc90c6933f11f

export const variants: EvalVariant[] = [
  {
    name: 'computation',
    query: `I need two things computed:\n1. The SHA-256 hash of the exact string "shrok-eval-2026" (no newline, no quotes)\n2. The sum of all integers from 1 to 74 inclusive\n\nPlease compute both.`,
    setup: () => {},
    judgeContext: 'Task A: SHA-256 hash should be 1b4bb6c1f6d98a998cb5f9dcd5a0c226149205ec8ef502039c3cc90c6933f11f. Task B: sum should be 2775.',
  },
  {
    name: 'research',
    query: "I need two things looked up: what's the weather in Denver right now, and what's the current price of AAPL stock?",
    setup: () => {},
    judgeContext: 'Task A: should include Denver weather (temperature, conditions). Task B: should include Apple/AAPL stock price. Exact values vary.',
  },
  {
    name: 'mixed',
    query: "Two things: count the lines in /etc/hostname, and search the web for the latest news about TypeScript.",
    setup: () => {},
    judgeContext: 'Task A: /etc/hostname typically has 1 line (deterministic). Task B: should include recent TypeScript news/developments (varies).',
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
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    console.log(`[multi-agent:${variant.name}] Query: "${variant.query.slice(0, 80)}"`)

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
    })

    const allAgents = [
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('running'),
      ...env.bundle.workers.getByStatus('suspended'),
      ...env.bundle.workers.getByStatus('failed'),
    ]
    const newAgents = allAgents.filter(a => !agentsBefore.has(a.id))
    const spawnCalls = toolCalls.filter(tc => tc.name === 'spawn_agent')
    const messageCalls = toolCalls.filter(tc => tc.name === 'message_agent')

    const agentTranscripts = newAgents.map(a => ({
      id: a.id, status: a.status, skill: a.skillName,
      transcript: renderHistory(a.history ?? []),
    }))

    console.log(`[multi-agent:${variant.name}] spawn_agent: ${spawnCalls.length}, message_agent: ${messageCalls.length}, agents: ${newAgents.length}`)
    console.log(`[multi-agent:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      spawnCalls: spawnCalls.length,
      messageCalls: messageCalls.length,
      agentsSpawned: newAgents.length,
      agentStatuses: newAgents.map(a => ({ id: a.id, status: a.status, skill: a.skillName })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
    }

    if (opts.noJudge) {
      console.log(`\n[multi-agent:${variant.name}] OUTPUT:`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`[multi-agent:${variant.name}] Running judge…`)

    const context = `
SCENARIO: User asked for two tasks in a single message. Head should delegate both.
VARIANT: ${variant.name}
${variant.judgeContext}

USER QUERY: "${variant.query}"

HEAD TOOL CALLS:
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

AGENTS (${newAgents.length}):
${newAgents.map(a => `- ${a.id}: status=${a.status}`).join('\n') || '(none)'}

AGENT TRANSCRIPTS:
${agentTranscripts.map(at => `--- Agent ${at.id} (${at.status}) ---\n${at.transcript}`).join('\n\n') || '(none)'}

MESSAGE_AGENT CALLS: ${messageCalls.length}
${messageCalls.map(tc => `- message: "${(tc.input as Record<string, unknown>)['message']}"`).join('\n') || '(none called)'}
${messageCalls.length > 0 ? `\nMESSAGE_AGENT TOOL RESULTS (check whether the judge gate blocked the call — "error" means blocked, "ok" means it went through):\n${(() => { const traceContent = Object.values(traceFiles).join('\\n'); const results: string[] = []; const re = /message_agent.*?\n.*?← message_agent: ([^\n]+)/gs; let m; while ((m = re.exec(traceContent)) !== null) results.push(m[1]!.trim()); return results.map(r => '- result: ' + r.slice(0, 200)).join('\\n') || '(no results found in traces)' })()}` : ''}

HEAD RESPONSE:
${response}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('multi-agent-coordination', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `multi-agent-coordination-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Multi-agent [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
