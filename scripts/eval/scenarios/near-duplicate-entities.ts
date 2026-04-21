/**
 * Scenario — Near-Duplicate Entities
 *
 * Two backend engineers with the same last name (Jordan Chen and Taylor Chen) are
 * discussed in a single archived session. They have distinct languages, teams, and
 * concerns that are easy to cross-contaminate.
 *
 * Pass criteria: Six attributes correctly attributed across two queries, zero swaps.
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

export const name = 'near-duplicate-entities'
export const description = 'Jordan Chen (Go, Sentinel team) vs Taylor Chen (Rust, Aegis team) — archived together, queried separately for zero attribute cross-contamination'
export const category = 'memory'
export const estimatedCostUsd = 0.18
export const rubric = [
  'jordan_language_correct — Does the Jordan response mention the correct programming language from the fixture (not the other engineer\'s language)?',
  'jordan_team_correct — Does the Jordan response mention the correct team name from the fixture (not the other engineer\'s team)?',
  'jordan_concern_correct — Does the Jordan response mention the correct concern from the fixture (not the other engineer\'s concern)?',
  'taylor_language_correct — Does the Taylor response mention the correct programming language from the fixture (not the other engineer\'s language)?',
  'taylor_team_correct — Does the Taylor response mention the correct team name from the fixture (not the other engineer\'s team)?',
  'taylor_concern_correct — Does the Taylor response mention the correct concern from the fixture (not the other engineer\'s concern)?',
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string }): Promise<void> {
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)
  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })

  // ── Generate history ───────────────────────────────────────────────────────
  let history: EvalMessage[]

  if (opts.replayHistory) {
    history = opts.replayHistory
  } else {
    console.log('[near-duplicate-entities] Generating team review session (~32 turns)…')
    history = await generateHistoryCached(
      llm,
      'near-duplicate-entities-team',
      `An engineering manager's quarterly 1:1 review conversation with their assistant Shrok.
The manager is reviewing two engineers who are dangerously easy to confuse:

JORDAN CHEN — backend engineer, writes Go exclusively, on the "Sentinel" infrastructure team.
Currently leading the distributed tracing rollout (migrating from Jaeger to OpenTelemetry).
The tracing collector is written in Go and Jordan has been refactoring Go interfaces for the
new OTel SDK. 1:1 schedule: every Monday at 10am. Jordan's concern this quarter: the on-call
rotation is unsustainable — they're on a 7-day full-on-call rotation with no shadow week,
affecting their deep work time. Jordan has requested moving to a 2-week rotation with a shadow period.

TAYLOR CHEN — also a backend engineer (same level as Jordan), writes Rust exclusively,
on the "Aegis" security team. Currently building the secret scanning service (detects
leaked credentials in code commits). The scanner's core matching engine is written in Rust
for performance — Taylor chose Rust over Go specifically for the memory safety guarantees
and zero-cost abstractions needed for high-throughput scanning. 1:1 schedule: every Thursday
at 2pm. Taylor's concern this quarter: needs access to the staging HSM (Hardware Security
Module) for integration testing — has been blocked for 6 weeks waiting on IT to provision it.

CRITICAL: The conversation must be hard to summarize without mixing them up. Follow these rules:

1. At least 4 turns must discuss BOTH engineers in the same message using comparative framing
   ("both engineers have access concerns — one needs rotation relief, the other needs hardware
   provisioned"), WITHOUT attaching the person's name to their specific attribute in that same
   sentence. The reader must track who has which concern across turns.

2. The programming languages MUST come up naturally in discussion — e.g., the manager mentions
   Jordan's Go code quality in the tracing collector, Taylor's decision to use Rust for the
   scanner, a comparison of their language choices, or asking about hiring Go/Rust specialists
   for their respective teams. Each language should appear in at least 3 separate messages.

3. The manager must sometimes refer to them by last name only ("I talked to Chen yesterday —
   the one on Sentinel"). The assistant should ask "Jordan or Taylor?" at least once.

4. The manager occasionally mixes up small details ("wait, is Jordan on Aegis or Sentinel?")
   and the assistant corrects them. This surfaces the confusion naturally.

Also include two other engineers to dilute the signal: Priya (frontend, design systems team)
and Marcus (data engineer, analytics team) — but give them less airtime.`,
      32,
    )
  }

  // ── Seed and archive ───────────────────────────────────────────────────────
  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    feedConversation(env.bundle, history)

    // Generate filler to push total tokens past the archival threshold
    // so the team review session gets archived to topic memory.
    const filler = await generateHistoryCached(
      llm,
      'near-duplicate-entities-filler',
      'casual conversation about meal prepping, a new gym routine, and planning a birthday party — completely unrelated to engineering teams',
      60,
    )
    feedConversation(env.bundle, filler)
    console.log(`[near-duplicate-entities] Fed ${history.length} session + ${filler.length} filler messages into store.`)

    // Warm-up: archive the team review + filler into topic memory
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[near-duplicate-entities] Warm-up pass ${pass}…`)
      await runHeadQuery({ bundle: env.bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir, query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = env.bundle.appState.tryAcquireArchivalLock()
        if (acquired) { env.bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const remaining = env.bundle.messages.count()
      console.log(`[near-duplicate-entities]   ${(await memory.getTopics()).length} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Two queries — one per engineer ────────────────────────────────────────
    console.log('[near-duplicate-entities] Querying about Jordan…')
    const { response: jordanResponse, traceFiles: tf1 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "What's Jordan's situation — what are they working on and what was their concern this quarter?",
    })
    console.log(`[near-duplicate-entities] Jordan response: ${jordanResponse.slice(0, 200)}…`)

    console.log('[near-duplicate-entities] Querying about Taylor…')
    const { response: taylorResponse, traceFiles: tf2 } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory: memory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      query: "And Taylor — same question, what are they working on and what was their concern?",
    })
    console.log(`[near-duplicate-entities] Taylor response: ${taylorResponse.slice(0, 200)}…`)
    const allTraceFiles = { ...tf1, ...tf2 }

    if (opts.noJudge) {
      console.log('\n[near-duplicate-entities] JORDAN OUTPUT:\n', jordanResponse)
      console.log('\n[near-duplicate-entities] TAYLOR OUTPUT:\n', taylorResponse)
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────────
    console.log('[near-duplicate-entities] Running judge…')

    const jlc = jordanResponse.toLowerCase()
    const tlc = taylorResponse.toLowerCase()

    const context = `
SCENARIO: Near-duplicate entity discrimination test.

GROUND TRUTH from archived conversation:

JORDAN CHEN:
- Language: Go (exclusively)
- Team: Sentinel (infrastructure)
- Project: distributed tracing rollout (Jaeger → OpenTelemetry)
- Concern: on-call rotation too heavy (7-day rotations, wants 2-week + shadow)

TAYLOR CHEN:
- Language: Rust (exclusively)
- Team: Aegis (security)
- Project: secret scanning service (leaked credential detection)
- Concern: needs staging HSM access (blocked 6 weeks)

Both are senior backend engineers. A sloppy memory summary might merge them.

ARCHIVED CONVERSATION (${history.length} turns):
${history.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')}

QUERY 1: "What's Jordan's situation — what are they working on and what was their concern?"
JORDAN RESPONSE:
${jordanResponse}

MENTIONS GO: ${/\bgo\b/.test(jlc) || jlc.includes('golang')}
MENTIONS RUST (wrong): ${jlc.includes('rust')}
MENTIONS SENTINEL: ${jlc.includes('sentinel')}
MENTIONS AEGIS (wrong): ${jlc.includes('aegis')}
MENTIONS ON-CALL: ${jlc.includes('on-call') || jlc.includes('oncall') || jlc.includes('rotation')}
MENTIONS HSM (wrong): ${jlc.includes('hsm') || jlc.includes('hardware security')}

QUERY 2: "And Taylor — same question, what are they working on and what was their concern?"
TAYLOR RESPONSE:
${taylorResponse}

MENTIONS RUST: ${tlc.includes('rust')}
MENTIONS GO (wrong): ${/\bgo\b/.test(tlc) || tlc.includes('golang')}
MENTIONS AEGIS: ${tlc.includes('aegis')}
MENTIONS SENTINEL (wrong): ${tlc.includes('sentinel')}
MENTIONS HSM: ${tlc.includes('hsm') || tlc.includes('hardware security') || tlc.includes('staging access')}
MENTIONS ON-CALL (wrong): ${tlc.includes('on-call') || tlc.includes('oncall') || tlc.includes('rotation')}
`

    const judgment = await judge(rubric, context)

    const output = {
      turns: [
        { query: "What's Jordan's situation — what are they working on and what was their concern this quarter?", response: jordanResponse },
        { query: "And Taylor — same question, what are they working on and what was their concern?", response: taylorResponse },
      ],
    }
    const txtPath = await writeResults('near-duplicate-entities', history, output, judgment, { runId: opts.runId, category, traces: allTraceFiles })
    printJudgment(judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(j: Judgment, txtPath: string): void {
  console.log('\n── Near-duplicate-entities eval results ────────────')
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
