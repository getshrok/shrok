/**
 * Scenario — Multi-Hop Memory
 *
 * A 3-hop fact chain is distributed across three separate archived sessions:
 *   Session 1: Priya Nair leads the "Cobalt" team (org structure session)
 *   Session 2: Cobalt team is building the event streaming backbone on Kafka (scoping session)
 *   Session 3: The event system uses 3 brokers, RF=3, lag threshold 10K (technical deep-dive)
 *
 * The entity names change between sessions (Priya → Cobalt team → "the event system"),
 * so no single keyword can bridge all three hops.
 *
 * Query: "What infrastructure is Priya's team running, and what are the key operational parameters?"
 *
 * Pass criteria: Response correctly chains Priya → Cobalt → Kafka event system with specific params.
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
  LEAN_EVAL_CONFIG,
  type EvalMessage,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'multi-hop-memory'
export const description = '3-hop chain across 3 archived sessions (Priya→Cobalt team→Kafka event system) — entity names change each session, no keyword shortcut'
export const category = 'memory'
export const estimatedCostUsd = 0.35
export const rubric = [
  'priya_to_cobalt_linked — response correctly connects Priya Nair to the Cobalt platform team?',
  'cobalt_to_kafka_linked — response mentions Kafka or event streaming as the Cobalt team\'s domain? IMPORTANT: check the MEMORY CONTEXT SHOWN TO HEAD section — if Kafka/Cobalt ownership details were present in the memory context (even as a summary), note that explicitly: "Head had this information in its context and did not use it" or "Head did not have this information in its context." This distinction matters for diagnosing retrieval vs generation failures.',
  'operational_params_recalled — response surfaces at least one specific operational parameter (broker count, replication factor, or lag threshold)? IMPORTANT: same as above — check whether the parameters were present in the MEMORY CONTEXT SHOWN TO HEAD and note whether this is a retrieval gap or a generation gap.',
  'chain_coherent — response reads as a coherent answer drawing on multiple memory sources, not a single isolated fact? Note how many of the memory context topics the response actually drew from vs how many were available.',
]

const SESSION_1_SEED = `An org design conversation. The user is an engineering director mapping out
team ownership and reporting lines across several platform teams.

Key facts to establish clearly:
- Priya Nair leads the "Cobalt" platform team (she reports to the director directly)
- Marcus Thompson leads the "Apex" data infrastructure team
- Leila Okonkwo leads the "Forge" developer tooling team

IMPORTANT: Do NOT discuss what the Cobalt team actually builds or what technology they use.
The conversation is purely about org structure, headcount, and reporting lines.
Priya's team size is 5 engineers including her. The conversation involves the director
figuring out who owns what at an org level — not what those teams are building technically.
Include questions about team boundaries, on-call responsibilities, and budget headcount.`

const SESSION_2_SEED = `A project scoping conversation. The Cobalt platform team has been asked
to build the company's internal event streaming backbone — a central pub/sub infrastructure
used by all other engineering teams.

Key facts to establish:
- The Cobalt team is building the event streaming backbone using Apache Kafka
- Architecture decisions: 12 partitions per topic (standard), retention policy of 7 days
- Schema management: Confluent Schema Registry (Avro schemas, compatibility mode: BACKWARD)
- Team working on it: the Cobalt platform team, 4 engineers plus their lead
- Timeline: first internal consumer to onboard is the analytics pipeline team in 8 weeks

IMPORTANT: Do NOT mention Priya by name — refer only to "the Cobalt team" or "they."
The conversation involves a technical lead scoping the work, discussing tradeoffs between
Kafka and alternatives (Pulsar was rejected, NATS was too lightweight), and planning
the rollout approach. The work is clearly owned by Cobalt.`

const SESSION_3_SEED = `A technical deep-dive into an internal event streaming system.
A senior engineer is reviewing the operational configuration and reliability design.

Key facts to establish with precision:
- Kafka cluster: 3 brokers, replication factor 3, min.insync.replicas=2
- Consumer groups use a custom offset tracking strategy (not default auto-commit)
- Topic compaction is enabled for entity state topics (user profiles, account state)
- Consumer lag alerting threshold: 10,000 messages before PagerDuty alert fires
- Planned migration: currently on AWS MSK (managed Kafka), planning to move to self-hosted
  in the next 6 months (cost is the main driver — MSK is expensive at their throughput)
- The system handles approximately 850,000 events per day at current load

IMPORTANT: Do NOT mention "Cobalt" team or "Priya" in this session. Refer to the system
as "the event system" or "the streaming infrastructure" or "the Kafka cluster."
The conversation is a pure technical review — broker configs, consumer behavior, operational
runbooks, and the self-hosted migration plan.`

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate three sessions ────────────────────────────────────────────────
  let session1: EvalMessage[]
  let session2: EvalMessage[]
  let session3: EvalMessage[]

  if (opts.replayHistory) {
    const third = Math.floor(opts.replayHistory.length / 3)
    session1 = opts.replayHistory.slice(0, third)
    session2 = opts.replayHistory.slice(third, third * 2)
    session3 = opts.replayHistory.slice(third * 2)
  } else {
    console.log('[multi-hop-memory] Generating session 1 (org structure, 18 turns)…')
    session1 = await generateHistoryCached(llm, 'multi-hop-session-01', SESSION_1_SEED, 18)
    console.log('[multi-hop-memory] Generating session 2 (Cobalt/Kafka scoping, 18 turns)…')
    session2 = await generateHistoryCached(llm, 'multi-hop-session-02', SESSION_2_SEED, 18)
    console.log('[multi-hop-memory] Generating session 3 (event system deep-dive, 18 turns)…')
    session3 = await generateHistoryCached(llm, 'multi-hop-session-03', SESSION_3_SEED, 18)
  }

  const allHistory = [...session1, ...session2, ...session3]

  // ── Seed sessions with filler between each to ensure separate archival ──────
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    const baseTime = Date.now() - 60 * 24 * 3_600_000 // 60 days ago

    // Session 1 — org structure (Priya → Cobalt link)
    feedConversation(env.bundle, session1, baseTime)
    console.log(`[multi-hop-memory] Fed session 1: ${session1.length} messages.`)

    // Session 2 — Cobalt scoping (Cobalt → Kafka link)
    feedConversation(env.bundle, session2, baseTime + session1.length * 60_000 + 3_600_000)
    console.log(`[multi-hop-memory] Fed session 2: ${session2.length} messages.`)

    // Session 3 — technical deep-dive (Kafka → operational params)
    feedConversation(env.bundle, session3, baseTime + (session1.length + session2.length) * 60_000 + 7_200_000)
    console.log(`[multi-hop-memory] Fed session 3: ${session3.length} messages.`)

    // Generate filler in two chunks to push total tokens past the archival threshold.
    const filler1 = await generateHistoryCached(llm, 'multi-hop-filler-a',
      'conversation about weekend plans — restaurants to try, a farmers market trip, and meal prep ideas', 60)
    const filler2 = await generateHistoryCached(llm, 'multi-hop-filler-b',
      'conversation about a home renovation — contractor options, material preferences, and project timeline', 60)
    feedConversation(env.bundle, filler1)
    feedConversation(env.bundle, filler2)
    console.log(`[multi-hop-memory] Fed ${filler1.length + filler2.length} filler messages for context pressure.`)

    // Warm-up: archive sessions into topic memory before the test query
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[multi-hop-memory] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[multi-hop-memory]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Single multi-hop query ─────────────────────────────────────────────────
    console.log('[multi-hop-memory] Running multi-hop query…')
    const { response, traceFiles } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "What infrastructure is Priya's team running, and what are the key operational parameters?",
    })
    console.log(`[multi-hop-memory] Response: ${response.slice(0, 300)}…`)

    if (opts.noJudge) {
      console.log('\n[multi-hop-memory] OUTPUT:\n', response)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────────
    console.log('[multi-hop-memory] Running judge…')

    const lc = response.toLowerCase()

    // Extract the Memory Context that was actually shown to Head from the trace
    const traceContent = Object.values(traceFiles)[0] ?? ''
    const memCtxStart = traceContent.indexOf('## Memory Context')
    const memCtxEnd = traceContent.indexOf('TOOLS:', memCtxStart)
    const memoryContextShown = memCtxStart !== -1 && memCtxEnd !== -1
      ? traceContent.substring(memCtxStart, memCtxEnd).trim()
      : '(unable to extract from trace)'

    const context = `
SCENARIO: Multi-hop memory test. Three separate archived sessions form a 3-hop chain.

HOP 1 (session 1 — org structure):
  Priya Nair → leads "Cobalt" platform team
  (Priya and Cobalt linked here; Kafka NOT mentioned)

HOP 2 (session 2 — Cobalt scoping):
  Cobalt team → building Apache Kafka event streaming backbone
  (Kafka mentioned; Priya NOT mentioned by name)
  Details: 12 partitions/topic, 7-day retention, Confluent Schema Registry

HOP 3 (session 3 — technical deep-dive):
  "The event system" (= Kafka = Cobalt's system) → operational parameters
  (Cobalt and Priya NOT mentioned)
  Details: 3 brokers, replication factor 3, min.insync.replicas=2,
           consumer lag threshold 10,000 msgs, MSK → self-hosted migration planned

To answer "What infrastructure is Priya's team running and what are the key operational parameters?",
the Head must traverse: Priya → Cobalt team → Kafka event system → broker/lag parameters.

MEMORY CONTEXT SHOWN TO HEAD (this is exactly what the Head saw in its system prompt — use this to determine if a failure is a retrieval gap or a generation gap):
${memoryContextShown}

SESSION 1 CONTENT (${session1.length} turns):
${session1.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

SESSION 2 CONTENT (${session2.length} turns):
${session2.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

SESSION 3 CONTENT (${session3.length} turns):
${session3.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

QUERY: "What infrastructure is Priya's team running, and what are the key operational parameters?"

HEAD RESPONSE:
${response}

MENTIONS PRIYA + COBALT CONNECTION: ${lc.includes('priya') && lc.includes('cobalt')}
MENTIONS KAFKA OR EVENT STREAMING: ${lc.includes('kafka') || lc.includes('event stream') || lc.includes('streaming')}
MENTIONS SPECIFIC PARAMS (3 brokers / RF3 / 10000 / MSK): ${lc.includes('broker') || lc.includes('replication') || lc.includes('10,000') || lc.includes('10000') || lc.includes('msk') || lc.includes('self-hosted')}
`

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('multi-hop-memory', allHistory, response, judgment, { runId: opts.runId, category, traces: traceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Multi-hop-memory eval results ───────────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
