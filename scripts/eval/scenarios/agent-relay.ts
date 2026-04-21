/**
 * Agent relay stress test — with task variants.
 *
 * Measures whether the head correctly relays agent results to the user
 * and whether it hallucinates system-level patterns after seeing many
 * prior completion cycles in its history.
 *
 * Strategy: 15 prior cycles with XML tags, ~half with Round 2 assistant messages.
 * Live test forces Round 2 by removing spawn_agent from terminalTools.
 * Two back-to-back live questions per variant.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTopicMemory } from '../../../src/memory/index.js'
import { loadConfig } from '../../../src/config.js'
import { createLLMRouter } from '../../../src/llm/index.js'
import { generateId } from '../../../src/llm/util.js'
import { HEAD_TOOLS } from '../../../src/head/index.js'
import type { Message, ToolCall, ToolResult } from '../../../src/types/core.js'
import type { LLMRouter } from '../../../src/types/llm.js'
import {
  judge,
  writeResults,
  makeLLMFunction,
  makeProductionEnvironment,
  cleanupEnvironment,
  runHeadQuery,
  type EvalMessage,
  type EvalVariant,
  type Judgment,
} from '../harness.js'
import { MessageStore } from '../../../src/db/messages.js'
import { MARKER_TAGS, LEGACY_MARKER_PREFIXES } from '../../../src/markers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HAIKU = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'

export const name = 'agent-relay'
export const description = 'Multi-cycle agent completion history (15 prior cycles) — correct relay + no hallucination (variants: weather, stock, news)'
export const category = 'routing'
export const estimatedCostUsd = 0.30
export const rubric = [
  'correct_relay — Did the head deliver substantive results for BOTH questions? Score 1.0 if both have real data, 0.5 if only one did, 0.0 if neither.',
  'no_system_hallucination — Did the head avoid emitting internal system XML tags (<system-trigger>, <agent-result>, <prior-tool>, <prior-result>, etc.) in its channel output? Score 0.0 if any such tag appears.',
  'no_spurious_tools — Did the head avoid calling message_agent on already-completed agents? Score 0.0 if it called message_agent at all.',
]

// ─── Variants ─────────────────────────────────────────────────────────────────

interface RelayVariant {
  name: string
  q1: string
  q2: string
  judgeContext: string
}

const RELAY_VARIANTS: RelayVariant[] = [
  {
    name: 'weather',
    q1: "what's the weather in Denver right now?",
    q2: "and what's the forecast for tomorrow in Denver?",
    judgeContext: 'Q1 should contain current Denver weather (temperature, conditions). Q2 should contain tomorrow\'s forecast.',
  },
  {
    name: 'stock-lookup',
    q1: "what's the current price of AAPL stock?",
    q2: 'how has it performed over the last week?',
    judgeContext: 'Q1 should contain Apple/AAPL stock price. Q2 should contain recent performance or trend data.',
  },
  {
    name: 'news-summary',
    q1: 'give me a summary of today\'s top tech news',
    q2: 'any AI-specific developments in that news?',
    judgeContext: 'Q1 should contain several tech news headlines or summaries. Q2 should focus on AI-related items from the news.',
  },
]

// Export as EvalVariant[] for the runner (setup is a no-op for relay variants)
export const variants: EvalVariant[] = RELAY_VARIANTS.map(v => ({
  name: v.name,
  query: v.q1, // not used directly — relay has its own q1/q2 pattern
  setup: () => {},
  judgeContext: v.judgeContext,
}))

// ─── Routers ──────────────────────────────────────────────────────────────────

function makeHeadRouter(): LLMRouter {
  const config = loadConfig()
  return createLLMRouter({
    ...config,
    anthropicModelStandard: HAIKU,
    anthropicModelCapable: SONNET,
    anthropicModelExpert: SONNET,
  })
}

function makeAgentRouter(): LLMRouter {
  const config = loadConfig()
  return createLLMRouter({
    ...config,
    anthropicModelStandard: HAIKU,
    anthropicModelCapable: HAIKU,
    anthropicModelExpert: HAIKU,
  })
}

const EVAL_HEAD_TOOLS = HEAD_TOOLS.map(t => {
  if (t.name !== 'spawn_agent') return t
  const description = t.description
    .replace(/\s*Always include a brief acknowledgment.*?the loop exits immediately after\./, '')
    .trim()
  return { ...t, description }
})

// ─── History seeder (unchanged — same 15 cycles for all variants) ─────────────

function seedPriorHistory(messages: MessageStore, triggerFormat: 'system' | 'activate'): void {
  const cycles: Array<{
    userMsg: string
    agentId: string
    workTranscript: string
    agentOutput: string
    round2Text?: string
    headReply: string
  }> = [
    { userMsg: "what's Apple's stock price?", agentId: 'tent_1774500001000_aaaaaa', workTranscript: '<prior-tool name="web_search">{"query":"Apple AAPL stock price today"}</prior-tool>\n<prior-result name="web_search">AAPL: $198.45 +1.2%</prior-result>', agentOutput: 'Apple (AAPL) is trading at $198.45, up 1.2% today.', headReply: 'Apple is at $198.45, up 1.2% on the day.' },
    { userMsg: 'how about Tesla?', agentId: 'tent_1774500060000_bbbbbb', workTranscript: '<prior-tool name="web_search">{"query":"Tesla TSLA stock price"}</prior-tool>\n<prior-result name="web_search">TSLA: $312.80 -0.8%</prior-result>', agentOutput: 'Tesla (TSLA) is at $312.80, down 0.8%.', round2Text: 'Looking that up for you...', headReply: 'Tesla is at $312.80, down 0.8%.' },
    { userMsg: "what was the score of last night's Celtics game?", agentId: 'tent_1774500120000_cccccc', workTranscript: '<prior-tool name="web_search">{"query":"Celtics game score"}</prior-tool>\n<prior-result name="web_search">Celtics 118, Heat 104. Tatum: 34 pts.</prior-result>', agentOutput: 'Celtics beat the Heat 118-104. Tatum had 34 points.', headReply: 'Celtics 118, Heat 104. Tatum dropped 34.' },
    { userMsg: 'who won the Super Bowl this year?', agentId: 'tent_1774500180000_dddddd', workTranscript: '<prior-tool name="web_search">{"query":"Super Bowl 2026"}</prior-tool>\n<prior-result name="web_search">Eagles 27, Chiefs 24. Feb 8, 2026.</prior-result>', agentOutput: 'Eagles beat the Chiefs 27-24 in Super Bowl LX.', round2Text: 'Let me find that...', headReply: 'Eagles won Super Bowl LX, 27-24 over the Chiefs.' },
    { userMsg: 'any big AI news lately?', agentId: 'tent_1774500240000_eeeeee', workTranscript: '<prior-tool name="web_search">{"query":"AI news March 2026"}</prior-tool>\n<prior-result name="web_search">GPT-5 released; EU AI Act enforcement began</prior-result>', agentOutput: 'GPT-5 dropped March 20, EU AI Act enforcement started in February.', headReply: 'GPT-5 launched March 20, EU AI Act enforcement is live.' },
    { userMsg: "what's the Bitcoin price?", agentId: 'tent_1774500300000_ffffff', workTranscript: '<prior-tool name="web_search">{"query":"BTC price"}</prior-tool>\n<prior-result name="web_search">BTC: $87,240 +3.1%</prior-result>', agentOutput: 'Bitcoin is at $87,240, up 3.1% today.', round2Text: 'Checking crypto prices...', headReply: 'Bitcoin is at $87,240, up 3.1%.' },
    { userMsg: 'did the Lakers win last night?', agentId: 'tent_1774500360000_gggggg', workTranscript: '<prior-tool name="web_search">{"query":"Lakers game result"}</prior-tool>\n<prior-result name="web_search">Lakers 112, Nuggets 107. LeBron: 28 pts.</prior-result>', agentOutput: 'Lakers beat the Nuggets 112-107. LeBron had 28 points.', headReply: 'Lakers won 112-107 over the Nuggets.' },
    { userMsg: "what's the weather like in New York today?", agentId: 'tent_1774500420000_hhhhhh', workTranscript: '<prior-tool name="web_search">{"query":"NYC weather"}</prior-tool>\n<prior-result name="web_search">NYC: 52F, partly cloudy, wind 12 mph.</prior-result>', agentOutput: "52F in NYC, partly cloudy with 12 mph wind.", round2Text: 'One sec, pulling up the weather...', headReply: '52F in NYC, partly cloudy, wind at 12 mph.' },
    { userMsg: 'how is Nvidia doing today?', agentId: 'tent_1774500480000_iiiiii', workTranscript: '<prior-tool name="web_search">{"query":"NVDA stock"}</prior-tool>\n<prior-result name="web_search">NVDA: $875.20 -1.4%</prior-result>', agentOutput: 'Nvidia (NVDA) is at $875.20, down 1.4% today.', headReply: 'Nvidia is down 1.4% at $875.20.' },
    { userMsg: 'what happened at the Fed meeting this week?', agentId: 'tent_1774500540000_jjjjjj', workTranscript: '<prior-tool name="web_search">{"query":"Fed FOMC meeting"}</prior-tool>\n<prior-result name="web_search">Fed held rates at 4.25-4.5%. 2 cuts projected for 2026.</prior-result>', agentOutput: 'Fed held rates at 4.25-4.5%. Powell projects two cuts in 2026.', round2Text: 'Let me look into the Fed news...', headReply: 'Fed held rates at 4.25-4.5%. Still projecting 2 cuts this year.' },
    { userMsg: 'any news on the Ukraine war?', agentId: 'tent_1774500600000_kkkkkk', workTranscript: '<prior-tool name="web_search">{"query":"Ukraine war news"}</prior-tool>\n<prior-result name="web_search">Istanbul ceasefire talks stalled. US $2B aid package.</prior-result>', agentOutput: 'Ceasefire talks stalled. US announced $2B aid package.', headReply: 'Istanbul talks stalled. US announced $2B in aid.' },
    { userMsg: "what's Ethereum at?", agentId: 'tent_1774500660000_llllll', workTranscript: '<prior-tool name="web_search">{"query":"ETH price"}</prior-tool>\n<prior-result name="web_search">ETH: $2,184 +1.8%</prior-result>', agentOutput: 'Ethereum is at $2,184, up 1.8%.', round2Text: 'Looking that up...', headReply: 'Ethereum at $2,184, up 1.8%.' },
    { userMsg: 'who is leading the Masters right now?', agentId: 'tent_1774500720000_mmmmmm', workTranscript: '<prior-tool name="web_search">{"query":"Masters leaderboard"}</prior-tool>\n<prior-result name="web_search">McIlroy -6, Scheffler -5, Rahm -4.</prior-result>', agentOutput: 'McIlroy leads at -6. Scheffler -5, Rahm -4.', headReply: 'McIlroy leads at -6 after R1.' },
    { userMsg: 'what did Trump say about tariffs today?', agentId: 'tent_1774500780000_nnnnnn', workTranscript: '<prior-tool name="web_search">{"query":"Trump tariffs"}</prior-tool>\n<prior-result name="web_search">25% tariffs on EU auto imports, effective April 1.</prior-result>', agentOutput: '25% tariffs on EU auto imports effective April 1.', round2Text: 'Checking the latest...', headReply: '25% tariffs on EU autos starting April 1.' },
    { userMsg: 'any new iPhone rumors?', agentId: 'tent_1774500840000_oooooo', workTranscript: '<prior-tool name="web_search">{"query":"iPhone 18 rumors"}</prior-tool>\n<prior-result name="web_search">iPhone 18: foldable model ~$1,899, A20 chip, Sept 2026.</prior-result>', agentOutput: 'iPhone 18 expected Sept 2026. Foldable at ~$1,899, A20 chip.', round2Text: 'Let me search for that...', headReply: 'iPhone 18 coming Sept 2026 — foldable at ~$1,899.' },
  ]

  let t = Date.now() - 600_000
  const step = () => new Date(t += 2000).toISOString()
  const trigger = (agentId: string) =>
    triggerFormat === 'system' ? `<system-trigger type="agent-completed" agent="${agentId}" />` : '<system-trigger type="activate" />'

  for (const c of cycles) {
    const tcId = generateId('tc')
    messages.append({ kind: 'text', id: generateId('msg'), role: 'user', content: c.userMsg, createdAt: step() })

    if (c.round2Text) {
      messages.append({ kind: 'tool_call', id: generateId('msg'), content: '', toolCalls: [{ id: tcId, name: 'spawn_agent', input: { prompt: `Look up: ${c.userMsg}` } }] as [ToolCall, ...ToolCall[]], createdAt: step() })
      messages.append({ kind: 'tool_result', id: generateId('msg'), toolResults: [{ toolCallId: tcId, name: 'spawn_agent', content: `<agent-result type="completed" agent="${c.agentId}">${c.workTranscript}\n\n${c.agentOutput}</agent-result>` }] as [ToolResult, ...ToolResult[]], createdAt: step() })
      messages.append({ kind: 'text', id: generateId('msg'), role: 'assistant', content: c.round2Text, createdAt: step() })
      messages.append({ kind: 'text', id: generateId('msg'), role: 'user', content: trigger(c.agentId), injected: true, createdAt: step() })
    } else {
      messages.append({ kind: 'tool_call', id: generateId('msg'), content: 'On it.', toolCalls: [{ id: tcId, name: 'spawn_agent', input: { prompt: `Look up: ${c.userMsg}` } }] as [ToolCall, ...ToolCall[]], createdAt: step() })
      messages.append({ kind: 'tool_result', id: generateId('msg'), toolResults: [{ toolCallId: tcId, name: 'spawn_agent', content: `<agent-result type="completed" agent="${c.agentId}">${c.workTranscript}\n\n${c.agentOutput}</agent-result>` }] as [ToolResult, ...ToolResult[]], createdAt: step() })
      messages.append({ kind: 'text', id: generateId('msg'), role: 'user', content: trigger(c.agentId), injected: true, createdAt: step() })
    }

    messages.append({ kind: 'text', id: generateId('msg'), role: 'assistant', content: c.headReply, createdAt: step() })
  }
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

const HALLUCINATION_MARKERS = [...MARKER_TAGS, ...LEGACY_MARKER_PREFIXES, '[prior:', '[prior result:']

function detectSystemHallucination(text: string): string[] {
  return HALLUCINATION_MARKERS.filter(m => text.includes(m))
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export async function run(opts: { replayHistory?: EvalMessage[]; noJudge?: boolean; runId?: string; variant?: EvalVariant }): Promise<void> {
  const variantName = opts.variant?.name ?? RELAY_VARIANTS[0]!.name
  const relayVariant = RELAY_VARIANTS.find(v => v.name === variantName) ?? RELAY_VARIANTS[0]!

  const headRouter = makeHeadRouter()
  const agentRouter = makeAgentRouter()
  const llm = makeLLMFunction(headRouter)

  const env = makeProductionEnvironment({
    config: {
      contextWindowTokens: 200_000,
      archivalThresholdFraction: 0.99,
      llmMaxTokens: 2048,
    },
  })

  try {
    const topicMemory = createTopicMemory(path.join(env.workspaceDir, 'topics'), llm)

    console.log(`[agent-relay:${relayVariant.name}] Seeding 15 prior agent completion cycles...`)
    seedPriorHistory(env.bundle.messages, 'system')
    const priorCount = env.bundle.messages.count()
    console.log(`[agent-relay:${relayVariant.name}] Seeded ${priorCount} messages.`)

    const queryOpts = {
      bundle: env.bundle,
      topicMemory,
      router: headRouter,
      agentRouter,
      config: env.config,
      identityDir: env.identityDir,
      workspaceDir: env.workspaceDir,
      headTools: EVAL_HEAD_TOOLS,
      terminalToolNames: [] as string[],
      spawnAgentNote: "Agent spawned and running. Briefly acknowledge to the user that you're looking into it.",
      timeoutMs: 90_000,
    }

    console.log(`[agent-relay:${relayVariant.name}] Q1: "${relayVariant.q1}"`)
    const result1 = await runHeadQuery({ ...queryOpts, query: relayVariant.q1 })

    console.log(`[agent-relay:${relayVariant.name}] Q2: "${relayVariant.q2}"`)
    const result2 = await runHeadQuery({ ...queryOpts, query: relayVariant.q2 })

    const allSent = env.bundle.channelRouter.sent
    const responses = allSent.filter(s =>
      !s.text.startsWith('→') && !s.text.startsWith('←') && !s.text.startsWith('[head]') && !s.text.startsWith('[agent ')
    )
    const combinedResponse = responses.map(s => s.text).join('\n')
    console.log(`[agent-relay:${relayVariant.name}] Substantive responses (${responses.length}):\n${combinedResponse.slice(0, 300) || '(silent)'}`)

    const hallucinatedMarkers = detectSystemHallucination(combinedResponse)

    const newMessages = env.bundle.messages.getAll().slice(priorCount)
    const spuriousToolCalls = newMessages
      .filter(m => m.kind === 'tool_call')
      .flatMap(m => (m as import('../../../src/types/core.js').ToolCallMessage).toolCalls)
      .filter(tc => tc.name === 'message_agent')

    console.log(`[agent-relay:${relayVariant.name}] Hallucinated markers: ${hallucinatedMarkers.length > 0 ? hallucinatedMarkers.join(', ') : 'none'}`)
    console.log(`[agent-relay:${relayVariant.name}] Spurious message_agent calls: ${spuriousToolCalls.length}`)

    const output = {
      variant: relayVariant.name,
      q1: relayVariant.q1,
      q2: relayVariant.q2,
      priorCycles: 15,
      priorRound2Cycles: 7,
      response: combinedResponse,
      hallucinatedMarkers,
      spuriousToolCallCount: spuriousToolCalls.length,
    }

    const history: EvalMessage[] = [
      { role: 'user', content: '[Prior: 15 agent completion cycles seeded in history (7 with Round 2)]' },
      { role: 'user', content: `Q1: ${relayVariant.q1}` },
      { role: 'user', content: `Q2: ${relayVariant.q2}` },
      { role: 'assistant', content: combinedResponse || '(no response)' },
    ]

    const traceFiles = { ...result1.traceFiles, ...result2.traceFiles }

    if (opts.noJudge) {
      console.log(`\n[agent-relay:${relayVariant.name}] OUTPUT (--no-judge mode):`)
      console.log(JSON.stringify(output, null, 2))
      return
    }

    console.log(`[agent-relay:${relayVariant.name}] Running judge...`)
    const context = `
The Head has 15 prior agent completion cycles in history. 7 include Round 2 assistant messages.
Live test forces Round 2 after every spawn. Two live questions asked back-to-back.

VARIANT: ${relayVariant.name}
${relayVariant.judgeContext}

Q1: "${relayVariant.q1}"
Q2: "${relayVariant.q2}"

Head's combined channel output:
${combinedResponse || '(silent)'}

Heuristic flags:
- Hallucinated system markers: ${hallucinatedMarkers.length > 0 ? hallucinatedMarkers.join(', ') : 'none'}
- Spurious message_agent calls: ${spuriousToolCalls.length}
`

    const judgment = await judge(rubric, context)

    const txtPath = await writeResults('agent-relay', history, output, judgment, {
      runId: opts.runId, category, traces: traceFiles,
      fileLabel: `agent-relay-${relayVariant.name}`,
    })
    printJudgment(relayVariant.name, judgment, txtPath)
  } finally {
    cleanupEnvironment(env)
  }
}

function printJudgment(variantName: string, j: Judgment, txtPath: string): void {
  console.log(`\n── Agent-relay [${variantName}] eval results ──`)
  for (const [dim, { score, notes }] of Object.entries(j.dimensions)) {
    const icon = score >= 0.8 ? '✓' : score >= 0.5 ? '~' : '✗'
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}  ${notes}`)
  }
  console.log(`\n  ${j.overall}`)
  console.log(`  PASS: ${j.pass}`)
  console.log(`  Full report: ${txtPath}`)
}
