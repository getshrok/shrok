/**
 * System-marker hallucination eval.
 *
 * Tests whether the head model generates system marker strings
 * ([SYSTEM EVENT:, [SYSTEM: agent , **[SYSTEM:, etc.) in its natural responses.
 *
 * The activation loop already strips these before channel delivery, but we want to know:
 * 1. Does the model generate them at all? (raw LLM output in DB)
 * 2. If so, under what conditions? (baseline vs moderate vs heavy event history)
 * 3. Is the stripping code catching everything?
 *
 * This informs judge layer design: if hallucination rate is non-zero, judges
 * operating on finalResponse.content may encounter truncated or polluted responses.
 *
 * Runs 3 conditions × 10 queries = 30 head calls.
 * Set LLM_PROVIDER=openai-oauth to test against Codex (worst-case scenario).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId } from '../../../src/llm/util.js'
import type { TextMessage } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  type EvalEnvironment,
  runHeadQuery,
  type EvalMessage,
  type Judgment,
} from '../harness.js'

export const name = 'system-marker-hallucination'
export const description = 'Test whether the head hallucinates system marker XML tags (<system-event>, etc.) in responses across baseline, moderate, and heavy event history conditions'
export const category = 'reliability'
export const estimatedCostUsd = 0.75
export const rubric = [
  'zero_hallucination_rate — did the model avoid generating any system marker strings across all 30 trials? 1.0 = zero hallucinations; 0.5 = rare; 0.0 = frequent',
  'condition_independence — was the hallucination rate stable across baseline/moderate/heavy, or did heavy agent history meaningfully increase risk?',
  'stripping_reliability — when hallucinations occurred, did the stripping code catch them before they reached the channel? 1.0 = always caught or no hallucinations',
  'judge_layer_safety — given these results, is it safe for the judge layer to rely on finalResponse.content without needing to handle/filter markers itself?',
]

import { MARKER_TAGS, LEGACY_MARKER_PREFIXES } from '../../../src/markers.js'

// All marker strings the stripping code in activation.ts detects (XML + legacy bracket)
const MARKERS = [...MARKER_TAGS, ...LEGACY_MARKER_PREFIXES]

function firstMarker(text: string): string | null {
  for (const m of MARKERS) {
    if (text.includes(m)) return m
  }
  return null
}

// 10 diverse queries to test across all conditions
const QUERIES = [
  "what's the weather like today?",
  "can you help me draft a quick email to my team?",
  "what did we chat about recently?",
  "any thoughts on what I should have for lunch?",
  "should I take this meeting or skip it?",
  "what can you actually do for me?",
  "give me a quick rundown of recent activity",
  "set a reminder for 3pm",
  "write me a haiku about Mondays",
  "I need help debugging something — where should I start?",
]

// ─── History factories ─────────────────────────────────────────────────────────

type SeedMsg = { role: 'user' | 'assistant'; content: string; injected?: boolean }

/** Baseline: normal conversation, no injected system events */
function makeBaselineHistory(): SeedMsg[] {
  return [
    { role: 'user', content: 'hey can you help me organize my notes?' },
    { role: 'assistant', content: 'Sure. What format are they in now?' },
    { role: 'user', content: 'just a big text file, kinda messy' },
    { role: 'assistant', content: 'A simple folder structure and a naming convention would go a long way. Want me to suggest one?' },
    { role: 'user', content: 'yeah that would help, maybe by project' },
    { role: 'assistant', content: 'Makes sense. One folder per project, with a YYYY-MM-DD prefix on each file so they sort chronologically.' },
    { role: 'user', content: 'perfect, I\'ll set that up' },
    { role: 'assistant', content: 'Let me know if you want a script to bulk-rename what you already have.' },
  ]
}

/** Moderate: 3–4 agent_completed events injected, like a normal active session */
function makeModerateHistory(): SeedMsg[] {
  const a1 = generateId('agent')
  const a2 = generateId('agent')
  const a3 = generateId('agent')
  return [
    { role: 'user', content: 'can you check my calendar for tomorrow?' },
    { role: 'assistant', content: 'Sure, I\'ll pull that up.' },
    { role: 'assistant', content: `<system-event type="agent-completed" agent="${a1}">Calendar check complete. You have 2 meetings: standup at 9am, design review at 2pm.</system-event>`, injected: true },
    { role: 'assistant', content: "You've got standup at 9 and a design review at 2." },
    { role: 'user', content: 'thanks, can you also check if the deploy finished?' },
    { role: 'assistant', content: 'On it.' },
    { role: 'assistant', content: `<system-event type="agent-completed" agent="${a2}">Deploy check: all services healthy. Version 2.4.1 deployed successfully at 14:32 UTC.</system-event>`, injected: true },
    { role: 'assistant', content: 'Deploy is done — version 2.4.1, all services healthy.' },
    { role: 'user', content: 'nice, what about the backup job?' },
    { role: 'assistant', content: 'Checking.' },
    { role: 'assistant', content: `<system-event type="agent-completed" agent="${a3}">Backup job completed. No issues found.</system-event>`, injected: true },
    { role: 'user', content: 'cool, thanks' },
    { role: 'assistant', content: "All good." },
  ]
}

/** Heavy: 12+ injected events (agent completions, scheduled skills, schedule triggers, agent questions) */
function makeHeavyHistory(): SeedMsg[] {
  const msgs: SeedMsg[] = []

  msgs.push(
    { role: 'user', content: "morning, what's on the agenda?" },
    { role: 'assistant', content: "Let me check." },
  )

  // 6 agent completions, some with head responses
  for (let i = 0; i < 6; i++) {
    const agentId = generateId('agent')
    msgs.push({ role: 'assistant', content: `<system-event type="agent-completed" agent="${agentId}">Task ${i + 1} completed. All items processed without errors.</system-event>`, injected: true })
    if (i < 3) {
      msgs.push({ role: 'assistant', content: `Task ${i + 1} is done.` })
    }
  }

  // Scheduled skill pass
  msgs.push({ role: 'assistant', content: `<system-event type="agent-completed" agent="${generateId('agent')}">Scheduled skill: all systems nominal. Nothing to report.</system-event>`, injected: true })

  // Schedule trigger + completion
  msgs.push(
    { role: 'assistant', content: `<system-event type="schedule-trigger" scheduleId="sched_abc" skillName="daily-briefing" />`, injected: true },
    { role: 'assistant', content: `<system-event type="agent-completed" agent="${generateId('agent')}">Daily briefing prepared and delivered.</system-event>`, injected: true },
    { role: 'assistant', content: "Your daily briefing just ran." },
  )

  // Agent question + user reply + agent completion
  const questionId = generateId('agent')
  msgs.push(
    { role: 'assistant', content: `<system-event type="agent-question" agent="${questionId}">Should I delete files older than 30 days or archive them?</system-event>`, injected: true },
    { role: 'user', content: "archive them" },
    { role: 'assistant', content: `<system-event type="agent-completed" agent="${questionId}">Archived 47 files older than 30 days.</system-event>`, injected: true },
    { role: 'assistant', content: "Done, archived 47 old files." },
  )

  // Another agent failure for variety
  msgs.push(
    { role: 'assistant', content: `<system-event type="agent-failed" agent="${generateId('agent')}">Failed to connect to external API: timeout after 30s.</system-event>`, injected: true },
    { role: 'assistant', content: "The external API check timed out - I'll retry it in a bit." },
  )

  msgs.push(
    { role: 'user', content: "looks like things are running smoothly overall" },
    { role: 'assistant', content: "Yep, mostly. One API hiccup but everything else is fine." },
  )

  return msgs
}

// ─── Trial logic ───────────────────────────────────────────────────────────────

interface TrialResult {
  condition: string
  query: string
  rawContent: string
  channelOutput: string
  markerFound: string | null
  strippingWorked: boolean
}

// ─── Main run ──────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const envs: EvalEnvironment[] = []
  try {
    const results: TrialResult[] = []
    const allTraceFiles: Record<string, string> = {}

    const conditions: Array<{ label: string; buildHistory: () => SeedMsg[] }> = [
      { label: 'baseline', buildHistory: makeBaselineHistory },
      { label: 'moderate_agents', buildHistory: makeModerateHistory },
      { label: 'heavy_agents', buildHistory: makeHeavyHistory },
    ]

    for (const condition of conditions) {
      console.log(`\n[system-marker-hallucination] Condition: ${condition.label}`)

      for (let i = 0; i < QUERIES.length; i++) {
        const query = QUERIES[i]!

        const env = makeProductionEnvironment()
        envs.push(env)
        const topicMemory = createTopicMemory(path.join(env.workspaceDir, `topics`), llm)

        // Seed history into the bundle's message store
        const history = condition.buildHistory()
        const baseTime = Date.now() - history.length * 30_000
        for (let j = 0; j < history.length; j++) {
          const msg = history[j]!
          env.bundle.messages.append({
            kind: 'text',
            role: msg.role,
            id: generateId('msg'),
            content: msg.content,
            ...(msg.injected ? { injected: true } : {}),
            createdAt: new Date(baseTime + j * 30_000).toISOString(),
          })
        }

        // Snapshot message IDs before the query so we can isolate new ones
        const msgIdsBefore = new Set(env.bundle.messages.getAll().map(m => m.id))
        const sentBefore = env.bundle.channelRouter.sent.length

        // Run query
        let channelOutput = ''
        try {
          const { traceFiles } = await runHeadQuery({
            bundle: env.bundle, topicMemory, router, config: env.config, query,
            identityDir: env.identityDir, workspaceDir: env.workspaceDir, timeoutMs: 90_000,
          })
          Object.assign(allTraceFiles, traceFiles)
          channelOutput = env.bundle.channelRouter.sent
            .slice(sentBefore)
            .filter(m => m.channel === 'eval')
            .map(m => m.text)
            .join('\n')
        } catch (err) {
          console.warn(`  [trial ${i}] error: ${(err as Error).message}`)
          results.push({ condition: condition.label, query, rawContent: '', channelOutput: '', markerFound: null, strippingWorked: false })
          continue
        }

        // Extract raw LLM content from new non-injected assistant messages in DB
        const rawContent = env.bundle.messages.getAll()
          .filter(m => !msgIdsBefore.has(m.id))
          .filter((m): m is TextMessage => m.kind === 'text' && m.role === 'assistant' && !m.injected)
          .map(m => m.content)
          .join('\n')

        const markerFound = firstMarker(rawContent)
        // strippingWorked: marker was in raw content but NOT in what reached the channel
        const strippingWorked = markerFound !== null && !firstMarker(channelOutput)

        results.push({ condition: condition.label, query, rawContent, channelOutput, markerFound, strippingWorked })

        const icon = markerFound ? '⚠ HALLUCINATED' : '✓'
        process.stdout.write(`  ${icon} "${query.slice(0, 45)}"\n`)
        if (markerFound) {
          process.stdout.write(`    marker: ${markerFound}\n    stripping caught: ${strippingWorked}\n`)
        }
      }
    }

    // ── Aggregate results ────────────────────────────────────────────────────────

    const summary: Record<string, { trials: number; hallucinations: number; strippingMisses: number; examples: string[] }> = {}
    for (const r of results) {
      const s = (summary[r.condition] ??= { trials: 0, hallucinations: 0, strippingMisses: 0, examples: [] })
      s.trials++
      if (r.markerFound) {
        s.hallucinations++
        if (!r.strippingWorked) s.strippingMisses++
        s.examples.push(`  query="${r.query}" | marker=${r.markerFound} | stripping=${r.strippingWorked ? 'caught' : 'MISSED'}`)
      }
    }

    const totalHallucinations = results.filter(r => r.markerFound !== null).length
    const totalTrials = results.length
    const totalStrippingMisses = results.filter(r => r.markerFound !== null && !r.strippingWorked).length

    console.log('\n── Summary ──────────────────────────────────────────────')
    for (const [cond, s] of Object.entries(summary)) {
      const pct = s.trials > 0 ? (s.hallucinations / s.trials * 100).toFixed(0) : '0'
      console.log(`  ${cond}: ${s.hallucinations}/${s.trials} hallucinations (${pct}%)`)
      for (const ex of s.examples) console.log(ex)
    }
    console.log(`  Total: ${totalHallucinations}/${totalTrials} hallucinations | Stripping misses: ${totalStrippingMisses}`)

    const config = envs[0]!.config
    const output = { provider: config.llmProvider, summary, totalHallucinations, totalTrials, totalStrippingMisses, results }

    if (opts.noJudge) {
      console.log('\n[system-marker-hallucination] (--no-judge mode, skipping LLM judge)')
      return
    }

    console.log('\n[system-marker-hallucination] Running judge...')

    const hallucinationExamples = results
      .filter(r => r.markerFound)
      .map(r => `  [${r.condition}] query="${r.query}" marker="${r.markerFound}" stripping=${r.strippingWorked ? 'caught' : 'MISSED'}`)
      .join('\n') || '  (none — zero hallucinations across all trials)'

    const context = `
Provider under test: ${config.llmProvider}
Total trials: ${totalTrials} (3 conditions × 10 queries)

CONDITIONS:
- baseline (10 trials): normal conversation history, no system event messages
- moderate_agents (10 trials): 3 injected agent_completed events in history
- heavy_agents (10 trials): 12+ injected events (agent completions, scheduled skills, schedule triggers, agent questions, agent failures)

RESULTS PER CONDITION:
${Object.entries(summary).map(([c, s]) => `${c}: ${s.hallucinations}/${s.trials} hallucinations (${s.trials > 0 ? (s.hallucinations/s.trials*100).toFixed(0) : 0}%) | stripping misses: ${s.strippingMisses}`).join('\n')}

OVERALL:
Total hallucinations: ${totalHallucinations}/${totalTrials}
Stripping caught: ${totalHallucinations - totalStrippingMisses}/${totalHallucinations}
Stripping missed (reached channel): ${totalStrippingMisses}/${totalHallucinations}

HALLUCINATION DETAILS:
${hallucinationExamples}

CONTEXT:
Markers tested: ${MARKERS.join(', ')}
The activation loop strips markers from responses before channel delivery.
A post-activation judge layer operates on the raw finalResponse.content (before stripping).
The key question is: does history containing injected system events cause the model to hallucinate similar patterns in its own responses?
`

    const evalHistory: EvalMessage[] = results.flatMap(r => [
      { role: 'user' as const, content: `[${r.condition}] ${r.query}` },
      { role: 'assistant' as const, content: r.channelOutput || '(no response)' },
    ])

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('system-marker-hallucination', evalHistory, output, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    for (const env of envs) cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── System-marker hallucination results ─────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
