/**
 * Composer eval — Context Carry
 *
 * Tests whether the agent context composer successfully passes relevant
 * earlier conversation to an agent that needs it. The user establishes
 * context (a file path, a preference, etc.) in earlier messages, then
 * asks for something that requires an agent. The agent needs that earlier
 * context to do the job correctly.
 *
 * With agentContextComposer on, the classifier should KEEP those earlier
 * messages so the agent has the context it needs.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  feedConversation,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'
import type { Message } from '../../../src/types/core.js'

export const name = 'composer-context-carry'
export const description = 'Agent context composer KEEP: agent uses earlier conversation context to complete task (variants: file-reference, preference-aware)'
export const category = 'composer'
export const estimatedCostUsd = 0.20
export const rubric = [
  'agent_completed — Did the agent reach completed status? Score 1.0 if completed, 0.0 if suspended or failed.',
  'context_used — Does the agent\'s work reflect specific information from the earlier conversation (not just the spawn prompt)? Score 1.0 if clear evidence of context use, 0.5 if partial, 0.0 if the agent appears to have no context.',
  'result_correct — Did the agent produce the correct output based on the full context? Score 1.0 if correct, 0.5 if partially correct, 0.0 if wrong.',
  'no_hallucination — Did the agent avoid inventing details not present in the conversation or spawn prompt? Score 1.0 if no fabrication, 0.5 if minor, 0.0 if significant.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface ContextCarryVariant {
  name: string
  query: string
  setup: (workspaceDir: string) => void
  /** Messages to feed as earlier conversation before the test query. Receives workspace path for dynamic paths. */
  priorConversation: EvalMessage[] | ((workspacePath: string) => EvalMessage[])
  judgeContext?: string
}

export const variants: EvalVariant[] = [
  {
    name: 'file-reference',
    query: 'Okay, can you go ahead and fix that bug we just discussed?',
    setup: (workspaceDir: string) => {
      // Create the file the agent needs to fix.
      const projectDir = path.join(workspaceDir, 'projects', 'api-service')
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'handler.ts'), `export function processOrder(order: Order) {
  // BUG: doesn't validate quantity before calculating total
  const total = order.price * order.quantity
  return { orderId: order.id, total }
}
`)
    },
    priorConversation: (ws: string) => [
      { role: 'user' as const, content: `I found a bug in ${ws}/projects/api-service/handler.ts — the processOrder function doesn't validate that quantity is positive before calculating the total. A negative quantity would give a negative total, which is wrong.` },
      { role: 'assistant' as const, content: `That's a real issue. The processOrder function in ${ws}/projects/api-service/handler.ts multiplies price by quantity without checking that quantity is a positive number. A negative quantity would produce a negative total, which could cause billing errors. Want me to fix it?` },
    ],
    judgeContext: 'The agent should know from the earlier conversation the exact file path and function name (processOrder), and that it needs to validate quantity is positive. The agent should add a quantity validation check.',
  } satisfies ContextCarryVariant as EvalVariant,
  {
    name: 'preference-aware',
    query: 'Can you create a utility function that formats dates for our API responses?',
    setup: (workspaceDir: string) => {
      const projectDir = path.join(workspaceDir, 'projects', 'api-service')
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
        name: 'api-service', version: '1.0.0',
        dependencies: { typescript: '^5.0.0' },
      }, null, 2))
    },
    priorConversation: [
      { role: 'user', content: "Quick ground rule for any code you write for me: always use TypeScript, never plain JavaScript. And for date formatting, always use ISO 8601 format — no locale-dependent formats." },
      { role: 'assistant', content: "Got it — TypeScript only, and ISO 8601 for all date formatting. I'll follow that for everything going forward." },
    ],
    judgeContext: 'The agent should create a TypeScript file (not JavaScript), and the date formatting function should use ISO 8601 format. Both of these requirements come from the earlier conversation, not the current query.',
  } satisfies ContextCarryVariant as EvalVariant,
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
  const variant = (opts.variant ?? variants[0]!) as ContextCarryVariant
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

    // Set up mock files for this variant
    variant.setup(env.workspaceDir)

    // Feed earlier conversation into the store
    const priorMessages = typeof variant.priorConversation === 'function'
      ? variant.priorConversation(env.workspaceDir)
      : variant.priorConversation
    feedConversation(env.bundle, priorMessages)
    console.log(`[composer-context-carry:${variant.name}] Fed ${priorMessages.length} prior messages.`)

    console.log(`[composer-context-carry:${variant.name}] Query: "${variant.query}"`)

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

    const agentTranscripts = newAgents.map(a => ({
      id: a.id, status: a.status, skill: a.skillName,
      transcript: renderHistory(a.history ?? []),
    }))

    console.log(`[composer-context-carry:${variant.name}] Agents: ${newAgents.length}, statuses: ${newAgents.map(a => a.status).join(', ')}`)
    console.log(`[composer-context-carry:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      agentsSpawned: newAgents.length,
      agentStatuses: newAgents.map(a => ({ id: a.id, status: a.status, skill: a.skillName })),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
    }

    if (opts.noJudge) {
      console.log(`\n[composer-context-carry:${variant.name}] OUTPUT:`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`[composer-context-carry:${variant.name}] Running judge…`)

    const context = `
SCENARIO: User established context in earlier conversation, then asked for a task that requires an agent. The agent context composer is ON — relevant earlier messages should be passed to the agent.
VARIANT: ${variant.name}
${variant.judgeContext}

PRIOR CONVERSATION (fed into message store before the query):
${priorMessages.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n')}

USER QUERY: "${variant.query}"

HEAD TOOL CALLS:
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

AGENTS (${newAgents.length}):
${newAgents.map(a => `- ${a.id}: status=${a.status}`).join('\n') || '(none)'}

AGENT TRANSCRIPTS:
${agentTranscripts.map(at => `--- Agent ${at.id} (${at.status}) ---\n${at.transcript}`).join('\n\n') || '(none)'}

HEAD RESPONSE:
${response}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      ...priorMessages,
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('composer-context-carry', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `composer-context-carry-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Composer-context-carry [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
