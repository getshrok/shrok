/**
 * Agent mid-task update scenario.
 *
 * Tests whether the head uses message_agent (not cancel+respawn) when a user
 * refines their request while an agent is already running:
 *   1. Head should call message_agent to push the new constraint
 *   2. The message content should contain the actual refinement
 *   3. Head should not cancel and re-spawn for a simple refinement
 *   4. Head should confirm the update to the user
 */

import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId, now } from '../../../src/llm/util.js'
import type { TextMessage } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadQuery,
  type HeadBundle,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'

export const name = 'agent-mid-task-update'
export const description = 'Head calls message_agent (not cancel+respawn) when user refines a running task'
export const category = 'routing'
export const estimatedCostUsd = 0.15
export const rubric = [
  'message_agent_called — Did the head call message_agent (rather than cancel_agent + re-spawn) to deliver the update? Score 1.0 if message_agent was called with the correct agentId, 0.5 if the head used cancel+respawn instead (less ideal but functional), 0.0 if neither — head ignores the update entirely.',
  'update_content_correct — Does the message passed to message_agent actually contain the new constraint from the user? Score 1.0 if the key information is clearly present (e.g. "ignore pre-2023" or "comparison table"), 0.5 if vague or partial, 0.0 if irrelevant or missing.',
  'no_restart_without_reason — Did the head avoid unnecessarily cancelling and re-spawning the agent when a message would suffice? Score 1.0 if no cancel+respawn occurred, 0.0 if the head discards the running agent and starts over for no reason.',
  'head_confirms_update — Does the head acknowledge the update to the user naturally (e.g. "Got it, I\'ve let it know to skip anything before 2023")? Score 1.0 if acknowledged clearly, 0.5 if implicit or minimal, 0.0 if the head ignores the user or gives no indication the update was processed.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface UpdateVariant {
  name: string
  userTask: string           // initial user request
  agentPrompt: string        // what the head told the agent
  refinementMessage: string  // user's mid-task refinement
  keyConstraint: string      // what the judge should look for in the message_agent content
}

const UPDATE_VARIANTS: UpdateVariant[] = [
  {
    name: 'scope-narrowing',
    userTask: 'Organise my files folder — group by file type',
    agentPrompt: 'Organise the user\'s files folder by file type.',
    refinementMessage: 'oh, ignore anything before 2023 — only reorganise the recent stuff',
    keyConstraint: 'ignore/skip files before 2023, only reorganise recent files',
  },
  {
    name: 'format-change',
    userTask: 'Search for recent papers on LLM context compression and summarise the key findings',
    agentPrompt: 'Search for recent papers on LLM context compression and summarise the key findings.',
    refinementMessage: 'actually, format that as a comparison table instead of a summary',
    keyConstraint: 'format output as a comparison table rather than a prose summary',
  },
]

export const variants: EvalVariant[] = UPDATE_VARIANTS.map(v => ({
  name: v.name,
  query: v.userTask,
  setup: () => {},
  judgeContext: `Refinement: "${v.refinementMessage}". Key constraint: "${v.keyConstraint}".`,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedRunningAgent(
  bundle: HeadBundle,
  agentId: string,
  variant: UpdateVariant,
) {
  bundle.messages.append({
    kind: 'text', role: 'user', id: generateId('msg'),
    content: variant.userTask,
    channel: 'eval', createdAt: now(),
  } as TextMessage)
  const tcId = generateId('tc')
  bundle.messages.append({
    kind: 'tool_call', id: generateId('msg'), createdAt: now(),
    content: 'On it!',
    toolCalls: [{ id: tcId, name: 'spawn_agent', input: { prompt: variant.agentPrompt } }],
  } as any)
  bundle.messages.append({
    kind: 'tool_result', id: generateId('msg'), createdAt: now(),
    toolResults: [{ toolCallId: tcId, name: 'spawn_agent', content: JSON.stringify({ agentId }) }],
  } as any)

  // Create agent in running state
  bundle.workers.create(agentId, { prompt: variant.agentPrompt, trigger: 'manual' })
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variantName = opts.variant?.name ?? UPDATE_VARIANTS[0]!.name
  const uv = UPDATE_VARIANTS.find(v => v.name === variantName) ?? UPDATE_VARIANTS[0]!

  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
    },
  })

  const allTraces: Record<string, string> = {}
  try {
    const tm = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm)
    const agentId = generateId('agent')

    seedRunningAgent(env.bundle, agentId, uv)

    // ── Sub-scenario 1: User sends refinement ────────────────────────────────
    console.log(`\n[agent-mid-task-update:${uv.name}] Sub-scenario 1: user refines running task`)
    const r1 = await runHeadQuery({
      bundle: env.bundle, topicMemory: tm, router, config: env.config, identityDir: env.identityDir,
      workspaceDir: env.workspaceDir, query: uv.refinementMessage,
      stubAgentRunner: true,
      timeoutMs: 60_000,
    })
    Object.assign(allTraces, r1.traceFiles)

    const headResponse1 = env.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).map(s => s.text).join('\n')
    const messageAgentCalls = r1.toolCalls.filter(tc => tc.name === 'message_agent')
    const messageAgentInput = messageAgentCalls[0]?.input ?? null
    const cancelCalled = r1.toolCalls.some(tc => tc.name === 'cancel_agent')
    const spawnCalled = r1.toolCalls.filter(tc => tc.name === 'spawn_agent')
    const cancelAndRespawn = cancelCalled && spawnCalled.length > 0

    console.log(`[agent-mid-task-update] Head response: ${headResponse1.slice(0, 200)}`)
    console.log(`[agent-mid-task-update] message_agent called: ${messageAgentCalls.length} time(s)`)
    if (messageAgentInput) console.log(`[agent-mid-task-update] message_agent input: ${JSON.stringify(messageAgentInput)}`)
    console.log(`[agent-mid-task-update] cancel_agent called: ${cancelCalled}, spawn_agent called: ${spawnCalled.length} time(s)`)

    // ── Sub-scenario 2: Follow-up to verify no re-spawn ──────────────────────
    console.log(`\n[agent-mid-task-update:${uv.name}] Sub-scenario 2: unrelated follow-up`)
    const r2 = await runHeadQuery({
      bundle: env.bundle, topicMemory: tm, router, config: env.config, identityDir: env.identityDir,
      workspaceDir: env.workspaceDir, query: "What's the weather like today?",
      stubAgentRunner: true,
      timeoutMs: 60_000,
    })
    Object.assign(allTraces, r2.traceFiles)

    const headResponse2 = env.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).slice(-3).map(s => s.text).join('\n')
    const respawnedOriginalTask = r2.toolCalls.filter(tc => tc.name === 'spawn_agent').some(tc => {
      const prompt = (tc.input?.['prompt'] as string ?? '').toLowerCase()
      return prompt.includes('organis') || prompt.includes('file type') || prompt.includes('paper') || prompt.includes('compression')
    })
    console.log(`[agent-mid-task-update] Follow-up response: ${headResponse2.slice(0, 150)}`)
    console.log(`[agent-mid-task-update] Re-spawned original task: ${respawnedOriginalTask}`)

    // ── Results ───────────────────────────────────────────────────────────────
    const output = {
      scenario1_refinement: {
        headResponse: headResponse1,
        messageAgentCalled: messageAgentCalls.length,
        messageAgentInput,
        cancelCalled,
        spawnCalled: spawnCalled.length,
        cancelAndRespawn,
        allToolCalls: r1.toolCalls.map(tc => tc.name),
      },
      scenario2_followup: {
        headResponse: headResponse2,
        respawnedOriginalTask,
        allToolCalls: r2.toolCalls.map(tc => tc.name),
      },
    }

    const history: EvalMessage[] = [
      { role: 'user', content: uv.userTask },
      { role: 'assistant', content: 'On it!' },
      { role: 'user', content: uv.refinementMessage },
      { role: 'assistant', content: headResponse1 || '(no response)' },
      { role: 'user', content: "What's the weather like today?" },
      { role: 'assistant', content: headResponse2 || '(no response)' },
    ]

    if (opts.noJudge) {
      console.log('\n[agent-mid-task-update] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`\n[agent-mid-task-update:${uv.name}] Running judge...`)
    const context = `
The agent-mid-task-update flow was tested across two sub-scenarios.
Variant: ${uv.name} — Original task: "${uv.userTask}"
The agent was seeded in RUNNING state with ID "${agentId}".

## Sub-scenario 1: User refines the running task
User message: "${uv.refinementMessage}"
The key constraint the head should pass to the agent: "${uv.keyConstraint}"
Head response to user: ${headResponse1 || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r1.toolCalls.map(tc => ({ name: tc.name, input: tc.input })))}
message_agent called: ${messageAgentCalls.length} time(s)
${messageAgentInput ? `message_agent input: ${JSON.stringify(messageAgentInput)}` : 'message_agent was NOT called.'}
${messageAgentInput ? `message_agent agentId: "${(messageAgentInput as Record<string, unknown>)['agentId']}" (expected: "${agentId}")` : ''}
cancel_agent called: ${cancelCalled}
spawn_agent called: ${spawnCalled.length} time(s)
cancel+respawn pattern: ${cancelAndRespawn}

Important: This is a REFINEMENT, not a reversal. The user is narrowing or adjusting the task, not asking for something completely different. The correct tool is message_agent — the head should push the new constraint to the running agent, not cancel and start over.

## Sub-scenario 2: Unrelated follow-up
User message: "What's the weather like today?"
Head response: ${headResponse2 || '(no response sent)'}
Tool calls: ${JSON.stringify(r2.toolCalls.map(tc => tc.name))}
Re-spawned original task: ${respawnedOriginalTask}
Note: spawning a NEW agent for the weather question is fine — only flag if the head restarts the ORIGINAL task.
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('agent-mid-task-update', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `agent-mid-task-update-${uv.name}`,
    })
    printJudgment(uv.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-mid-task-update [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
