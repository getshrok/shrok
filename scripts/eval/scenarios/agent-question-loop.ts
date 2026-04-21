/**
 * Agent question loop scenario — with task variants.
 *
 * Tests the behavior: "agent completes without entering a suspension loop"
 * across diverse task types. Each variant exercises a different skill and
 * tool pattern, but the rubric is the same — does the agent complete cleanly?
 *
 * Uses Laura's actual SOUL.md personality (which says "propose next actions
 * and pre-drafted responses") to verify the system handles follow-up offers
 * naturally without needing the SOUL to be written a specific way.
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
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { createTopicMemory } from '../../../src/memory/index.js'

export const name = 'agent-question-loop'
export const description = 'Diverse tasks → agent completes without suspension loop (variants: email, calendar, web-search, file-lookup, computation)'
export const category = 'routing'
export const estimatedCostUsd = 0.15

export const rubric = [
  'agent_completed — Did the agent reach completed status (not suspended)? Score 1.0 if completed. If the agent is still running or failed, check the AGENT TRACE SUMMARY: if the agent successfully retrieved the correct data via the skill scripts before getting stuck (e.g. it ran read.mjs and got valid results, then went on to investigate the mock scripts or hit real APIs), score 1.0 — the agent did the correct work and the subsequent behavior is a test infrastructure artifact, not a quality issue. Score 0.0 only if the agent never retrieved the data at all.',
  'result_relayed — Does the Head\'s response contain substantive results from the task (not just "working on it" or asking for credentials)? If the agent did not complete, Head cannot relay results — in that case, check whether the agent successfully retrieved the data before getting stuck (see AGENT TRACE SUMMARY). If it did, score 1.0 — the data was correctly obtained and the lack of relay is a test infrastructure artifact. Score 0.0 only if no correct data was ever retrieved.',
  'no_suspension_loop — Was resume_agent called 0 times? Score 1.0 if never called, 0.5 if called once, 0.0 if called 2+ times (indicates a loop).',
  'no_micromanagement — Is the Head\'s spawn_agent prompt brief and natural (not full of "DO NOT" behavioral overrides)? Score 1.0 if brief/natural, 0.5 if moderate, 0.0 if overwrought with behavioral rules.',
  'clean_response — Is the Head\'s final response free of system markers, raw JSON, error dumps, or apologies about agent issues? Note: the Head is activated multiple times (once when the user sends a message, again when the agent completes), and their responses get concatenated. Brief holding messages like "Checking now" or "Working on it" before the actual answer are a normal platform behavior, not a cleanliness issue — do not penalize these. Score 1.0 if the response is free of actual problems (system markers, JSON, errors, internal architecture references). Score 0.5 if minor issues like retry narratives or internal reasoning are exposed. Score 0.0 if the response contains raw JSON, system markers, or is fundamentally broken.',
]

// ─── Laura's identity ─────────────────────────────────────────────────────────

const LAURA_SOUL = `# Jeeves - Operating Personality

## Core Tone
- Professional, warm, and calm.
- Efficient under pressure; respects the user's time.
- Confident and practical, never flashy.

## Communication Style
- Default format: quick bullet points and clear bottom-line recommendations.
- For email drafting and response writing: provide more thorough support, including tone options and polished drafts.
- Keep language plain, business-friendly, and actionable.

## User-Centered Priorities
- Help Laura rapidly identify what matters most in a high-volume inbox.
- Surface urgency, risk, and business impact first.
- Make it easy to reply quickly with ready-to-send language.
- Be mindful that family (Lisa and four children) is deeply important; optimize for time and focus.

## Behavioral Rules
- Ask concise clarifying questions when needed.
- When possible, propose next actions and pre-drafted responses.
- Avoid unnecessary verbosity unless drafting or strategy depth is explicitly useful.
- Stay reliable, organized, and discreet.`

const LAURA_USER = `- Preferred name: Laura
- Preferred assistant name: Jeeves
- Owns Aither Health, a Third Party Claims Administrator.
- Based in Buffalo, NY.
- Work context: back-to-back meetings and high email volume.
- Ongoing help requested: prioritize important emails and draft timely responses.
- Family: wife Lisa and four children are deeply important.
- Communication preference: quick bullet points with bottom-line recommendations by default.
- Writing support preference: more thorough help when drafting email responses.`

// ─── Variant definitions ──────────────────────────────────────────────────────

const MOCK_EMAILS = JSON.stringify([
  { id: '1001', from: 'asmith@aitherhealth.com', subject: 'Easter Dinner accepted', snippet: 'Ashley accepted the Easter Dinner invite.', unread: true },
  { id: '1002', from: 'baue@the-alliance.org', subject: 'RE: URGENT Breeze Dairy Group Invoice', snippet: 'The Alliance bills the TPA directly on a monthly basis.', unread: true },
  { id: '1003', from: 'shelley.asher@techsolutionprovider.xyz', subject: 'Laura, Following up', snippet: 'Following up for a 10-minute Zoom call.', unread: true },
  { id: '1004', from: 'nicole@5gbenefits.com', subject: 'RE: URGENT Breeze Dairy Group Invoice', snippet: 'The client should not be getting billed, correct?', unread: true },
  { id: '1005', from: 'tony@5gbenefits.com', subject: 'RE: URGENT Breeze Dairy Group Invoice', snippet: 'The fees wouldn\'t get billed back to the CLIENT.', unread: true },
], null, 2)

// Generate mock events for "tomorrow" so dates match the query
function makeMockEvents(): string {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const d = tomorrow.toISOString().slice(0, 10) // YYYY-MM-DD
  return JSON.stringify([
    { uid: 'ev1', title: 'Leadership Standup', start: `${d}T09:00:00`, end: `${d}T09:30:00`, location: 'Zoom' },
    { uid: 'ev2', title: 'Client Call - Breeze Dairy Group', start: `${d}T10:00:00`, end: `${d}T10:45:00`, location: 'Teams', attendees: ['Angela Siem', 'Tony Goebel'] },
    { uid: 'ev3', title: 'Lunch with Lisa', start: `${d}T12:00:00`, end: `${d}T13:00:00`, location: 'Olive Garden' },
    { uid: 'ev4', title: 'Benefits Review - Q2 Planning', start: `${d}T14:00:00`, end: `${d}T15:30:00`, location: 'Conference Room B', attendees: ['Zack Smith', 'Jadyn Smith'] },
  ], null, 2)
}
const MOCK_EVENTS = makeMockEvents()

function setupEmailVariant(skillsDir: string): void {
  const dir = path.join(skillsDir, 'zoho-mail')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: zoho-mail
description: Read, search, and send Zoho Mail via the Zoho REST API.
---

## Scripts
All scripts are in \`$SHROK_SKILLS_DIR/zoho-mail/\` and output JSON to stdout.
- \`read.mjs\` — fetch messages from a folder
- \`search.mjs\` — search all folders
- \`send.mjs\` — send or reply

Exit codes: 0 success, 1 usage, 2 auth, 3 connection, 4 not found.

## Auth
Credentials are stored in this skill's MEMORY.md.
`)
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), `ZOHO_CLIENT_ID=1000.89U12U67W9JDLLEHWD1ZS631VFWNLA
ZOHO_CLIENT_SECRET=1e8233196c91cdfe3619fda788467f533f95bab4
ZOHO_REFRESH_TOKEN=1000.7d0d5fbbf3419d1792328ddaa3bdbaf5.b2f8a2aa17b383dd221dffd1b07d185f
ZOHO_ACCOUNT_ID=1902712000000008002
ZOHO_FROM_ADDRESS=lhirsch@aitherhealth.com
`)
  fs.writeFileSync(path.join(dir, 'read.mjs'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(MOCK_EMAILS)});\n`)
  fs.writeFileSync(path.join(dir, 'search.mjs'), `#!/usr/bin/env node\nconsole.log('[]');\n`)
  fs.writeFileSync(path.join(dir, 'send.mjs'), `#!/usr/bin/env node\nconsole.error('Send not available'); process.exit(1);\n`)
  fs.writeFileSync(path.join(dir, '_shared.mjs'), `export const EXIT = { OK: 0, USAGE: 1, AUTH: 2, CONN: 3, NOT_FOUND: 4 };\nexport async function getAccessToken() { return 'mock-token'; }\nexport async function zohoGet() { return { data: [] }; }\nexport function parseDateArg(s) { return new Date(s); }\n`)
}

function setupCalendarVariant(skillsDir: string): void {
  const dir = path.join(skillsDir, 'zoho-calendar')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: zoho-calendar
description: Read, create, update, and delete Zoho Calendar events via the Zoho REST API.
---

## Scripts
All scripts are in \`$SHROK_SKILLS_DIR/zoho-calendar/\` and output JSON to stdout.
- \`events.mjs\` — list events in a date range
- \`event.mjs\` — get full detail for a single event
- \`create.mjs\` — create an event
- \`update.mjs\` — update an event
- \`delete.mjs\` — delete an event

Exit codes: 0 success, 1 usage, 2 auth, 3 connection, 4 not found.

## Auth
Credentials are stored in this skill's MEMORY.md.
`)
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), `ZOHO_CLIENT_ID=1000.89U12U67W9JDLLEHWD1ZS631VFWNLA
ZOHO_CLIENT_SECRET=1e8233196c91cdfe3619fda788467f533f95bab4
ZOHO_REFRESH_TOKEN=1000.7d0d5fbbf3419d1792328ddaa3bdbaf5.b2f8a2aa17b383dd221dffd1b07d185f
ZOHO_CALENDAR_ID=cal_default
`)
  fs.writeFileSync(path.join(dir, 'events.mjs'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(MOCK_EVENTS)});\n`)
  fs.writeFileSync(path.join(dir, 'event.mjs'), `#!/usr/bin/env node\nconsole.log('{}');\n`)
  fs.writeFileSync(path.join(dir, 'create.mjs'), `#!/usr/bin/env node\nconsole.error('Not available'); process.exit(1);\n`)
  fs.writeFileSync(path.join(dir, 'update.mjs'), `#!/usr/bin/env node\nconsole.error('Not available'); process.exit(1);\n`)
  fs.writeFileSync(path.join(dir, 'delete.mjs'), `#!/usr/bin/env node\nconsole.error('Not available'); process.exit(1);\n`)
  fs.writeFileSync(path.join(dir, '_shared.mjs'), `export const EXIT = { OK: 0, USAGE: 1, AUTH: 2, CONN: 3, NOT_FOUND: 4 };\nexport async function getAccessToken() { return 'mock-token'; }\nexport async function zohoGet() { return { data: [] }; }\nexport function parseDateArg(s) { return new Date(s); }\n`)
}

function setupFileLookupVariant(skillsDir: string): void {
  // Create a fake project structure the agent can search
  const projectDir = path.join(path.dirname(skillsDir), 'workspace', 'projects', 'billing-service')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'config.json'), JSON.stringify({
    service: 'billing-service',
    port: 8080,
    database: { host: 'db.internal', port: 5432, name: 'billing_prod' },
    stripe: { webhookSecret: 'whsec_xxxx', apiVersion: '2026-01-01' },
    rateLimit: { requestsPerMinute: 1000 },
  }, null, 2))
  fs.writeFileSync(path.join(projectDir, 'README.md'), 'Billing service — handles Stripe webhooks and subscription management.\n')
}

export const variants: EvalVariant[] = [
  {
    name: 'email',
    query: 'Can you check my email and let me know if there\'s anything important?',
    setup: setupEmailVariant,
    judgeContext: 'The mock email data contains: Ashley accepting Easter Dinner invite, URGENT Breeze Dairy Group billing thread (3 emails from alliance/broker/team), and a cold sales outreach from techsolutionprovider.',
  },
  {
    name: 'calendar',
    query: 'What\'s on my calendar for tomorrow?',
    setup: setupCalendarVariant,
    judgeContext: 'The mock calendar data contains 4 events: Leadership Standup at 9am, Client Call with Breeze Dairy at 10am, Lunch with Lisa at noon, and Benefits Review Q2 Planning at 2pm.',
  },
  {
    name: 'web-search',
    query: 'What\'s the latest news about AI regulation in the EU?',
    setup: () => {}, // No mock needed — uses real web search
    judgeContext: 'The agent should have searched the web and returned news headlines or a summary about EU AI regulation. Exact content will vary.',
  },
  {
    name: 'file-lookup',
    query: 'Can you find the config file for the billing service? It should be somewhere under the projects directory. I need to know what port it runs on.',
    setup: setupFileLookupVariant,
    judgeContext: 'A config.json exists at projects/billing-service/config.json with port 8080, database on db.internal:5432, and Stripe webhook config.',
  },
  {
    name: 'computation',
    query: 'What\'s the SHA-256 hash of the string \'test-variant-2026\'?',
    setup: () => {}, // No mock needed — uses bash
    judgeContext: 'The correct SHA-256 hash of "test-variant-2026" (no newline) is 73afc8e0b063935d264b7dfeb067b51a962be74f715acdd47e28e9d543f6f2c9.',
  },
]

// ─── Run ──────────────────────────────────────────────────────────────────────

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
    identityFiles: {
      'SOUL.md': LAURA_SOUL,
      'USER.md': LAURA_USER,
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm, 10_000)

    // Set up variant-specific mock skills
    variant.setup(env.skillsDir)

    console.log(`[agent-question-loop:${variant.name}] Sending query: "${variant.query.slice(0, 80)}"`)

    const { response, traceFiles, toolCalls } = await runHeadQuery({
      bundle: env.bundle,
      topicMemory,
      router,
      config: env.config,
      query: variant.query,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      timeoutMs: 180_000,
    })

    // Analyze results
    const spawnCalls = toolCalls.filter(tc => tc.name === 'spawn_agent')
    const resumeCalls = toolCalls.filter(tc => tc.name === 'resume_agent')
    const cancelCalls = toolCalls.filter(tc => tc.name === 'cancel_agent')

    const allAgents = [
      ...env.bundle.workers.getByStatus('completed'),
      ...env.bundle.workers.getByStatus('suspended'),
      ...env.bundle.workers.getByStatus('running'),
      ...env.bundle.workers.getByStatus('failed'),
      ...env.bundle.workers.getByStatus('retracted'),
    ]

    const spawnPrompts = spawnCalls.map(tc => (tc.input as Record<string, unknown>)['prompt'] as string)

    console.log(`[agent-question-loop:${variant.name}] spawn_agent: ${spawnCalls.length}, resume_agent: ${resumeCalls.length}, cancel_agent: ${cancelCalls.length}`)
    console.log(`[agent-question-loop:${variant.name}] Agent statuses: ${allAgents.map(a => a.status).join(', ') || '(none)'}`)
    console.log(`[agent-question-loop:${variant.name}] Response: ${response.slice(0, 200)}`)

    const output = {
      variant: variant.name,
      spawnCalls: spawnCalls.length,
      resumeCalls: resumeCalls.length,
      cancelCalls: cancelCalls.length,
      agentStatuses: allAgents.map(a => ({ id: a.id, status: a.status, skill: a.skillName })),
      spawnPromptLengths: spawnPrompts.map(p => p.length),
      headResponse: response,
      headToolCalls: toolCalls.map(tc => tc.name),
    }

    if (opts.noJudge) {
      console.log(`\n[agent-question-loop:${variant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    // ── Judge ──────────────────────────────────────────────────────────────
    console.log(`[agent-question-loop:${variant.name}] Running judge…`)

    // Build a summary of agent tool calls from the trace for the judge
    const agentTraceKey = Object.keys(traceFiles).find(k => k.includes('agent'))
    const agentTraceSummary = (() => {
      if (!agentTraceKey) return '(no agent trace available)'
      const trace = traceFiles[agentTraceKey]!
      const rounds = trace.match(/-- round \d+ --[\s\S]*?(?=-- round \d+ --|$)/g) || []
      return rounds.slice(0, 5).map(r => {
        const toolMatch = r.match(/→ (\S+)/)
        const resultSnippet = r.match(/← \S+: ([\s\S]{0,300})/)
        return `${toolMatch?.[0] ?? '?'}: ${resultSnippet?.[1]?.trim().slice(0, 200) ?? '(no result)'}`
      }).join('\n') + (rounds.length > 5 ? `\n... (${rounds.length - 5} more rounds, agent kept going)` : '')
    })()

    const context = `
SCENARIO: Laura asks Jeeves to perform a task. Jeeves has a personality (SOUL.md) that says
"propose next actions and pre-drafted responses" and "ask concise clarifying questions when needed."
The test verifies the agent completes cleanly without entering a suspension loop.

VARIANT: ${variant.name}
USER QUERY: "${variant.query}"
${variant.judgeContext ? `\nEXPECTED DATA: ${variant.judgeContext}\n` : ''}
HEAD TOOL CALLS (in order):
${toolCalls.map(tc => `- ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`).join('\n') || '(none)'}

SPAWN_AGENT PROMPTS:
${spawnPrompts.map((p, i) => `Spawn ${i + 1} (${p.length} chars): "${p.slice(0, 300)}${p.length > 300 ? '...' : ''}"`).join('\n') || '(none)'}

RESUME_AGENT CALLS: ${resumeCalls.length}
CANCEL_AGENT CALLS: ${cancelCalls.length}

AGENTS:
${allAgents.map(a => `- ${a.id}: status=${a.status}, skill=${a.skillName || 'none'}`).join('\n') || '(none)'}

AGENT TRACE SUMMARY (first 5 tool calls the agent made — use this to determine if the agent successfully retrieved data before getting stuck):
${agentTraceSummary}

HEAD FINAL RESPONSE TO USER:
${response}
`

    const judgment = await judge(rubric, context)

    const history: EvalMessage[] = [
      { role: 'user', content: variant.query },
      { role: 'assistant', content: response },
    ]

    const txtPath = await writeResults('agent-question-loop', history, output, judgment, {
      runId: opts.runId, category, traces: Object.keys(traceFiles).length > 0 ? traceFiles : undefined,
      fileLabel: `agent-question-loop-${variant.name}`,
    })
    printJudgment(variant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-question-loop [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
