/**
 * Proactive decision — realistic scenarios.
 *
 * Unlike the basic proactive-decision eval which tests clean, ideal signals,
 * this eval uses generated multi-turn conversations with buried, ambiguous,
 * or misleading context to test whether the proactive decision holds up
 * under messy real-world conditions.
 *
 * Variants:
 * 1. buried_vacation — User mentioned being away next week, but 15 messages
 *    ago in a longer conversation about multiple topics. Should still skip.
 * 2. coworker_vacation — User mentioned their COWORKER is on vacation, not
 *    themselves. Should NOT skip — user is still active.
 * 3. stale_manual_run — User checked email manually, but 3 hours ago with
 *    lots of conversation since. Should run — enough time has passed.
 * 4. complaint_about_noise — User previously complained about getting too
 *    many notifications. Email triage should still run (it's useful), but
 *    this tests whether the model over-interprets complaints as "stop everything."
 * 5. busy_day — User said "crazy busy day, don't bother me with anything
 *    unless it's urgent." Email triage arguably should still run — it flags
 *    urgent items. This is deliberately ambiguous.
 *
 * Because these are judgment calls on ambiguous context, scoring is softer:
 * the judge evaluates whether the decision was reasonable, not whether it
 * matched a single expected answer.
 */

import * as path from 'node:path'
import { createTopicMemory } from '../../../src/memory/index.js'
import { generateId } from '../../../src/llm/util.js'
import type { QueueEvent, TextMessage } from '../../../src/types/core.js'
import {
  judge,
  writeResults,
  makeLLMRouter,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadEvent,
  generateHistoryCached,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'

export const name = 'proactive-decision-realistic'
export const description = 'Proactive decision with messy, ambiguous, real-world-like conversation context'
export const category = 'reliability'
export const estimatedCostUsd = 0.30
export const rubric = [
  'buried_vacation — User mentioned being away next week buried deep in a long conversation. The proactive decision should skip — the signal is old but still relevant. Score 1.0 if skipped, 0.5 if ran with a reason acknowledging the user might be away, 0.0 if ran with no awareness.',
  "coworker_vacation — User mentioned their COWORKER's vacation, not their own. The proactive decision should run — the user is still active and working. Score 1.0 if ran, 0.0 if incorrectly skipped based on someone else's vacation.",
  'stale_manual_run — User checked email 3 hours ago with lots of conversation since. The proactive decision should run — enough time has passed for new email to arrive. Score 1.0 if ran, 0.5 if skipped with a reasonable time-based argument, 0.0 if skipped claiming it was "just done."',
  'complaint_about_noise — User previously complained about notification overload. Email triage should still run — it is a substantive task, not a notification. Score 1.0 if ran, 0.5 if skipped with a nuanced reason about user preferences, 0.0 if skipped with a shallow "user wants fewer notifications" reason.',
  'busy_day_judgment — User said "crazy busy, only bother me if urgent." Email triage flags urgent items, so running is defensible. Skipping is also defensible (user asked not to be bothered). Score 1.0 if the decision is reasonable with a thoughtful reason, 0.5 if the decision is reasonable but the reason is shallow, 0.0 if the reason contradicts the context.',
]

const EMAIL_SKILL = `---
name: email-triage
description: Check email inbox and triage messages — flag urgent items, archive junk, summarize what needs attention.
---

Check the user's email inbox. Triage messages by urgency:
- Flag anything time-sensitive or from known important contacts
- Archive obvious junk and newsletters
- Summarize what needs the user's attention

Report only if there are items requiring attention. If inbox is clean, say so briefly.
`

const SCHEDULE_ID = 'sched-email-triage'

interface Variant {
  name: string
  /** Seed for generating realistic conversation history. */
  historySeed: string
  /** Number of conversation turns to generate. */
  historyTurns: number
  /** Extra messages appended after the generated history (for precise signal injection). */
  extraMessages?: Array<{ role: 'user' | 'assistant'; content: string; minutesAgo: number }>
  /** Override the cron expression for this variant (default: once daily at current time). */
  cron?: string
  /** Context for the judge explaining what this variant tests. */
  judgeContext: string
}

const VARIANTS: Variant[] = [
  {
    name: 'buried_vacation',
    historySeed: `A casual multi-topic conversation between a user and their AI assistant. The conversation covers:
1. Planning a work presentation (first few messages)
2. User casually mentions "oh by the way, I'm taking next week off — heading to the coast, won't be checking work stuff" (middle of conversation, mentioned once in passing)
3. Conversation continues about dinner plans, a book recommendation, and weekend errands (several more messages after the vacation mention)
The vacation mention should feel natural and not be the focus of the conversation — it's an aside.`,
    historyTurns: 20,
    judgeContext: `The user mentioned being away next week ("taking next week off, won't be checking work stuff") buried in the middle of a 20-message conversation about various topics. This was said in passing, not as a direct instruction to stop schedules. The proactive decision should recognize this and skip the email triage — the user won't be checking work stuff. The signal is buried but still clearly stated.`,
  },
  {
    name: 'coworker_vacation',
    historySeed: `A work conversation between a user and their AI assistant about team coordination. The conversation covers:
1. User asks about the team sprint status
2. User mentions "Sarah is out on vacation this week so I'm covering her PRs"
3. Discussion about which PRs to prioritize
4. User asks about their own calendar for the week
5. General back-and-forth about deadlines
The key detail: it's the user's COWORKER (Sarah) who is on vacation, NOT the user themselves. The user is clearly active and working — they're covering extra work.`,
    historyTurns: 12,
    judgeContext: `The user's coworker Sarah is on vacation, and the user mentioned this while discussing covering her work. The user themselves is clearly active and working (covering PRs, checking calendars, discussing deadlines). The proactive decision should NOT skip — the user is present and would benefit from email triage. If it skips, it incorrectly attributed the vacation to the user.`,
  },
  {
    name: 'stale_manual_run',
    historySeed: `A busy workday conversation between a user and their AI assistant. The conversation does NOT involve email at all — it covers entirely different topics:
1. User asks about a project timeline for the Davidson account
2. Discussion about pushing milestones back due to delayed discovery calls
3. User asks about code review feedback on a customer portal feature
4. Discussion about session timeout logic and rate limiting fixes
5. User asks about lunch options near the office
6. User asks assistant to draft a message to a client about design mockups
7. Back-and-forth refining the client message tone
8. User asks about afternoon meeting prep
IMPORTANT: Do NOT mention email, inbox, or email-related topics anywhere in this conversation. The conversation is entirely about project management, code review, lunch, and client communication.`,
    historyTurns: 16,
    extraMessages: [
      // Inject the email check at exactly 3 hours ago — this is the ONLY email mention
      { role: 'user', content: 'Check my email for me.', minutesAgo: 180 },
      { role: 'assistant', content: "I've triaged your inbox. Two messages need attention: a contract review request from Legal (due tomorrow) and a meeting reschedule from the product team. I've archived 8 newsletters and 3 promotional emails.", minutesAgo: 179 },
    ],
    cron: '0 */2 * * *', // every 2 hours — makes 3 hours clearly overdue
    judgeContext: `The email triage skill runs every 2 hours. The user asked for email to be checked 3 hours ago — that's 1.5x the schedule interval, meaning a full cycle has passed. Lots of conversation has happened since (project timelines, code review, lunch, client message drafting). The proactive decision should run. Note: the email check 3 hours ago DID happen (it's in the conversation history with timestamps) — the model is not hallucinating if it references it. The question is whether 3 hours is too long ago given a 2-hour schedule.`,
  },
  {
    name: 'complaint_about_noise',
    historySeed: `A conversation where the user is a bit frustrated with notification overload:
1. User vents: "I swear I get 50 pings a day between Slack, email, and everything else. It's impossible to focus."
2. Assistant empathizes and suggests some notification management strategies
3. User says "yeah I need to clean that up at some point"
4. Conversation moves on to actual work — user asks about a database migration
5. Discussion about the migration approach
6. User asks about test coverage for the migration
The notification complaint is venting/frustration, NOT an instruction to stop checking email. The user is clearly still working and engaged.`,
    historyTurns: 14,
    judgeContext: `The user complained about notification overload ("50 pings a day, impossible to focus") but this was venting, not an instruction to stop scheduled tasks. The conversation moved on to active work (database migration, test coverage). Email triage is a substantive task that reduces noise (triages and archives junk), not a notification. The proactive decision should run. If it skips because of the complaint, it's over-interpreting frustration as a directive.`,
  },
  {
    name: 'busy_day',
    historySeed: `A fast-paced conversation on a hectic workday:
1. User: "Crazy day — back to back meetings starting in 10 minutes. Don't bother me with anything unless it's actually urgent."
2. Assistant acknowledges and offers to hold non-urgent items
3. User asks a quick question about a meeting agenda
4. Assistant provides the agenda summary
5. Brief exchange about talking points for the meeting
This is a user who is clearly swamped but hasn't said to stop all scheduled work — they said "unless it's urgent." Email triage specifically flags urgent items.`,
    historyTurns: 8,
    judgeContext: `The user said "don't bother me with anything unless it's actually urgent." Email triage specifically flags urgent items and filters noise — arguably exactly what a busy user needs. However, the user could also be interpreted as wanting minimal interruption of any kind. EITHER run or skip is defensible here. What matters is whether the reason demonstrates understanding of the nuance — e.g., "running because email triage flags urgent items, which the user still wants" or "skipping because user requested minimal interruption and triage results are unlikely to be urgent." A shallow reason that ignores the "unless urgent" qualifier should score lower.`,
  },
]

export const variants: EvalVariant[] = VARIANTS.map(v => ({
  name: v.name,
  query: `(schedule trigger for email-triage — context: ${v.name})`,
  setup: () => {},
  judgeContext: v.judgeContext,
}))

export async function run(opts: {
  replayHistory?: EvalMessage[]
  noJudge?: boolean
  runId?: string
  variant?: EvalVariant
}): Promise<void> {
  const variantName = opts.variant?.name ?? VARIANTS[0]!.name
  const sv = VARIANTS.find(v => v.name === variantName) ?? VARIANTS[0]!

  const { router } = makeLLMRouter()
  const llm = makeLLMFunction(router)

  const nowDate = new Date()
  const currentMinute = nowDate.getUTCMinutes()
  const currentHour = nowDate.getUTCHours()
  const scheduleCron = `${currentMinute} ${currentHour} * * *`

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
      proactiveEnabled: true,
    },
    skills: [{ name: 'email-triage', content: EMAIL_SKILL }],
  })
  try {
    console.log(`\n[proactive-realistic:${sv.name}] Generating conversation history...`)

    // Generate (or load cached) realistic conversation
    const generatedHistory = await generateHistoryCached(
      llm,
      `proactive-realistic-${sv.name}`,
      sv.historySeed,
      sv.historyTurns,
    )

    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm)

    const variantCron = sv.cron ?? scheduleCron
    env.bundle.schedules.create({
      id: SCHEDULE_ID,
      skillName: 'email-triage',
      cron: variantCron,
      nextRun: new Date().toISOString(),
    })

    // Seed generated conversation into message store
    const baseTime = Date.now() - (sv.historyTurns * 5 * 60_000) // spread across time
    for (let i = 0; i < generatedHistory.length; i++) {
      const msg = generatedHistory[i]!
      env.bundle.messages.append({
        kind: 'text',
        id: generateId('msg'),
        role: msg.role,
        content: msg.content,
        createdAt: new Date(baseTime + i * 5 * 60_000).toISOString(),
      })
    }

    // Append any extra messages with precise timestamps
    if (sv.extraMessages) {
      for (const extra of sv.extraMessages) {
        env.bundle.messages.append({
          kind: 'text',
          id: generateId('msg'),
          role: extra.role,
          content: extra.content,
          createdAt: new Date(Date.now() - extra.minutesAgo * 60_000).toISOString(),
        })
      }
    }

    const scheduleEvent: QueueEvent = {
      type: 'schedule_trigger',
      id: generateId('ev'),
      scheduleId: SCHEDULE_ID,
      skillName: 'email-triage',
      kind: 'skill',
      createdAt: new Date().toISOString(),
    }

    console.log(`[proactive-realistic:${sv.name}] Running schedule trigger...`)

    const result = await runHeadEvent({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      event: scheduleEvent,
      stubAgentRunner: true,
    })

    const schedule = env.bundle.schedules.get(SCHEDULE_ID)
    const wasSkipped = !!schedule?.lastSkipped
    const skipReason = schedule?.lastSkipReason ?? null

    console.log(`[proactive-realistic:${sv.name}] Skipped: ${wasSkipped}${skipReason ? `, reason: ${skipReason}` : ''}`)

    // Build full history for the judge — no truncation, the judge needs complete
    // context to distinguish real conversation details from hallucinations
    const allMessages = env.bundle.messages.getAll()
    const historyForJudge = allMessages
      .filter((m): m is TextMessage => m.kind === 'text')
      .map(m => {
        const age = Math.round((Date.now() - new Date(m.createdAt).getTime()) / 60_000)
        return `[${m.role}] (${age}min ago) ${m.content}`
      })
      .join('\n\n')

    const output = {
      variant: sv.name,
      skipped: wasSkipped,
      skipReason,
      totalMessagesInHistory: allMessages.length,
    }

    if (opts.noJudge) {
      console.log(`\n[proactive-realistic:${sv.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      console.log('\nRecent history excerpt:')
      console.log(historyForJudge)
      return
    }

    console.log(`[proactive-realistic:${sv.name}] Running judge...`)

    const context = `
SCENARIO: Proactive decision — realistic variant "${sv.name}"
SKILL: email-triage (checks inbox, flags urgent items, archives junk, summarizes what needs attention)
SCHEDULE: ${variantCron}

VARIANT CONTEXT:
${sv.judgeContext}

FULL CONVERSATION HISTORY (with timestamps):
${historyForJudge}

PROACTIVE DECISION RESULT:
  Skipped: ${wasSkipped}
  Skip reason: "${skipReason ?? '(not skipped — allowed to run)'}"
`

    // Only judge the current variant's rubric dimension
    const variantRubric = rubric.filter(r => r.startsWith(sv.name))
    const judgment = await judge(variantRubric.length > 0 ? variantRubric : rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: `[VARIANT: ${sv.name} — schedule trigger for email-triage]` },
      { role: 'assistant', content: wasSkipped ? `(skipped: ${skipReason})` : '(proactive decision: run)' },
    ]

    const txtPath = await writeResults('proactive-decision-realistic', history, output, judgment, {
      runId: opts.runId,
      category,
      traces: result.traceFiles,
      fileLabel: `proactive-realistic-${sv.name}`,
    })
    printJudgment(sv.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Proactive-realistic [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
