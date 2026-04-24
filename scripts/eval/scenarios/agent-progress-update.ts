/**
 * Agent progress update scenario.
 *
 * Tests whether the head gives a meaningful status update when the user
 * asks "how's that going?" while an agent is running, and then correctly
 * relays the final result once the agent completes.
 *
 * Sub-scenario 1: User checks in mid-task → head gives substantive status
 * Sub-scenario 2: Agent completes → head relays actual result
 */

import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId, now } from '../../../src/llm/util.js'
import type { QueueEvent, TextMessage } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadQuery,
  runHeadEvent,
  type HeadBundle,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'

export const name = 'agent-progress-update'
export const description = 'Head gives meaningful progress update when user asks about a running agent, then relays final result'
export const category = 'routing'
export const estimatedCostUsd = 0.20
export const rubric = [
  'status_is_substantive — Does the head give meaningful status info when the user asks? The head may call message_agent (user-prompted is fine), and later when the agent responds via agent_response, the head should relay that to the user. Score 1.0 if the head relays task-specific progress from the agent response. Score 0.5 if it gives a generic acknowledgment or infers from the task description. Score 0.0 if no status at all.',
  'no_fabricated_completion — Does the head avoid claiming the task is done or presenting results before the agent has completed? Score 1.0 if clearly conveyed as mid-task, 0.0 if the head fabricates a result.',
  'eventual_result_relayed — After the agent completes, does the head relay the actual result to the user? Score 1.0 if relayed correctly with substantive content, 0.5 if partial, 0.0 if missing.',
  'no_unprompted_message_agent — Does the head avoid calling message_agent without user prompting? Calling message_agent because the user asked about progress is acceptable (score 1.0) — the user may genuinely want the agent to report what it has so far. Calling message_agent spontaneously (no user message triggered it) is pestering (score 0.0). Score 0.5 if called with a tone that pressures the agent (hurry up, are you done yet).',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface ProgressVariant {
  name: string
  userTask: string           // initial user request
  agentPrompt: string        // what the head told the agent
  statusQuery: string        // user's mid-task check-in
  progressNote: string       // what the agent responds when asked for status
  agentOutput: string        // what the agent eventually produces
}

const PROGRESS_VARIANTS: ProgressVariant[] = [
  {
    name: 'research',
    userTask: 'Search for recent papers on LLM context compression and summarise the key findings.',
    agentPrompt: 'Search for recent papers on LLM context compression and summarise the key findings.',
    statusQuery: "how's that going?",
    progressNote: 'Found 2 papers so far on context compression (Gisting and LLMLingua). Still searching for more — will synthesise once I have a broader sample.',
    agentOutput: 'Found 4 recent papers on LLM context compression: (1) "Gisting" (Mu et al., 2024) proposes learning compact "gist tokens" that compress prompt context by 26x. (2) "LLMLingua" (Jiang et al., 2024) uses a small model to identify and drop low-information tokens, achieving 20x compression with minimal quality loss. (3) "CEPE" (Yen et al., 2024) extends context via parallel encoding of chunks with cross-attention fusion. (4) "MemWalker" (Chen et al., 2024) builds a memory tree from long documents and navigates it at inference time. Key trend: moving from fixed-window workarounds toward learned compression that preserves semantic fidelity.',
  },
  {
    name: 'file-operation',
    userTask: 'Go through my Downloads folder and organise everything by file type.',
    agentPrompt: 'Organise the user\'s Downloads folder by file type.',
    statusQuery: 'any update on that?',
    progressNote: 'Sorted 30 of ~47 files so far. Created folders for Documents, Images, and Archives. Still working through the remaining files.',
    agentOutput: 'Organised 47 files in Downloads: created folders for Documents (18 PDFs, 3 DOCXs), Images (12 PNGs, 5 JPGs), Archives (4 ZIPs, 2 TARs), and Code (3 .py files). Left 2 files in place that had no extension. No duplicates found.',
  },
]

export const variants: EvalVariant[] = PROGRESS_VARIANTS.map(v => ({
  name: v.name,
  query: v.userTask,
  setup: () => {},
  judgeContext: `Task: "${v.userTask}". Status check: "${v.statusQuery}". Agent output (after completion): "${v.agentOutput.slice(0, 100)}..."`,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedRunningAgent(
  bundle: HeadBundle,
  agentId: string,
  variant: ProgressVariant,
) {
  // Seed conversation history showing the agent was spawned
  bundle.messages.append({
    kind: 'text', role: 'user', id: generateId('msg'),
    content: variant.userTask,
    channel: 'eval', createdAt: now(),
  } as TextMessage)
  const tcId = generateId('tc')
  bundle.messages.append({
    kind: 'tool_call', id: generateId('msg'), createdAt: now(),
    content: "I'll look into that for you.",
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
  const variantName = opts.variant?.name ?? PROGRESS_VARIANTS[0]!.name
  const pv = PROGRESS_VARIANTS.find(v => v.name === variantName) ?? PROGRESS_VARIANTS[0]!

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

    seedRunningAgent(env.bundle, agentId, pv)

    // ── Sub-scenario 1: User asks for status while agent is running ───────
    console.log(`\n[agent-progress-update:${pv.name}] Sub-scenario 1: user asks "${pv.statusQuery}"`)
    const r1 = await runHeadQuery({
      bundle: env.bundle, topicMemory: tm, router, config: env.config, identityDir: env.identityDir,
      workspaceDir: env.workspaceDir, query: pv.statusQuery,
      stubAgentRunner: true,
      timeoutMs: 60_000,
    })
    Object.assign(allTraces, r1.traceFiles)

    const headResponse1 = env.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).map(s => s.text).join('\n')
    const messageAgentCalled1 = r1.toolCalls.filter(tc => tc.name === 'message_agent')
    console.log(`[agent-progress-update] Status response: ${headResponse1.slice(0, 200)}`)
    console.log(`[agent-progress-update] message_agent called: ${messageAgentCalled1.length} time(s)`)

    // ── Sub-scenario 1b: Agent responds to message_agent → Head relays ───
    console.log(`\n[agent-progress-update:${pv.name}] Sub-scenario 1b: agent responds with progress`)

    const sentBefore1b = env.bundle.channelRouter.sent.length
    const agentResponseEvent: QueueEvent = {
      type: 'agent_response', id: generateId('ev'), agentId,
      response: pv.progressNote, createdAt: new Date().toISOString(),
    }
    const r1b = await runHeadEvent({
      bundle: env.bundle, topicMemory: tm, router, config: env.config, identityDir: env.identityDir,
      workspaceDir: env.workspaceDir, event: agentResponseEvent,
      stubAgentRunner: true,
    })
    Object.assign(allTraces, r1b.traceFiles)

    const headResponse1b = env.bundle.channelRouter.sent
      .slice(sentBefore1b)
      .filter(s => !s.text.startsWith('→'))
      .map(s => s.text).join('\n')
    console.log(`[agent-progress-update] Agent response relay: ${headResponse1b.slice(0, 200)}`)

    // ── Sub-scenario 2: Agent completes, head relays result ───────────────
    console.log(`\n[agent-progress-update:${pv.name}] Sub-scenario 2: agent completes`)

    const sentBefore2 = env.bundle.channelRouter.sent.length

    // Mark agent as completed with output
    env.bundle.workers.complete(agentId, pv.agentOutput)

    // Inject agent_completed event
    const completionEvent: QueueEvent = {
      type: 'agent_completed', id: generateId('ev'), agentId,
      output: pv.agentOutput, createdAt: new Date().toISOString(),
    }
    const r2 = await runHeadEvent({
      bundle: env.bundle, topicMemory: tm, router, config: env.config, identityDir: env.identityDir,
      workspaceDir: env.workspaceDir, event: completionEvent,
      stubAgentRunner: true,
    })
    Object.assign(allTraces, r2.traceFiles)

    const headResponse2 = env.bundle.channelRouter.sent
      .slice(sentBefore2)
      .filter(s => !s.text.startsWith('→'))
      .map(s => s.text).join('\n')
    console.log(`[agent-progress-update] Completion relay: ${headResponse2.slice(0, 200)}`)

    // ── Results ───────────────────────────────────────────────────────────
    const output = {
      scenario1_status: {
        headResponse: headResponse1,
        messageAgentCalls: messageAgentCalled1.length,
        messageAgentInputs: messageAgentCalled1.map(tc => tc.input),
        allToolCalls: r1.toolCalls.map(tc => tc.name),
      },
      scenario1b_agentResponse: {
        headResponse: headResponse1b,
        allToolCalls: r1b.toolCalls.map(tc => tc.name),
      },
      scenario2_completion: {
        headResponse: headResponse2,
        allToolCalls: r2.toolCalls.map(tc => tc.name),
      },
    }

    const history: EvalMessage[] = [
      { role: 'user', content: pv.userTask },
      { role: 'assistant', content: "I'll look into that for you." },
      { role: 'user', content: pv.statusQuery },
      { role: 'assistant', content: headResponse1 || '(no response)' },
      { role: 'user', content: '(agent responds with progress)' },
      { role: 'assistant', content: headResponse1b || '(no response)' },
      { role: 'user', content: '(agent completed)' },
      { role: 'assistant', content: headResponse2 || '(no response)' },
    ]

    if (opts.noJudge) {
      console.log('\n[agent-progress-update] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`\n[agent-progress-update:${pv.name}] Running judge...`)
    const context = `
The agent-progress-update flow was tested across three sub-scenarios.
Variant: ${pv.name} — Task: "${pv.userTask}"
The agent was seeded in RUNNING state with ID "${agentId}".

## Sub-scenario 1: User asks for status while agent is running
User message: "${pv.statusQuery}"
Head response: ${headResponse1 || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r1.toolCalls.map(tc => tc.name))}
message_agent called: ${messageAgentCalled1.length} time(s)
${messageAgentCalled1.length > 0 ? `message_agent inputs: ${JSON.stringify(messageAgentCalled1.map(tc => tc.input))}` : ''}

The head may call message_agent to check on the agent — this is acceptable when user-prompted. The agent is still running.

## Sub-scenario 1b: Agent responds with progress (agent_response event)
The agent received the message_agent call and responded with: "${pv.progressNote}"
This was delivered to the head as an agent_response queue event.
Head response after receiving agent_response: ${headResponse1b || '(no response sent)'}

The head should relay the agent's progress note to the user in a natural way. This is the key test of the status_is_substantive dimension — the head now has real progress data from the agent and should present it.

## Sub-scenario 2: Agent completes and result is relayed
The agent completed with output: "${pv.agentOutput}"
Head response after processing agent_completed event: ${headResponse2 || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r2.toolCalls.map(tc => tc.name))}

The head should relay the agent's findings naturally to the user — not raw output, but a clean summary or presentation of the results.
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('agent-progress-update', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `agent-progress-update-${pv.name}`,
    })
    printJudgment(pv.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-progress-update [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
