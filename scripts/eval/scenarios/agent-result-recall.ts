/**
 * Agent result recall scenario.
 *
 * Tests whether agent work products survive archival and remain recallable.
 * Seeds two completed agent results (skill output + freeform research),
 * archives them out of live context, then queries the Head to verify recall.
 *
 * The archival pipeline treats forward-injected agent results as regular text
 * messages, so this tests whether that content archives and retrieves well.
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
  feedConversation,
  LEAN_EVAL_CONFIG,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'agent-result-recall'
export const description = 'Agent results survive archival → Head recalls specific details from each (variants: email-and-desk, meeting-and-recipe, code-and-travel)'
export const category = 'memory'
export const estimatedCostUsd = 0.20
export const rubric = [
  'results_archived — Were agent result messages archived into topic memory (evidenced by topics being created and recall succeeding)? Score 1.0 if topics exist and recall works, 0.5 if partial, 0.0 if no archival occurred.',
  'first_result_recalled — Does the Head\'s response to the first recall query include key specific details from the first agent result (names, numbers, or other distinctive facts)? Score 1.0 if key details present, 0.5 if partial, 0.0 if none.',
  'second_result_recalled — Does the Head\'s response to the second recall query include key specific details from the second agent result (names, numbers, or other distinctive facts)? Score 1.0 if key details present, 0.5 if partial, 0.0 if none.',
  'no_cross_contamination — Do the recall query responses stay within their own topic (first result details don\'t bleed into the second query\'s response and vice versa)? Score 1.0 if clean, 0.5 if minor bleed, 0.0 if significant.',
  'no_fabrication — Does the Head avoid inventing details not present in the original agent results? Score 1.0 if no fabrication, 0.5 if minor additions, 0.0 if significant fabrication.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface AgentResultVariant {
  name: string
  query: string
  setup: (skillsDir: string) => void
  seeds: Array<{
    userContent: string
    assistantContent: string
  }>
  queries: Array<{ label: string; query: string }>
}

export const variants: EvalVariant[] = [
  {
    name: 'email-and-desk',
    query: '', setup: () => {},
    seeds: [
      {
        userContent: 'Check my email for anything important.',
        assistantContent: `I checked your email. Here's a summary of what's in your inbox:

1. **Invoice from Acme Corp** — $2,340 for Q1 consulting services, due April 15th
2. **Meeting request from Sarah** — She wants to meet Thursday at 2pm to discuss the roadmap
3. **Newsletter from TechCrunch** — Weekly digest, nothing urgent

The Acme Corp invoice is the most time-sensitive item. Would you like me to do anything with these?`,
      },
      {
        userContent: 'Can you research standing desks under $500 for me?',
        assistantContent: `I researched standing desks under $500. Here are the top options:

1. **Uplift V2 Commercial** — $479. Best overall: rock-solid stability, 10-year warranty, 355 lb capacity. Ships in 3-5 days.
2. **FlexiSpot E7** — $449. Best value: dual-motor, anti-collision, programmable presets. Often on sale for $399.
3. **Jarvis Bamboo by Fully** — $499. Best eco-friendly option: sustainable bamboo top, smooth motor, 7-year warranty.

All three have electric height adjustment and can accommodate dual monitors. The Uplift V2 has the best stability ratings, while the FlexiSpot E7 offers the most features for the price.`,
      },
    ],
    queries: [
      { label: 'invoiceRecall', query: 'Did I get any invoices recently? What were the details?' },
      { label: 'deskRecall', query: 'What standing desk options did you find for me? Include the models and prices.' },
    ],
  } satisfies AgentResultVariant as EvalVariant,
  {
    name: 'meeting-and-recipe',
    query: '', setup: () => {},
    seeds: [
      {
        userContent: 'Summarize my meeting from this morning and pull out the action items.',
        assistantContent: `Here's the summary from your 10am product sync:

**Attendees:** You, Priya, James, and Lena
**Key decisions:**
1. V2 launch pushed to June 1st (from May 15th) to accommodate the new onboarding flow
2. James will own the migration script — deadline May 10th
3. Priya is drafting the customer comms by end of week

**Action items for you:**
- Review James's migration script PR by May 12th
- Sign off on Priya's customer email draft by Friday
- Schedule a 30-min check-in with Lena about the analytics dashboard

The biggest risk flagged was the migration script timeline — James said he'd need access to the staging DB by Monday.`,
      },
      {
        userContent: 'Find me a good sourdough bread recipe that works for beginners.',
        assistantContent: `Here's a beginner-friendly sourdough recipe I found:

**Simple No-Knead Sourdough** (from King Arthur Baking)
- **Prep time:** 30 min active, 12-14 hours total (mostly waiting)
- **Ingredients:** 500g bread flour, 375g water, 100g active starter, 10g salt
- **Method:** Mix ingredients, stretch-and-fold every 30 min for 2 hours, bulk ferment 8-10 hours at room temp, shape, cold proof overnight, bake at 450°F in a Dutch oven (lid on 20 min, lid off 25 min)

**Tips for beginners:**
1. Use the "poke test" — dough is ready when a poke springs back slowly
2. A warmer kitchen (75-78°F) speeds up fermentation
3. Score the top with a razor blade or sharp knife before baking

The Dutch oven is key — it traps steam for the crispy crust. If you don't have one, use an inverted baking sheet on top.`,
      },
    ],
    queries: [
      { label: 'meetingRecall', query: 'What were the action items from my product sync meeting? Who needs to do what?' },
      { label: 'recipeRecall', query: 'What was that sourdough recipe you found? Give me the key details.' },
    ],
  } satisfies AgentResultVariant as EvalVariant,
  {
    name: 'code-and-travel',
    query: '', setup: () => {},
    seeds: [
      {
        userContent: 'Review the auth module PR and tell me what you found.',
        assistantContent: `I reviewed PR #342 (auth module refactor). Here are the findings:

**Critical issues (2):**
1. **Token expiry race condition** — The refresh token logic in \`AuthManager.refresh()\` doesn't lock the mutex before writing the new token. Two concurrent requests could both refresh, and the second write overwrites the first with a stale token.
2. **Missing CSRF validation** — The \`/api/auth/callback\` endpoint skips CSRF check when the \`state\` param is present, but doesn't validate the state value against the session.

**Suggestions (3):**
1. The bcrypt cost factor is set to 10 — consider bumping to 12 for production
2. \`SessionStore.cleanup()\` runs synchronously on every request; move it to a background cron
3. Error messages in \`login()\` leak whether an email exists ("user not found" vs "wrong password")

Overall the refactor improves structure significantly, but the two critical issues should be fixed before merge.`,
      },
      {
        userContent: 'Look up flights from SFO to Tokyo for the last week of October.',
        assistantContent: `Here are the best options I found for SFO → Tokyo (NRT/HND), departing Oct 25–31:

**Economy picks:**
1. **ANA direct (SFO→HND)** — $687 round trip, 11h 15m outbound. Departs Oct 26, returns Nov 2. Best overall value for a direct flight.
2. **Japan Airlines direct (SFO→NRT)** — $723 round trip, 11h 30m outbound. Departs Oct 27, returns Nov 3. Slightly nicer meal service.
3. **United via LAX** — $542 round trip, 14h 40m outbound (2h layover). Departs Oct 25, returns Nov 1. Cheapest but adds 3+ hours.

**Business class:**
4. **ANA business (SFO→HND)** — $3,200 round trip. "The Room" seat is widely considered the best business class product to Japan.

All prices as of today. ANA and JAL both include 2 checked bags in economy. United includes 1. Book within 48 hours — the ANA $687 fare has been fluctuating.`,
      },
    ],
    queries: [
      { label: 'codeRecall', query: 'What were the critical issues you found in that auth PR review?' },
      { label: 'travelRecall', query: 'What flight options did you find for Tokyo? Give me the prices and airlines.' },
    ],
  } satisfies AgentResultVariant as EvalVariant,
]

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variant = (opts.variant ?? variants[0]!) as AgentResultVariant
  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const env = makeProductionEnvironment({ config: LEAN_EVAL_CONFIG })
  const bundle = env.bundle
  const allTraces: Record<string, string> = {}

  try {
    const memory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 50_000)

    // ── Seed agent result messages ─────────────────────────────────────────
    // These simulate the forward-injected messages that appear after agent completion.
    // The archival pipeline sees them as regular text messages.

    const seedHistory: EvalMessage[] = []
    for (const seed of variant.seeds) {
      seedHistory.push({ role: 'user', content: seed.userContent })
      seedHistory.push({ role: 'assistant', content: seed.assistantContent })
    }

    const baseTime = Date.now() - 300 * 60_000 // far in the past
    feedConversation(bundle, seedHistory, baseTime)

    // Generate filler in two chunks to create enough context pressure
    // (single 160-turn call exceeds the 16k output token limit).
    const filler1 = await generateHistoryCached(
      llm,
      `agent-result-recall-filler-${variant.name}-a`,
      'conversation about weekend plans — restaurants to try, a farmers market trip, and meal prep ideas',
      60,
    )
    const filler2 = await generateHistoryCached(
      llm,
      `agent-result-recall-filler-${variant.name}-b`,
      'conversation about a home renovation — contractor options, material preferences, and project timeline',
      60,
    )
    feedConversation(bundle, filler1)
    feedConversation(bundle, filler2)
    const totalFiller = filler1.length + filler2.length
    console.log(`[agent-result-recall:${variant.name}] Fed ${seedHistory.length} seed messages + ${totalFiller} filler into store.`)

    // ── Warm-up: trigger archival so seeds move to topic memory ──────────
    // Archival runs async during activation. We run warm-up queries until
    // the seeds are archived, then the real test queries hit topic memory.
    for (let pass = 1; pass <= 5; pass++) {
      console.log(`[agent-result-recall:${variant.name}] Warm-up pass ${pass}…`)
      await runHeadQuery({
        bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir,
        query: 'Hey, quick check-in.', stubAgentRunner: true, timeoutMs: 60_000,
      })
      // Wait for async archival to finish
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const acquired = bundle.appState.tryAcquireArchivalLock()
        if (acquired) { bundle.appState.releaseArchivalLock(); break }
        await new Promise(r => setTimeout(r, 150))
      }
      const topics = (await memory.getTopics()).length
      const remaining = bundle.messages.count()
      console.log(`[agent-result-recall:${variant.name}]   ${topics} topics, ${remaining} messages remaining`)
      if (remaining <= 20) break
    }

    // ── Query the Head ─────────────────────────────────────────────────────
    const responses: Record<string, { response: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> }> = {}

    for (const { label, query } of variant.queries) {
      console.log(`[agent-result-recall:${variant.name}] Query: ${label}…`)
      const result = await runHeadQuery({
        bundle, topicMemory: memory, router, config: env.config, identityDir: env.identityDir, workspaceDir: env.workspaceDir,
        query, stubAgentRunner: true, timeoutMs: 60_000,
      })
      responses[label] = { response: result.response, toolCalls: result.toolCalls }
      Object.assign(allTraces, result.traceFiles)
      console.log(`[agent-result-recall:${variant.name}]   → ${result.response.slice(0, 150)}`)
    }

    // Topics are retrieved after queries (archival fires naturally during queries)
    const topics = await memory.getTopics()
    console.log(`[agent-result-recall:${variant.name}] ${topics.length} topics after queries.`)

    // ── Output ─────────────────────────────────────────────────────────────
    const output = {
      variant: variant.name,
      topicsCreated: topics.map(t => ({ label: t.label, summary: t.summary })),
      responses: Object.fromEntries(
        Object.entries(responses).map(([k, v]) => [k, { response: v.response, toolCalls: v.toolCalls.map(tc => tc.name) }])
      ),
    }

    if (opts.noJudge) {
      console.log(`\n[agent-result-recall:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log(`[agent-result-recall:${variant.name}] Running judge…`)

    const context = `
SCENARIO: ${variant.seeds.length} agent results were seeded into the message store. Archival fires naturally during queries due to context pressure. ${variant.queries.length} Head queries test recall.
VARIANT: ${variant.name}

ORIGINAL AGENT RESULTS (seeded into store):
${variant.seeds.map((s, i) => `Result ${i + 1}:
User request: ${s.userContent}
Agent response: ${s.assistantContent}`).join('\n\n')}

MEMORY STATUS AFTER QUERIES:
- Memory topics created: ${topics.length}
${topics.map(t => `  - "${t.label}": ${t.summary}`).join('\n')}

${variant.queries.map((q, i) => `QUERY ${i + 1} (${q.label}): "${q.query}"
HEAD RESPONSE: ${responses[q.label]?.response || '(no response)'}
TOOL CALLS: ${responses[q.label]?.toolCalls.map(tc => tc.name).join(', ') || '(none)'}`).join('\n\n')}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = seedHistory

    const txtPath = await writeResults('agent-result-recall', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(allTraces).length > 0 ? allTraces : undefined,
      fileLabel: `agent-result-recall-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-result-recall [${variantName}] eval results ─────────────────`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
