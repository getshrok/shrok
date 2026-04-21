/**
 * Eval harness — shared infrastructure for all Shrok eval scenarios.
 *
 * Provides: isolated DB setup, real LLM wiring, conversation generation,
 * LLM-as-judge, and result persistence.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { initDb, transaction } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import { MessageStore } from '../../src/db/messages.js'
import { AppStateStore } from '../../src/db/app_state.js'
import { UsageStore } from '../../src/db/usage.js'
import { AgentStore } from '../../src/db/agents.js'
import { QueueStore } from '../../src/db/queue.js'
import { ScheduleStore } from '../../src/db/schedules.js'
import { NoteStore } from '../../src/db/notes.js'
import { ReminderStore } from '../../src/db/reminders.js'
import { StewardRunStore } from '../../src/db/steward_runs.js'
import { buildSystem, type Stores } from '../../src/system.js'
import { ContextAssemblerImpl } from '../../src/head/assembler.js'
import type { ContextAssembler, AssembledContext } from '../../src/head/assembler.js'
import { InjectorImpl } from '../../src/head/injector.js'
import { HEAD_TOOLS } from '../../src/head/index.js'
import { loadConfig } from '../../src/config.js'
import { createLLMRouter } from '../../src/llm/index.js'
import { archiveMessages } from '../../src/head/archival.js'
import { generateId } from '../../src/llm/util.js'
import { PRIORITY } from '../../src/types/core.js'
import type { DatabaseSync } from '../../src/db/index.js'
import type { Config } from '../../src/config.js'
import type { LLMRouter, ToolDefinition } from '../../src/types/llm.js'
import type { LLMFunction } from 'infinitecontextwindow'
import type { Memory } from '../../src/memory/index.js'
import type { ChannelRouter } from '../../src/types/channel.js'
import type { QueueEvent, Attachment, ToolCallMessage } from '../../src/types/core.js'
import type { SkillLoader } from '../../src/types/skill.js'
import type { AgentRunner } from '../../src/types/agent.js'
import type { McpRegistry } from '../../src/mcp/registry.js'
import { FileSystemIdentityLoader } from '../../src/identity/loader.js'
import type { IdentityLoader } from '../../src/identity/loader.js'
import { FileSystemSkillLoader } from '../../src/skills/loader.js'
import { LocalAgentRunner } from '../../src/sub-agents/local.js'
import { AgentInboxStore } from '../../src/db/agent_inbox.js'
import { initTracer } from '../../src/tracer.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvalMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface Judgment {
  dimensions: Record<string, { score: number; notes: string }>
  narrative: string  // step-by-step walkthrough of what happened and why
  overall: string
  pass: boolean  // true if every dimension score >= 0.5
}

export interface EvalVariant {
  /** Short identifier, e.g. 'email', 'calendar', 'computation'. */
  name: string
  /** What the user says. */
  query: string
  /** Write mock skills/data into the given skills directory. */
  setup: (skillsDir: string) => void
  /** Extra context appended to the judge prompt so it knows what to look for in the response. */
  judgeContext?: string
}

export interface EvalServices {
  messages: MessageStore
  appState: AppStateStore
  usage: UsageStore
  agents: AgentStore
}

// ─── DB setup ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../sql')

/** Create an isolated in-memory DB with migrations applied. */
export function freshServices(): EvalServices {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  return {
    messages: new MessageStore(db),
    appState: new AppStateStore(db),
    usage: new UsageStore(db, 'UTC'),
    agents: new AgentStore(db),
  }
}

// ─── Head bundle ──────────────────────────────────────────────────────────────

export interface HeadBundle {
  db: DatabaseSync
  messages: MessageStore
  workers: AgentStore
  queue: QueueStore
  usage: UsageStore
  appState: AppStateStore
  schedules: ScheduleStore
  notes: NoteStore
  reminders: ReminderStore
  stewardRuns: StewardRunStore
  agentInbox: AgentInboxStore
  channelRouter: ChannelRouter & { sent: Array<{ channel: string; text: string }> }
  tx: (fn: () => void) => void
}

/**
 * Create a fresh isolated DB bundle for E2E eval scenarios that run through the Head.
 * All stores share one in-memory DB so archival and head query see the same state.
 */
export function freshHeadBundle(): HeadBundle {
  const db = initDb(':memory:')
  runMigrations(db, MIGRATIONS_DIR)
  const sent: Array<{ channel: string; text: string }> = []
  const channelRouter: ChannelRouter & { sent: Array<{ channel: string; text: string }> } = {
    sent,
    register: () => {},
    send: async (channel: string, text: string) => { sent.push({ channel, text }) },
    sendDebug: async (channel: string, text: string) => { sent.push({ channel, text }) },
    sendTyping: async (_channel: string) => {},
    getLastActiveChannel: () => null,
    getFirstChannel: () => null,
  }
  return {
    db,
    messages: new MessageStore(db),
    workers: new AgentStore(db),
    queue: new QueueStore(db),
    usage: new UsageStore(db, 'UTC'),
    appState: new AppStateStore(db),
    schedules: new ScheduleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-schedules-'))),
    notes: new NoteStore(db),
    reminders: new ReminderStore(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-reminders-'))),
    stewardRuns: new StewardRunStore(db),
    agentInbox: new AgentInboxStore(db),
    channelRouter,
    tx: (fn: () => void) => transaction(db, fn),
  }
}

// ─── LLM wiring ───────────────────────────────────────────────────────────────

/** Load config from env and return a real LLM router. */
export function makeLLMRouter(): { router: LLMRouter; config: Config } {
  const config = loadConfig()
  const router = createLLMRouter(config)
  return { router, config }
}

/** Wrap an LLMRouter into the simple (system, user) => string LLMFunction the memory lib expects. */
export function makeLLMFunction(router: LLMRouter): LLMFunction {
  return (system: string, user: string) =>
    router.complete(
      'standard',
      [{ kind: 'text' as const, id: 'mem-llm', role: 'user' as const, content: user, createdAt: new Date().toISOString() }],
      [],
      { systemPrompt: system, maxTokens: 16_000 },
    ).then(r => r.content)
}

// ─── Conversation generation ──────────────────────────────────────────────────

/**
 * Generate a realistic conversation using the LLM.
 *
 * @param llm  The LLMFunction to use for generation.
 * @param seed  Natural-language description of what the conversation should cover.
 * @param turns  Approximate number of message turns to generate.
 * @returns Array of {role, content} messages.
 */
export async function generateHistory(
  llm: LLMFunction,
  seed: string,
  turns: number,
): Promise<EvalMessage[]> {
  const system = `You generate realistic conversational transcripts between a user and an AI assistant called Shrok.

Rules:
- Output ONLY a JSON array of objects: [{"role":"user","content":"..."},{"role":"assistant","content":"..."},...]
- Alternate user/assistant turns, starting with user
- Make it feel authentic — use natural language, abbreviations, topic drift, follow-ups
- Include specific details (names, dates, numbers) that would be worth remembering
- IMPORTANT: Messages must be substantial and realistic in length. User messages should be 2-4 sentences (sometimes longer when explaining something). Assistant messages should be 3-8 sentences with specific details, explanations, and follow-up thoughts. Avoid one-liner responses — real conversations have substance.
- Do NOT include any text outside the JSON array`

  const prompt = `Generate a conversation of approximately ${turns} turns (${Math.ceil(turns / 2)} user messages + ${Math.ceil(turns / 2)} assistant replies).

Each message should be substantive — users explain context and ask detailed questions, the assistant gives thorough responses with specifics. Aim for 400-800 characters per message on average.

Topic/scenario: ${seed}`

  const raw = await llm(system, prompt)

  // Extract JSON array from response (model may wrap in markdown code fences)
  const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '')
  let match = stripped.match(/\[[\s\S]*\]/)

  // If no complete array found, try to salvage a truncated one by closing it
  if (!match) {
    const arrayStart = stripped.indexOf('[')
    if (arrayStart !== -1) {
      // Find the last complete JSON object (ending with })
      const partial = stripped.slice(arrayStart)
      const lastBrace = partial.lastIndexOf('}')
      if (lastBrace !== -1) {
        const salvaged = partial.slice(0, lastBrace + 1) + ']'
        try {
          JSON.parse(salvaged)
          match = [salvaged]
          console.warn(`[generateHistory] Salvaged truncated JSON (${salvaged.length} chars)`)
        } catch {
          // Couldn't salvage — fall through to error
        }
      }
    }
    if (!match) throw new Error(`generateHistory: could not find JSON array in response.\nRaw:\n${raw.slice(0, 500)}`)
  }

  let parsed: unknown[]
  try {
    parsed = JSON.parse(match[0]) as unknown[]
  } catch {
    // Walk backward through closing braces to find a valid JSON cut point
    let salvaged: unknown[] | null = null
    let searchFrom = match[0].length
    for (let attempt = 0; attempt < 50; attempt++) {
      const bracePos = match[0].lastIndexOf('}', searchFrom - 1)
      if (bracePos === -1) break
      try {
        salvaged = JSON.parse(match[0].slice(0, bracePos + 1) + ']') as unknown[]
        console.warn(`[generateHistory] Salvaged truncated JSON array (${salvaged.length} items, attempt ${attempt + 1})`)
        break
      } catch {
        searchFrom = bracePos
      }
    }
    if (!salvaged) throw new Error(`generateHistory: malformed JSON, salvage failed.\nRaw:\n${raw.slice(0, 500)}`)
    parsed = salvaged
  }

  return parsed.filter(
    (m): m is EvalMessage =>
      typeof m === 'object' && m !== null &&
      'role' in m && 'content' in m &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string',
  )
}

/**
 * Like generateHistory but loads from a pre-committed fixture file if one exists.
 * On first run (no fixture), generates normally and saves to disk so subsequent
 * runs are deterministic and free of LLM token-budget issues.
 */
export async function generateHistoryCached(
  llm: LLMFunction,
  fixtureName: string,
  seed: string,
  turns: number,
): Promise<EvalMessage[]> {
  const fixturePath = path.join(__dirname, 'fixtures', `${fixtureName}.json`)
  if (fs.existsSync(fixturePath)) {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as EvalMessage[]
  }
  const history = await generateHistory(llm, seed, turns)
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(fixturePath, JSON.stringify(history, null, 2), 'utf8')
  return history
}

// ─── LLM judge ────────────────────────────────────────────────────────────────

/**
 * Ask a capable model to evaluate system output against a rubric.
 *
 * @param rubric  Array of dimension names to score (each gets 0.0–1.0 + notes).
 * @param context  Everything the judge needs: what was generated, what the system produced.
 */
export async function judge(
  rubric: string[],
  context: string,
): Promise<Judgment> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — needed for judge')
  const anthropic = new Anthropic({ apiKey })

  const dimensions = rubric.map(d => `- ${d}`).join('\n')
  const system = `You are an impartial evaluator of AI system outputs. Score each dimension from 0.0 (complete failure) to 1.0 (perfect). Be critical — reserve 1.0 for genuinely excellent results.

Output ONLY a JSON object matching this schema exactly:
{
  "dimensions": {
    "<dimension_name>": { "score": <0.0–1.0>, "notes": "<brief explanation>" }
  },
  "narrative": "- <what the scenario established and seeded (1–2 sentences)>\\n- <what the system did at the first key moment (1–2 sentences)>\\n- <how the system handled the main test / what its response showed (1–2 sentences)>\\n- <why each dimension scored the way it did (1–2 sentences)>\\n- <any notable failures or edge cases — omit bullet if nothing notable>",
  "overall": "<1–2 sentence summary of overall quality and pass/fail verdict>"
}

Keep dimension notes under 40 words each. Keep each narrative bullet under 50 words. Do not quote or reproduce long passages from the context.

Do not include any text outside the JSON object.`

  const prompt = `Evaluate the following system output. Score each of these dimensions:
${dimensions}

--- CONTEXT ---
${context}`

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: prompt }],
    // Note: structured output not used here — Anthropic requires additionalProperties: false
    // on all object types, but dimensions has dynamic keys from the rubric.
    // The 16K token limit and explicit prompt instructions are sufficient.
  })

  const block = resp.content[0]
  if (!block || block.type !== 'text') throw new Error('judge: unexpected response format')

  const match = block.text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`judge: could not find JSON in response.\nRaw:\n${block.text.slice(0, 500)}`)

  const parsed = JSON.parse(match[0]) as { dimensions: Record<string, { score: number; notes: string }>; narrative: string; overall: string }

  const pass = Object.values(parsed.dimensions).every(d => d.score >= 0.5)
  return { ...parsed, pass }
}

// ─── Result writer ────────────────────────────────────────────────────────────

export interface EvalResult {
  scenario: string
  timestamp: string
  history: EvalMessage[]
  output: unknown
  judgment: Judgment
  traces?: Record<string, string>
}

/**
 * Write eval results to eval-results/ as both JSON and human-readable .txt.
 * Also persists a summary row to the Shrok workspace DB if available.
 * Returns the path to the .txt file.
 */
export async function writeResults(
  scenarioName: string,
  history: EvalMessage[],
  output: unknown,
  judgment: Judgment,
  opts?: { runId?: string | undefined; category?: string | undefined; traces?: Record<string, string> | undefined; fileLabel?: string | undefined },
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const ws = process.env['WORKSPACE_PATH'] ?? path.join(os.homedir(), '.shrok')
  const resultsDir = path.join(ws, 'eval-results')
  fs.mkdirSync(resultsDir, { recursive: true })

  // fileLabel allows a variant-qualified name for human-readable files while
  // scenarioName stays as the base name for DB grouping.
  const label = opts?.fileLabel ?? scenarioName
  const base = path.join(resultsDir, `${timestamp}-${label}`)
  const resultFile = `${timestamp}-${label}.json`

  const result: EvalResult = { scenario: scenarioName, timestamp, history, output, judgment, ...(opts?.traces ? { traces: opts.traces } : {}) }
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2), 'utf8')

  // Human-readable report
  const lines: string[] = [
    `EVAL: ${scenarioName}`,
    `Timestamp: ${timestamp}`,
    '',
    '═══ GENERATED HISTORY ═══',
    ...history.map(m => `[${m.role.toUpperCase()}] ${m.content}`),
    '',
    '═══ SYSTEM OUTPUT ═══',
    typeof output === 'string' ? output : JSON.stringify(output, null, 2),
    '',
    '═══ JUDGMENT ═══',
    judgment.narrative,
    '',
    judgment.overall,
    '',
    ...Object.entries(judgment.dimensions).map(
      ([dim, { score, notes }]) => `  ${score >= 0.5 ? '✓' : '✗'} ${dim}: ${score.toFixed(2)} — ${notes}`
    ),
    '',
    `PASS: ${judgment.pass}`,
  ]

  const txtPath = `${base}.txt`
  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8')

  // Persist summary to workspace DB (best-effort — skip if not available)
  try {
    const config = loadConfig()
    const dbPath = path.join(config.workspacePath.replace(/^~/, os.homedir()), 'data', 'shrok.db')
    if (fs.existsSync(dbPath)) {
      const db = initDb(dbPath)
      db.prepare(
        `INSERT INTO eval_results (id, run_id, scenario, category, pass, dimensions, narrative, overall, result_file, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('eval'),
        opts?.runId ?? generateId('run'),
        scenarioName,
        opts?.category ?? '',
        judgment.pass ? 1 : 0,
        JSON.stringify(judgment.dimensions),
        judgment.narrative,
        judgment.overall,
        resultFile,
        new Date().toISOString(),
      )
    }
  } catch { /* DB not migrated yet or not available — file result still written */ }

  return txtPath
}

// ─── Replay support ───────────────────────────────────────────────────────────

/** Load a previously saved history from a JSON result file (for --replay). */
export function loadHistoryFromResult(jsonPath: string): EvalMessage[] {
  const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as EvalResult
  return result.history
}

/** Load a pre-generated fixture for a scenario by name, if one exists. */
export function loadFixture(scenarioName: string): EvalMessage[] | undefined {
  const fixturePath = path.join(__dirname, 'fixtures', `${scenarioName}.json`)
  if (!fs.existsSync(fixturePath)) return undefined
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as EvalMessage[]
}

// ─── Filler messages ──────────────────────────────────────────────────────────

/**
 * 40 pairs (80 messages) of mundane everyday conversation, unrelated to any
 * eval scenario topic. Used to pad the message store so that historical content
 * sinks into the oldest-30% window and gets archived in 1–2 passes, leaving a
 * realistic context (filler + archival note hints) for the Head to query against.
 */
const FILLER_MESSAGES: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'What should I make for dinner tonight?' },
  { role: 'assistant', content: 'How about pasta? Quick and easy on a weeknight.' },
  { role: 'user', content: "It's been raining all day here." },
  { role: 'assistant', content: 'Perfect weather to stay in. Maybe a good time for a movie.' },
  { role: 'user', content: 'Can you recommend a podcast to listen to on my commute?' },
  { role: 'assistant', content: "Depends on your taste — news, comedy, true crime? I can narrow it down." },
  { role: 'user', content: 'I keep forgetting to water my plants.' },
  { role: 'assistant', content: 'Try setting a recurring reminder. Twice a week works for most houseplants.' },
  { role: 'user', content: 'What time does the post office close?' },
  { role: 'assistant', content: 'Usually 5 PM on weekdays, noon on Shroks — worth checking locally.' },
  { role: 'user', content: 'I need a good book recommendation.' },
  { role: 'assistant', content: "What genre? I can suggest something once I know what you enjoy." },
  { role: 'user', content: 'The Wi-Fi has been slow today.' },
  { role: 'assistant', content: 'Try restarting the router — that fixes it most of the time.' },
  { role: 'user', content: "What's a quick way to clean a keyboard?" },
  { role: 'assistant', content: 'Compressed air works well, or turn it upside down and give it a gentle shake.' },
  { role: 'user', content: 'I can never remember where I put my keys.' },
  { role: 'assistant', content: 'A small hook by the door helps — one place, every time.' },
  { role: 'user', content: 'Should I take an umbrella today?' },
  { role: 'assistant', content: "If there's any chance of rain, yes — better safe than sorry." },
  { role: 'user', content: 'I forgot to buy milk again.' },
  { role: 'assistant', content: 'Add it to a list on your phone so you always have it handy at the shop.' },
  { role: 'user', content: "What's a good stretch for a stiff neck?" },
  { role: 'assistant', content: 'Gentle side-to-side tilts work well. Hold each side for 20–30 seconds.' },
  { role: 'user', content: "I'm trying to drink more water." },
  { role: 'assistant', content: 'Keeping a glass on your desk helps — out of sight, out of mind.' },
  { role: 'user', content: 'The coffee maker is making a weird noise.' },
  { role: 'assistant', content: 'Could be scale buildup. Running a descaling cycle usually fixes it.' },
  { role: 'user', content: 'I need to write a thank-you note.' },
  { role: 'assistant', content: 'Short and specific is best — mention one thing you genuinely appreciated.' },
  { role: 'user', content: "What's a good tip for sleeping better?" },
  { role: 'assistant', content: 'Keeping the same wake time every day makes the biggest difference.' },
  { role: 'user', content: 'I burned the toast again.' },
  { role: 'assistant', content: 'Lower the setting and stay close — toasters vary a lot in heat.' },
  { role: 'user', content: 'My car needs an oil change.' },
  { role: 'assistant', content: 'Most modern cars are fine going 5,000–7,500 miles between changes.' },
  { role: 'user', content: 'I can never parallel park.' },
  { role: 'assistant', content: "Find the back bumper of the front car, pull up level with it, then angle in." },
  { role: 'user', content: "What's the best way to store fresh herbs?" },
  { role: 'assistant', content: 'Trim the stems and stand them in a glass of water in the fridge.' },
  { role: 'user', content: 'I keep snoozing my alarm.' },
  { role: 'assistant', content: 'Put your phone across the room so you have to get up to turn it off.' },
  { role: 'user', content: "What's a good snack for work?" },
  { role: 'assistant', content: 'Nuts and fruit travel well and keep you going without a sugar crash.' },
  { role: 'user', content: 'I need to send a package but keep forgetting.' },
  { role: 'assistant', content: 'Leave it right in front of your door so you literally have to step over it.' },
  { role: 'user', content: "The neighbor's music was loud last night." },
  { role: 'assistant', content: 'A white noise machine helps a lot if it becomes a recurring issue.' },
  { role: 'user', content: 'I want to learn to type faster.' },
  { role: 'assistant', content: 'Even 10 minutes a day on a typing practice site adds up quickly.' },
  { role: 'user', content: 'The grocery line was so long today.' },
  { role: 'assistant', content: 'Early morning or late evening tends to be the quietest.' },
  { role: 'user', content: 'I have too many browser tabs open.' },
  { role: 'assistant', content: "One pass — close anything you haven't looked at in the last hour." },
  { role: 'user', content: "What's a good way to wake up more alert?" },
  { role: 'assistant', content: 'Cold water on your face or a short walk outside works faster than coffee.' },
  { role: 'user', content: 'I need to declutter my desk.' },
  { role: 'assistant', content: "Start with anything that isn't used daily — move it out of reach." },
  { role: 'user', content: 'I got a parking ticket.' },
  { role: 'assistant', content: "Check if there's an appeal process — signage errors sometimes hold up." },
  { role: 'user', content: "What's a quick recipe for soup?" },
  { role: 'assistant', content: 'Sauté onion and garlic, add broth and whatever vegetables you have, simmer 20 minutes.' },
  { role: 'user', content: "My phone battery doesn't last all day anymore." },
  { role: 'assistant', content: 'Check which apps are draining background battery in settings.' },
  { role: 'user', content: 'I need to cancel a subscription I forgot about.' },
  { role: 'assistant', content: 'Check your bank statement for small recurring charges — that surfaces them all.' },
  { role: 'user', content: 'The light in the hallway burned out.' },
  { role: 'assistant', content: 'LED bulbs take about 30 seconds to swap and last years.' },
  { role: 'user', content: 'I always feel hungry an hour after breakfast.' },
  { role: 'assistant', content: 'Adding protein — eggs, yogurt, nuts — keeps you full much longer.' },
  { role: 'user', content: 'I spilled coffee on my shirt.' },
  { role: 'assistant', content: 'Cold water immediately, then dish soap — hot water sets the stain.' },
  { role: 'user', content: 'I need to mail a birthday card.' },
  { role: 'assistant', content: "If you order cards in bulk online, you'll always have one ready." },
  { role: 'user', content: 'My back hurts from sitting all day.' },
  { role: 'assistant', content: 'A few minutes standing or a short walk every hour makes a big difference.' },
  { role: 'user', content: 'I keep losing my sunglasses.' },
  { role: 'assistant', content: 'One hook by the door with a specific spot just for sunglasses.' },
  { role: 'user', content: "What's a good way to end the workday?" },
  { role: 'assistant', content: "Jotting down three things for tomorrow signals to your brain that work is done." },
]

/**
 * Append `count` filler messages to the bundle's message store.
 *
 * Filler is mundane, topic-neutral conversation that pads the store so
 * historical content sinks into the oldest-30% window. archiveUntilGone()
 * then completes in 1–2 passes, leaving a realistic context (remaining filler
 * + archival note hints) for the Head to query against.
 *
 * Call this AFTER collecting historicalIds and BEFORE archiveUntilGone.
 */
export function seedFillerMessages(bundle: HeadBundle, count: number): void {
  const base = Date.now() - count * 2_000
  for (let i = 0; i < count; i++) {
    const msg = FILLER_MESSAGES[i % FILLER_MESSAGES.length]!
    bundle.messages.append({
      kind: 'text',
      role: msg.role,
      id: generateId('msg'),
      content: msg.content,
      createdAt: new Date(base + i * 2_000).toISOString(),
    })
  }
}

// ─── Archival helper ──────────────────────────────────────────────────────────

/**
 * Loop archiveMessages() until none of the given message IDs remain in the
 * live store. After this call, those messages exist only in topic memory.
 *
 * Seed filler messages with seedFillerMessages() before calling this so that
 * archiveUntilGone completes in 1–2 passes. The remaining context (filler +
 * archival note hints) is then realistic enough for runHeadQuery to use directly
 * without creating a fresh bundle.
 */
export async function archiveUntilGone(
  historicalIds: Set<string>,
  bundle: HeadBundle,
  memory: Memory,
): Promise<void> {
  while (bundle.messages.getAll().some(m => historicalIds.has(m.id))) {
    await archiveMessages(bundle.messages.getAll(), {
      topicMemory: memory,
      messages: bundle.messages,
    })
  }
}

// ─── Natural context helpers ─────────────────────────────────────────────────

/**
 * Lean context config for evals that test natural context pressure.
 * 30k context window means archival fires naturally when conversation accumulates.
 */
export const LEAN_EVAL_CONFIG = {
  contextWindowTokens: 15_000,
  archivalThresholdFraction: 0.80,
  llmMaxTokens: 2048,
  timezone: 'UTC',
} as const

/**
 * Append a generated conversation to the message store with realistic timestamps.
 * Does NOT run through the activation loop — just populates the store.
 * With a lean config, archival will fire naturally during the next runHeadQuery.
 */
export function feedConversation(
  bundle: HeadBundle,
  history: EvalMessage[],
  baseTime?: number,
): Set<string> {
  const base = baseTime ?? Date.now() - history.length * 60_000
  const ids = new Set<string>()
  for (let i = 0; i < history.length; i++) {
    const id = generateId('msg')
    bundle.messages.append({
      kind: 'text',
      id,
      role: history[i]!.role,
      content: history[i]!.content,
      createdAt: new Date(base + i * 60_000).toISOString(),
    })
    ids.add(id)
  }
  return ids
}

// ─── Temp dir helper ──────────────────────────────────────────────────────────

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-eval-'))
}

export function cleanTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ─── Eval identity helpers ────────────────────────────────────────────────────

/** Build a complete Config for eval scenarios. Uses the real loadConfig() defaults
 *  (which include model role tiers, model IDs, etc.) and merges in eval-specific
 *  overrides. This avoids the `as Config` cast that silently drops required fields. */
export function makeEvalConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig()
  return { ...base, ...overrides }
}

export const DEFAULTS_DIR = path.resolve(__dirname, '../../src/identity/defaults')
export const SYSTEM_SKILLS_DIR = path.resolve(__dirname, '../../skills')
const AGENT_DEFAULTS_DIR = path.resolve(DEFAULTS_DIR, '../../sub-agents/defaults')

// ─── Production-faithful environment ─────────────────────────────────────────

const DEFAULT_AMBIENT = `Last updated: ${new Date().toISOString()}

- No upcoming calendar events today
- No pending deliveries or appointments
- System running normally
`

export interface EvalEnvironment {
  bundle: HeadBundle
  workspaceDir: string
  identityDir: string
  skillsDir: string
  config: Config
  ambientPath: string
}

export interface EnvironmentOverrides {
  config?: Partial<Config>
  /** string = custom content, undefined = default bland ambient, null = no AMBIENT.md */
  ambientContent?: string | null
  /** Override specific identity files by filename */
  identityFiles?: Record<string, string>
  /** Seed extra skills into the workspace */
  skills?: Array<{ name: string; content: string }>
}

/**
 * Create a production-faithful eval environment with a full workspace directory
 * structure, identity files, ambient context, and config pointing to the temp workspace.
 *
 * All evals should prefer this over manually assembling identityDir + config.
 * Override specific pieces via EnvironmentOverrides.
 */
export function makeProductionEnvironment(overrides?: EnvironmentOverrides): EvalEnvironment {
  const bundle = freshHeadBundle()
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-eval-env-'))

  const identityDir = path.join(workspaceDir, 'identity')
  const agentIdentityDir = path.join(workspaceDir, 'sub-agents')
  const skillsDir = path.join(workspaceDir, 'skills')
  for (const dir of [identityDir, agentIdentityDir, skillsDir, path.join(workspaceDir, 'data'), path.join(workspaceDir, 'media')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Identity files from defaults, BOOTSTRAP cleared
  for (const file of fs.readdirSync(DEFAULTS_DIR)) {
    if (file.endsWith('.md')) fs.copyFileSync(path.join(DEFAULTS_DIR, file), path.join(identityDir, file))
  }
  fs.writeFileSync(path.join(identityDir, 'BOOTSTRAP.md'), '')

  // Agent identity defaults
  if (fs.existsSync(AGENT_DEFAULTS_DIR)) {
    for (const file of fs.readdirSync(AGENT_DEFAULTS_DIR)) {
      if (file.endsWith('.md')) fs.copyFileSync(path.join(AGENT_DEFAULTS_DIR, file), path.join(agentIdentityDir, file))
    }
  }

  // Identity overrides
  if (overrides?.identityFiles) {
    for (const [filename, content] of Object.entries(overrides.identityFiles)) {
      fs.writeFileSync(path.join(identityDir, filename), content)
    }
  }

  // Ambient context: undefined = default, string = custom, null = no file
  const ambientPath = path.join(workspaceDir, 'AMBIENT.md')
  if (overrides?.ambientContent === null) {
    // Explicitly no AMBIENT.md
  } else {
    fs.writeFileSync(ambientPath, overrides?.ambientContent ?? DEFAULT_AMBIENT)
  }

  // Seed skills
  if (overrides?.skills) {
    for (const skill of overrides.skills) {
      const dir = path.join(skillsDir, skill.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content)
    }
  }

  const config = makeEvalConfig({
    ...overrides?.config,
    workspacePath: workspaceDir,
    identityDir,
  })

  return { bundle, workspaceDir, identityDir, skillsDir, config, ambientPath }
}

/** Clean up a production environment's temp workspace. */
export function cleanupEnvironment(env: EvalEnvironment): void {
  cleanTempDir(env.workspaceDir)
}

/**
 * Create a temp identity dir seeded from defaults, with BOOTSTRAP.md cleared.
 * Co-locates under parentDir (e.g. a makeTempDir() result).
 */
export function makeEvalIdentityDir(parentDir: string): string {
  const identityDir = path.join(parentDir, 'identity')
  fs.mkdirSync(identityDir, { recursive: true })
  for (const file of fs.readdirSync(DEFAULTS_DIR)) {
    if (file.endsWith('.md')) {
      fs.copyFileSync(path.join(DEFAULTS_DIR, file), path.join(identityDir, file))
    }
  }
  fs.writeFileSync(path.join(identityDir, 'BOOTSTRAP.md'), '')
  return identityDir
}

export function makeEvalIdentityLoader(identityDir: string): FileSystemIdentityLoader {
  return new FileSystemIdentityLoader(identityDir, DEFAULTS_DIR)
}

/**
 * Create a FileSystemSkillLoader pointing at an eval-specific temp skills dir.
 * When agents write skill files there, subsequent load() calls find them immediately.
 * The dir must already exist (create it as a subdir of the run's tempDir).
 */
export function makeEvalSkillLoader(skillsDir: string): FileSystemSkillLoader {
  return new FileSystemSkillLoader(skillsDir)
}

/**
 * Create a LocalAgentRunner wired to the given bundle's DB and stores.
 * Uses null workspacePath (no git commits in eval) and fast inbox polling.
 */
export function makeLocalAgentRunner(
  db: DatabaseSync,
  agentStore: AgentStore,
  queueStore: QueueStore,
  usageStore: UsageStore,
  skillLoader: SkillLoader,
  identityDir: string,
  router: LLMRouter,
  skillsDir: string,
  scheduleStore?: ScheduleStore,
  noteStore?: NoteStore,
  agentContextComposer?: boolean,
  workspacePath?: string | null,
): LocalAgentRunner {
  const inboxStore = new AgentInboxStore(db)
  const identityLoader = makeEvalIdentityLoader(identityDir)
  return new LocalAgentRunner({
    agentStore,
    inboxStore,
    queueStore,
    usageStore,
    skillLoader,
    ...(scheduleStore ? { scheduleStore } : {}),
    ...(noteStore ? { noteStore } : {}),
    skillsDir,
    workspacePath: workspacePath ?? null,
    mcpRegistry: { listCapabilities: () => [], loadTools: async () => [] },
    identityLoader,
    agentIdentityLoader: identityLoader,
    llmRouter: router,
    agentDefaults: { env: null, allowedTools: null },
    // Override WORKSPACE_PATH and SHROK_SKILLS_DIR so agent bash commands resolve
    // to the ephemeral temp dir rather than the real production workspace.
    envOverrides: { WORKSPACE_PATH: path.dirname(skillsDir), SHROK_SKILLS_DIR: skillsDir },
    pollIntervalMs: 500,
    ...(agentContextComposer !== undefined ? { agentContextComposer } : {}),
    timezone: 'UTC',
  })
}

// ─── CapturingAssembler ───────────────────────────────────────────────────────

export class CapturingAssembler implements ContextAssembler {
  lastAssembledSystemPrompt = ''
  lastMemoryBlock = ''
  constructor(private inner: ContextAssembler) {}
  async assemble(trigger: QueueEvent): Promise<AssembledContext> {
    const result = await this.inner.assemble(trigger)
    this.lastAssembledSystemPrompt = result.systemPrompt
    this.lastMemoryBlock = result.memoryBlock
    return result
  }
}

// ─── Head query helper ────────────────────────────────────────────────────────

export interface RunHeadQueryOpts {
  bundle: HeadBundle
  topicMemory: Memory
  router: LLMRouter
  /** Separate router for agents. Defaults to router. */
  agentRouter?: LLMRouter
  config: Config
  query: string
  /** Pre-seeded identity dir. If omitted, a fresh one is created from defaults (BOOTSTRAP cleared). */
  identityDir?: string
  /** Skill loader to use. Defaults to FileSystemSkillLoader(skillsDir). */
  skillLoader?: SkillLoader
  /** Attachments to include with the user message (e.g. images for image-routing eval). */
  attachments?: Attachment[]
  timeoutMs?: number
  assembler?: import('../../src/head/assembler.js').ContextAssembler
  /** Override HEAD_TOOLS (e.g. to strip acknowledgment requirement from spawn_agent). */
  headTools?: ToolDefinition[]
  /** Override terminal tool names (e.g. [] to force Round 2 after every spawn). */
  terminalToolNames?: string[]
  /** Use a no-op stub agent runner instead of the real LocalAgentRunner. */
  stubAgentRunner?: boolean
  /** Override the note returned in spawn_agent tool result (e.g. to encourage Round 2 acknowledgment). */
  spawnAgentNote?: string
  /** Enable the agent context composer (three-way classify + EXTRACT). */
  agentContextComposer?: boolean
  /** Workspace directory — agents get this as workspacePath for AMBIENT.md, file access, etc. */
  workspaceDir?: string
}

export interface RunHeadEventOpts {
  bundle: HeadBundle
  topicMemory: Memory
  router: LLMRouter
  /** Separate router for agents. Defaults to router. */
  agentRouter?: LLMRouter
  config: Config
  event: QueueEvent
  /** Pre-seeded identity dir. If omitted, a fresh one is created from defaults (BOOTSTRAP cleared). */
  identityDir?: string
  /** Skill loader to use. Defaults to FileSystemSkillLoader(skillsDir). */
  skillLoader?: SkillLoader
  timeoutMs?: number
  assembler?: import('../../src/head/assembler.js').ContextAssembler
  /** Override HEAD_TOOLS. */
  headTools?: ToolDefinition[]
  /** Override terminal tool names. */
  terminalToolNames?: string[]
  /** Use a no-op stub agent runner instead of the real LocalAgentRunner. */
  stubAgentRunner?: boolean
  /** Override the note returned in spawn_agent tool result. */
  spawnAgentNote?: string
  /** Enable the agent context composer (three-way classify + EXTRACT). */
  agentContextComposer?: boolean
  /** Workspace directory — agents get this as workspacePath for AMBIENT.md, file access, etc. */
  workspaceDir?: string
}

export interface RunHeadQueryResult {
  response: string
  assembledSystemPrompt: string
  /** Memory topics retrieved and injected into the system prompt. Empty if none. */
  memoryBlock: string
  traceFiles: Record<string, string>
  /** All tool calls made by the Head during this activation. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  /** Identity dir used for this run (useful for inspecting USER.md after write_identity calls). */
  identityDir: string
}

// ─── Shared activation core ───────────────────────────────────────────────────

interface RunActivationOpts {
  bundle: HeadBundle
  topicMemory: Memory
  router: LLMRouter
  agentRouter?: LLMRouter
  config: Config
  event: QueueEvent
  identityDir?: string
  skillLoader?: SkillLoader
  timeoutMs?: number
  assembler?: ContextAssembler
  headTools?: ToolDefinition[]
  terminalToolNames?: string[]
  stubAgentRunner?: boolean
  spawnAgentNote?: string
  /** Channel to filter when collecting the response. Null = collect all new messages. */
  responseChannel?: string | null
  /** Workspace directory — agents get this as workspacePath. */
  workspaceDir?: string
  agentContextComposer?: boolean
}

async function runActivation(opts: RunActivationOpts): Promise<RunHeadQueryResult> {
  const { bundle, topicMemory, router, config, event, timeoutMs = 60_000 } = opts

  // If no identity dir provided, create a fresh one and clean it up after
  const ownedTempDir = opts.identityDir ? null : makeTempDir()
  const identityDir = opts.identityDir ?? makeEvalIdentityDir(ownedTempDir!)

  // Ensure skills dir exists (buildSystem will resolve it from config)
  const skillsDir = opts.workspaceDir
    ? path.join(opts.workspaceDir, 'skills')
    : path.join(ownedTempDir ?? identityDir, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })

  // Build eval config with identity/skills paths pointing to the right dirs
  const evalConfig = {
    ...config,
    identityDir,
    skillsDir,
    workspacePath: opts.workspaceDir ?? path.dirname(skillsDir),
  }

  const mcpRegistry: McpRegistry = {
    listCapabilities: () => [],
    loadTools: async () => [],
  }

  // Use CapturingAssembler to record system prompt and memory block for inspection
  const capturing = new CapturingAssembler(
    // Placeholder — will be replaced by assemblerWrapper
    null as unknown as ContextAssembler,
  )

  const system = buildSystem({
    db: bundle.db,
    config: evalConfig,
    llmRouter: router,
    channelRouter: bundle.channelRouter,
    mcpRegistry,
    stores: {
      messages: bundle.messages,
      agents: bundle.workers,
      queue: bundle.queue,
      usage: bundle.usage,
      appState: bundle.appState,
      schedules: bundle.schedules,
      reminders: bundle.reminders,
      notes: bundle.notes,
      stewardRuns: bundle.stewardRuns,
      agentInbox: bundle.agentInbox,
    },
    topicMemory,
    pollIntervalMs: 200,
    assemblerWrapper: opts.assembler
      ? (real) => { capturing['inner'] = opts.assembler!; return capturing }
      : (real) => { capturing['inner'] = real; return capturing },
    ...(opts.stubAgentRunner !== undefined ? { stubAgentRunner: opts.stubAgentRunner } : {}),
    ...(opts.agentContextComposer !== undefined ? { agentContextComposer: opts.agentContextComposer } : {}),
    ...(opts.headTools !== undefined ? { headTools: opts.headTools } : {}),
    ...(opts.terminalToolNames !== undefined ? { terminalToolNames: opts.terminalToolNames } : {}),
    ...(opts.spawnAgentNote !== undefined ? { spawnAgentNote: opts.spawnAgentNote } : {}),
  })

  const { activationLoop: loop, agentRunner } = system

  // Snapshot current state so tool calls and response only reflect this activation
  const existingIds = new Set(bundle.messages.getAll().map(m => m.id))
  const sentBefore = bundle.channelRouter.sent.length

  // For non-user-message events, ensure there's an active channel to send responses to
  if (event.type !== 'user_message' && !bundle.appState.getLastActiveChannel()) {
    bundle.appState.setLastActiveChannel('eval')
  }

  const eventPriority = event.type === 'user_message' ? PRIORITY.USER_MESSAGE
    : event.type === 'agent_completed' ? PRIORITY.AGENT_COMPLETED
    : event.type === 'agent_question' ? PRIORITY.AGENT_QUESTION
    : event.type === 'agent_failed' ? PRIORITY.AGENT_FAILED
    : event.type === 'schedule_trigger' ? PRIORITY.SCHEDULE_TRIGGER
    : event.type === 'reminder_trigger' ? PRIORITY.REMINDER_TRIGGER
    : PRIORITY.AGENT_COMPLETED
  bundle.queue.enqueue(event, eventPriority)

  const evalTraceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrok-eval-trace-'))
  initTracer(evalTraceDir)
  let traceFiles: Record<string, string> = {}
  try {
    loop.start()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 300))
      if (!bundle.queue.hasPending()) {
        if (!opts.stubAgentRunner) {
          const remainingMs = Math.min(deadline - Date.now(), 60_000)
          if (remainingMs > 0) await agentRunner.awaitAll(remainingMs)
        }
        await new Promise<void>(resolve => setTimeout(resolve, 600))
        if (!bundle.queue.hasPending()) {
          loop.stop()
          break
        }
      }
    }
    if (Date.now() >= deadline) {
      loop.stop()
      throw new Error('runActivation: timed out waiting for response')
    }

    for (const file of fs.readdirSync(evalTraceDir)) {
      if (file.endsWith('.log') && !file.includes('-latest')) {
        traceFiles[file] = fs.readFileSync(path.join(evalTraceDir, file), 'utf8')
      }
    }
  } finally {
    initTracer('')
    fs.rmSync(evalTraceDir, { recursive: true, force: true })
  }

  const newMessages = bundle.messages.getAll().filter(m => !existingIds.has(m.id))
  const toolCalls = newMessages
    .filter((m): m is ToolCallMessage => m.kind === 'tool_call')
    .flatMap(m => m.toolCalls.map(tc => ({ name: tc.name, input: tc.input as Record<string, unknown> })))

  const responseChannel = opts.responseChannel !== undefined ? opts.responseChannel : (event.type === 'user_message' ? (event as { channel: string }).channel : null)
  const newSent = bundle.channelRouter.sent.slice(sentBefore)
  const response = (responseChannel !== null
    ? newSent.filter(m => m.channel === responseChannel)
    : newSent
  ).map(m => m.text).join('\n')

  if (ownedTempDir) cleanTempDir(ownedTempDir)

  return { response, assembledSystemPrompt: capturing.lastAssembledSystemPrompt, memoryBlock: capturing.lastMemoryBlock, traceFiles, toolCalls, identityDir }
}

/**
 * Run a single user query through the full ActivationLoop, with topicMemory wired in.
 *
 * Snapshots the message store and sent array before starting so that tool calls
 * and response only reflect activity from this specific query — safe to call
 * multiple times on the same bundle.
 */
export async function runHeadQuery(opts: RunHeadQueryOpts): Promise<RunHeadQueryResult> {
  const event: QueueEvent = {
    type: 'user_message',
    id: generateId('ev'),
    channel: 'eval',
    text: opts.query,
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    createdAt: new Date().toISOString(),
  }
  return runActivation({ ...opts, event })
}

/**
 * Feed a non-user event (e.g. agent_completed, schedule_trigger) into the ActivationLoop
 * and collect any messages the Head sends in response.
 *
 * Snapshots state before the event so results only reflect this activation — safe to
 * call multiple times on the same bundle.
 */
export async function runHeadEvent(opts: RunHeadEventOpts): Promise<RunHeadQueryResult> {
  return runActivation({ ...opts })
}
