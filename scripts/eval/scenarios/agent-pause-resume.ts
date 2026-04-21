/**
 * Agent pause/resume scenario.
 *
 * Tests the full flow when an agent pauses and asks a question:
 *   1. Head should relay the question to the user (not answer on its own)
 *   2. Head should NOT call resume_agent without user input
 *   3. When the user replies, head should call resume_agent with the user's answer
 *   4. Resume judge should reject non-answers (head fabricating or stalling)
 *   5. Multi-turn: agent stays suspended through a discussion before the answer
 *   6. User says "skip it" — legitimate instruction should pass through
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
  type EvalEnvironment,
  type HeadBundle,
  runHeadEvent,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'

export const name = 'agent-pause-resume'
export const description = 'Head relays paused agent questions to user and waits for real answer before resuming (variants: credentials, permission, preference, folder-cleanup)'
export const category = 'routing'
export const estimatedCostUsd = 0.25
export const rubric = [
  'relays_question — When the agent pauses with a question, does the head relay it to the user in its response? Score 1.0 if the head\'s response asks the user for the information the agent needs, 0.5 if vague, 0.0 if the head ignores the question or tries to answer it itself.',
  'no_premature_resume — The head should NOT call resume_agent in the same activation as receiving the pause trigger (no user input yet). Score 1.0 if resume_agent was not called, 0.0 if it was called.',
  'resumes_with_user_answer — After the user provides the answer, the head should call resume_agent with information from the user\'s message. Score 1.0 if resume_agent was called with the user\'s answer, 0.5 if called but with different content, 0.0 if not called.',
  'multi_turn_stays_suspended — During a multi-turn discussion before answering, the agent should remain suspended (resume_agent not called until a real answer). Score 1.0 if the head engages naturally without calling resume_agent during the discussion, 0.0 if it tries to resume prematurely.',
  'skip_passes_through — When the user explicitly says to skip or provides a default answer, resume_agent should be called (the resume judge should not block legitimate user directives). Score 1.0 if resume_agent was called with the substance of what the user said (exact wording not required — extracting the key information is fine), 0.0 if blocked or not called.',
  'head_answers_from_knowledge — (folder-cleanup variant only; score 1.0 for other variants.) When the user asks a follow-up the head can answer from its own context (e.g. "What\'s in each folder?"), does the head provide a substantive answer rather than deflecting or just saying the agent is waiting? Score 1.0 if the head gives a real answer drawing on seeded knowledge, 0.5 if partial or hedged, 0.0 if it deflects, says it doesn\'t know, or just repeats that the agent needs an answer.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface PauseResumeVariant {
  name: string
  userTask: string         // initial user request
  agentPrompt: string      // what the head told the agent
  question: string         // what the agent asks (pauses with)
  answer: string           // user's answer to resume with
  clarifyingQuestion: string  // user asks this instead of answering (multi-turn test)
  skipMessage: string      // user says to skip/use default
  /** Optional second follow-up before the answer (for extended multi-turn discussion). */
  secondFollowUp?: string
  /** Optional knowledge to seed into USER.md so the head can answer clarifying questions. */
  seededKnowledge?: string
}

const PAUSE_VARIANTS: PauseResumeVariant[] = [
  {
    name: 'credentials',
    userTask: 'Set up my email please',
    agentPrompt: 'Set up email for the user.',
    question: 'What is your email provider? (Gmail, Outlook, Yahoo, or other)',
    answer: 'Gmail',
    clarifyingQuestion: 'Which one do you recommend for a business?',
    skipMessage: 'Just skip that step and use Gmail as the default',
  },
  {
    name: 'permission',
    userTask: 'Clean up the old config files from last migration',
    agentPrompt: 'Clean up old config files from the migration.',
    question: 'I found 12 config files from the old system. Should I delete them all, or keep backups?',
    answer: 'Delete them all, we have backups in git',
    clarifyingQuestion: 'How much disk space would we save?',
    skipMessage: 'Just delete them, I trust your judgment',
  },
  {
    name: 'preference',
    userTask: 'Generate the quarterly report',
    agentPrompt: 'Generate the quarterly report.',
    question: 'What format do you want the report in — PDF, CSV, or both?',
    answer: 'PDF please',
    clarifyingQuestion: 'Which format is easier to share with the board?',
    skipMessage: 'Just do PDF, that works for everything',
  },
  {
    name: 'folder-cleanup',
    userTask: "Can you clean up my documents folder? It's gotten really messy.",
    agentPrompt: "Clean up the user's documents folder.",
    question: 'I can see several folders with ambiguous names — final_v2, archive_old, temp_DO_NOT_DELETE, misc_2023, and backup_backup. Which ones are safe to delete or consolidate?',
    answer: 'Delete misc_2023 and backup_backup, archive everything else.',
    clarifyingQuestion: "What's actually in each of those folders?",
    skipMessage: "Just use your best judgment and don't delete anything, only reorganise.",
    secondFollowUp: "Which ones haven't been touched in over a year?",
    seededKnowledge: `## Documents folder layout

- **final_v2/** — Contains the final draft of the Q3 strategy deck (PowerPoint + PDF export). Last modified 2025-08-15.
- **archive_old/** — Old project proposals from 2024, mostly superseded. Last modified 2024-11-02.
- **temp_DO_NOT_DELETE/** — Scratch space for the data pipeline migration. Still has active config files referenced by cron jobs. Last modified 2026-03-28.
- **misc_2023/** — Random downloads and screenshots from 2023. Nothing important. Last modified 2023-12-19.
- **backup_backup/** — Duplicate of a Time Machine snapshot that was accidentally copied locally. 4.2 GB. Last modified 2024-06-10.`,
  },
]

export const variants: EvalVariant[] = PAUSE_VARIANTS.map(v => ({
  name: v.name,
  query: v.userTask,
  setup: () => {},
  judgeContext: `Agent asks: "${v.question}". User answers: "${v.answer}". Skip message: "${v.skipMessage}".${v.seededKnowledge ? ` Seeded knowledge: ${v.seededKnowledge.slice(0, 200)}...` : ''}`,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedConversation(bundle: HeadBundle, agentId: string, question: string, userTask: string, agentPrompt: string) {
  bundle.messages.append({
    kind: 'text', role: 'user', id: generateId('msg'),
    content: userTask,
    channel: 'eval', createdAt: now(),
  } as TextMessage)
  const tcId = generateId('tc')
  bundle.messages.append({
    kind: 'tool_call', id: generateId('msg'), createdAt: now(),
    content: 'On it!',
    toolCalls: [{ id: tcId, name: 'spawn_agent', input: { prompt: agentPrompt } }],
  } as any)
  bundle.messages.append({
    kind: 'tool_result', id: generateId('msg'), createdAt: now(),
    toolResults: [{ toolCallId: tcId, name: 'spawn_agent', content: JSON.stringify({ agentId }) }],
  } as any)
  bundle.workers.create(agentId, { prompt: agentPrompt, trigger: 'manual' })
  bundle.workers.suspend(agentId, [], question)
}

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variantName = opts.variant?.name ?? PAUSE_VARIANTS[0]!.name
  const pv = PAUSE_VARIANTS.find(v => v.name === variantName) ?? PAUSE_VARIANTS[0]!

  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envConfig = {
    contextWindowTokens: 200_000,
    archivalThresholdFraction: 0.99,
    llmMaxTokens: 2048,
  }

  // If the variant has seeded knowledge, include it in identity overrides
  const identityOverrides: Record<string, string> | undefined = pv.seededKnowledge
    ? { 'USER.md': pv.seededKnowledge }
    : undefined

  const makeEnvForVariant = () => makeProductionEnvironment({
    config: envConfig,
    ...(identityOverrides ? { identityFiles: identityOverrides } : {}),
  })

  const envs: EvalEnvironment[] = []
  const allTraces: Record<string, string> = {}
  try {
    const question = pv.question

    // ── Sub-scenario 1 & 2: Relay + no premature resume, then resume with answer ──
    console.log(`\n[agent-pause-resume:${pv.name}] Sub-scenario 1: agent pauses with question`)
    const env1 = makeEnvForVariant()
    envs.push(env1)
    const tm1 = createTopicMemory(path.join(env1.workspaceDir, 'topics'), llm)
    const agentId1 = generateId('agent')
    seedConversation(env1.bundle, agentId1, question, pv.userTask, pv.agentPrompt)

    const pauseEvent: QueueEvent = {
      type: 'agent_question', id: generateId('ev'), agentId: agentId1,
      question, createdAt: new Date().toISOString(),
    }
    const r1 = await runHeadEvent({ bundle: env1.bundle, topicMemory: tm1, router, config: env1.config, identityDir: env1.identityDir, workspaceDir: env1.workspaceDir, event: pauseEvent, stubAgentRunner: true })
    Object.assign(allTraces, r1.traceFiles)

    const headResponse1 = env1.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).map(s => s.text).join('\n')
    const calledResume1 = r1.toolCalls.some(tc => tc.name === 'resume_agent')
    console.log(`[agent-pause-resume] Head response: ${headResponse1.slice(0, 150)}`)
    console.log(`[agent-pause-resume] Called resume_agent: ${calledResume1}`)

    console.log(`\n[agent-pause-resume:${pv.name}] Sub-scenario 2: user provides answer`)
    const r2 = await runHeadQuery({ bundle: env1.bundle, topicMemory: tm1, router, config: env1.config, identityDir: env1.identityDir, workspaceDir: env1.workspaceDir, query: pv.answer, stubAgentRunner: true, timeoutMs: 60_000 })
    Object.assign(allTraces, r2.traceFiles)

    const headResponse2 = env1.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).slice(-3).map(s => s.text).join('\n')
    const resumeCall2 = r2.toolCalls.find(tc => tc.name === 'resume_agent')
    const resumeAnswer2 = resumeCall2?.input?.['answer'] as string ?? ''
    console.log(`[agent-pause-resume] Called resume_agent: ${!!resumeCall2}, answer: ${resumeAnswer2.slice(0, 80)}`)

    // ── Sub-scenario 3: Multi-turn discussion ─────────────────────────────────
    console.log(`\n[agent-pause-resume:${pv.name}] Sub-scenario 3: multi-turn discussion before answering`)
    const env3 = makeEnvForVariant()
    envs.push(env3)
    const tm3 = createTopicMemory(path.join(env3.workspaceDir, 'topics'), llm)
    const agentId3 = generateId('agent')
    seedConversation(env3.bundle, agentId3, question, pv.userTask, pv.agentPrompt)

    // Inject the pause event
    const pauseEvent3: QueueEvent = {
      type: 'agent_question', id: generateId('ev'), agentId: agentId3,
      question, createdAt: new Date().toISOString(),
    }
    const r3a = await runHeadEvent({ bundle: env3.bundle, topicMemory: tm3, router, config: env3.config, identityDir: env3.identityDir, workspaceDir: env3.workspaceDir, event: pauseEvent3, stubAgentRunner: true })
    Object.assign(allTraces, r3a.traceFiles)

    // User asks a clarifying question instead of answering
    const r3b = await runHeadQuery({ bundle: env3.bundle, topicMemory: tm3, router, config: env3.config, identityDir: env3.identityDir, workspaceDir: env3.workspaceDir, query: pv.clarifyingQuestion, stubAgentRunner: true, timeoutMs: 60_000 })
    Object.assign(allTraces, r3b.traceFiles)

    const calledResumeDuringDiscussion = r3b.toolCalls.some(tc => tc.name === 'resume_agent')
    const discussionResponse = env3.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).slice(-2).map(s => s.text).join('\n')
    console.log(`[agent-pause-resume] Discussion response: ${discussionResponse.slice(0, 150)}`)
    console.log(`[agent-pause-resume] Called resume_agent during discussion: ${calledResumeDuringDiscussion}`)

    // Optional second follow-up (folder-cleanup variant extends the multi-turn discussion)
    let secondFollowUpResponse = ''
    let calledResumeDuringSecondFollowUp = false
    if (pv.secondFollowUp) {
      console.log(`[agent-pause-resume:${pv.name}] Sub-scenario 3b: second follow-up "${pv.secondFollowUp.slice(0, 60)}"`)
      const r3c = await runHeadQuery({ bundle: env3.bundle, topicMemory: tm3, router, config: env3.config, identityDir: env3.identityDir, workspaceDir: env3.workspaceDir, query: pv.secondFollowUp, stubAgentRunner: true, timeoutMs: 60_000 })
      Object.assign(allTraces, r3c.traceFiles)
      calledResumeDuringSecondFollowUp = r3c.toolCalls.some(tc => tc.name === 'resume_agent')
      secondFollowUpResponse = env3.bundle.channelRouter.sent.filter(s => !s.text.startsWith('→')).slice(-2).map(s => s.text).join('\n')
      console.log(`[agent-pause-resume] Second follow-up response: ${secondFollowUpResponse.slice(0, 150)}`)
      console.log(`[agent-pause-resume] Called resume_agent during second follow-up: ${calledResumeDuringSecondFollowUp}`)
    }

    // ── Sub-scenario 4: User says skip ────────────────────────────────────────
    console.log(`\n[agent-pause-resume:${pv.name}] Sub-scenario 4: user says skip`)
    const env4 = makeEnvForVariant()
    envs.push(env4)
    const tm4 = createTopicMemory(path.join(env4.workspaceDir, 'topics'), llm)
    const agentId4 = generateId('agent')
    seedConversation(env4.bundle, agentId4, question, pv.userTask, pv.agentPrompt)

    const pauseEvent4: QueueEvent = {
      type: 'agent_question', id: generateId('ev'), agentId: agentId4,
      question, createdAt: new Date().toISOString(),
    }
    await runHeadEvent({ bundle: env4.bundle, topicMemory: tm4, router, config: env4.config, identityDir: env4.identityDir, workspaceDir: env4.workspaceDir, event: pauseEvent4, stubAgentRunner: true })

    // User explicitly says skip
    const r4 = await runHeadQuery({ bundle: env4.bundle, topicMemory: tm4, router, config: env4.config, identityDir: env4.identityDir, workspaceDir: env4.workspaceDir, query: pv.skipMessage, stubAgentRunner: true, timeoutMs: 60_000 })
    Object.assign(allTraces, r4.traceFiles)

    const resumeCall4 = r4.toolCalls.find(tc => tc.name === 'resume_agent')
    const resumeAnswer4 = resumeCall4?.input?.['answer'] as string ?? ''
    console.log(`[agent-pause-resume] Called resume_agent: ${!!resumeCall4}, answer: ${resumeAnswer4.slice(0, 80)}`)

    // ── Results ───────────────────────────────────────────────────────────────
    const output = {
      scenario1_relay: { headResponse: headResponse1, calledResume: calledResume1 },
      scenario2_resume: { headResponse: headResponse2, calledResume: !!resumeCall2, resumeAnswer: resumeAnswer2 },
      scenario3_multiturn: { discussionResponse, calledResumeDuringDiscussion, secondFollowUpResponse, calledResumeDuringSecondFollowUp },
      scenario4_skip: { calledResume: !!resumeCall4, resumeAnswer: resumeAnswer4 },
    }

    const history: EvalMessage[] = [
      { role: 'user', content: pv.userTask },
      { role: 'assistant', content: headResponse1 || '(no response)' },
      { role: 'user', content: pv.answer },
      { role: 'assistant', content: headResponse2 || '(no response)' },
    ]

    if (opts.noJudge) {
      console.log('\n[agent-pause-resume] OUTPUT (--no-judge mode):')
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`\n[agent-pause-resume:${pv.name}] Running judge...`)
    const context = `
The agent-pause-resume flow was tested across four sub-scenarios.
Variant: ${pv.name} — User task: "${pv.userTask}", Agent question: "${pv.question}"

## Sub-scenario 1: Agent pauses with a question
The agent paused and asked: "${question}"
Head response to user: ${headResponse1 || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r1.toolCalls.map(tc => tc.name))}
Did head call resume_agent: ${calledResume1}

## Sub-scenario 2: User provides answer
User message: "${pv.answer}"
Head response: ${headResponse2 || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r2.toolCalls.map(tc => tc.name))}
Did head call resume_agent: ${!!resumeCall2}
${resumeAnswer2 ? `Answer passed to resume_agent: "${resumeAnswer2}"` : 'resume_agent was NOT called'}

## Sub-scenario 3: Multi-turn discussion before answering
User asked a clarifying question instead of answering: "${pv.clarifyingQuestion}"
Head response: ${discussionResponse || '(no response sent)'}
Tool calls made by head: ${JSON.stringify(r3b.toolCalls.map(tc => tc.name))}
Did head call resume_agent during discussion: ${calledResumeDuringDiscussion}
${pv.secondFollowUp ? `
User asked a second follow-up: "${pv.secondFollowUp}"
Head response: ${secondFollowUpResponse || '(no response sent)'}
Did head call resume_agent during second follow-up: ${calledResumeDuringSecondFollowUp}
` : ''}${pv.seededKnowledge ? `
SEEDED KNOWLEDGE (available in USER.md — the head should be able to answer from this):
${pv.seededKnowledge}
` : ''}
## Sub-scenario 4: User says skip
User message: "${pv.skipMessage}"
Tool calls made by head: ${JSON.stringify(r4.toolCalls.map(tc => tc.name))}
Did head call resume_agent: ${!!resumeCall4}
${resumeAnswer4 ? `Answer passed to resume_agent: "${resumeAnswer4}"` : 'resume_agent was NOT called'}
`
    const judgment = await judge(rubric, context)
    const txtPath = await writeResults('agent-pause-resume', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `agent-pause-resume-${pv.name}`,
    })
    printJudgment(pv.name, judgment, txtPath)
  } finally {
    for (const env of envs) cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-pause-resume [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
