/**
 * Eval runner — CLI entry point.
 *
 * Usage:
 *   npm run eval                          # run all scenarios
 *   npm run eval:archival-recall          # run one scenario
 *   tsx scripts/eval/run.ts memory-formation --replay ./eval-results/2026-01-01-memory.json
 *   tsx scripts/eval/run.ts memory-formation --no-judge
 */

import { execSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Load workspace .env (same logic as src/index.ts) so the eval runner works standalone.
{
  const ws = process.env['WORKSPACE_PATH'] ?? `${os.homedir()}/.shrok/workspace`
  const envFile = process.env['SHROK_ENV_FILE'] ?? path.join(ws, '.env')
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1)
      const quoted = /^\s*["']/.test(val)
      if (!quoted) val = val.replace(/#.*$/, '')
      val = val.trim()
      const quoteChar = (val[0] === '"' || val[0] === "'") ? val[0] : null
      if (quoteChar && val.endsWith(quoteChar)) {
        val = val.slice(1, -1)
        if (quoteChar === '"') val = val.replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\\\', '\\').replaceAll('\\"', '"')
        else val = val.replaceAll("\\'", "'")
      }
      if (key && !(key in process.env)) process.env[key] = val
    }
  } catch { /* env file not found — rely on process env */ }
}
import { loadHistoryFromResult, loadFixture } from './harness.js'

// ─── Keep: e2e memory/recall evals ───────────────────────────────────────────
import * as archivalRecall from './scenarios/archival.js'
import * as memoryFormation from './scenarios/memory.js'
import * as coldStart from './scenarios/cold-start.js'
import * as gaslightingResistance from './scenarios/gaslighting-resistance.js'
import * as multiHopMemory from './scenarios/multi-hop-memory.js'
import * as recencyBias from './scenarios/recency-bias.js'
import * as correctionHandling from './scenarios/correction-handling.js'
import * as negationPreservation from './scenarios/negation-preservation.js'
import * as revisionTracking from './scenarios/revision-tracking.js'
import * as nearDuplicateEntities from './scenarios/near-duplicate-entities.js'
import * as agentResultRecall from './scenarios/agent-result-recall.js'
import * as anaphoricReference from './scenarios/anaphoric-reference.js'

// ─── Keep: e2e agent/routing evals ───────────────────────────────────────────
import * as agentLifecycle from './scenarios/agent-lifecycle.js'
import * as multiAgentCoordination from './scenarios/multi-agent-coordination.js'
import * as agentQuestionLoop from './scenarios/agent-question-loop.js'
import * as agentPauseResume from './scenarios/agent-pause-resume.js'
import * as agentCancellation from './scenarios/agent-cancellation.js'
import * as scheduleManagement from './scenarios/schedule-management.js'
import * as agentProgressUpdate from './scenarios/agent-progress-update.js'
import * as agentMidTaskUpdate from './scenarios/agent-mid-task-update.js'
import * as agentRelay from './scenarios/agent-relay.js'
import * as codeExecution from './scenarios/code-execution.js'
import * as relayJudge from './scenarios/relay-judge.js'
import * as proactiveDecision from './scenarios/proactive-decision.js'
import * as proactiveDecisionRealistic from './scenarios/proactive-decision-realistic.js'
import * as proactiveReminder from './scenarios/proactive-reminder.js'
import * as proactiveContext from './scenarios/proactive-context.js'
import * as ambientContext from './scenarios/ambient-context.js'

// ─── Keep: stress/reliability evals ──────────────────────────────────────────
import * as combinedStress from './scenarios/combined-stress.js'
import * as systemMarkerHallucination from './scenarios/system-marker-hallucination.js'
// Composer (premium agent context mode)
import * as composerMultiTask from './scenarios/composer-multi-task.js'
import * as composerContextCarry from './scenarios/composer-context-carry.js'
// Skill creation
import * as skillCreation from './scenarios/skill-creation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Snapshot the current git working tree state (excluding eval-results/).
 * Call this before running scenarios, then pass the result to checkRepoClean().
 */
function snapshotRepoState(): Set<string> {
  try {
    const raw = execSync('git status --short', { cwd: REPO_ROOT, encoding: 'utf8' })
    return new Set(raw.split('\n').filter(Boolean).filter(l => !l.match(/^\s*\?\?\s+eval-results\//)))
  } catch {
    return new Set()
  }
}

/**
 * Compare current working tree against a pre-run snapshot and warn about anything new.
 * This only flags changes introduced *during* the eval run, not pre-existing working tree state.
 */
function checkRepoClean(before: Set<string>): void {
  console.log('\n' + '═'.repeat(60))
  console.log('Repo integrity check (post-eval)')
  console.log('═'.repeat(60))
  try {
    const raw = execSync('git status --short', { cwd: REPO_ROOT, encoding: 'utf8' })
    const after = raw.split('\n').filter(Boolean).filter(l => !l.match(/^\s*\?\?\s+eval-results\//))
    const newChanges = after.filter(l => !before.has(l))

    if (newChanges.length === 0) {
      console.log('  ✓ No new changes to repo during eval run')
    } else {
      console.log(`  ⚠ WARNING: ${newChanges.length} new change(s) appeared during the eval run:`)
      for (const l of newChanges) console.log(`    ${l}`)
      console.log('\n  An eval may have written outside its ephemeral temp dir.')
    }
  } catch (err) {
    console.log(`  (git status failed: ${(err as Error).message})`)
  }
}

const ALL_SCENARIOS = [
  // Memory/recall
  archivalRecall,
  memoryFormation,
  coldStart,
  gaslightingResistance,
  multiHopMemory,
  recencyBias,
  correctionHandling,
  negationPreservation,
  revisionTracking,
  nearDuplicateEntities,
  agentResultRecall,
  anaphoricReference,
  // Agent/routing
  agentLifecycle,
  multiAgentCoordination,
  agentQuestionLoop,
  agentPauseResume,
  agentCancellation,
  scheduleManagement,
  agentProgressUpdate,
  agentMidTaskUpdate,
  agentRelay,
  codeExecution,
  relayJudge,
  proactiveDecision,
  proactiveDecisionRealistic,
  proactiveReminder,
  proactiveContext,
  ambientContext,
  // Stress/reliability
  combinedStress,
  systemMarkerHallucination,
  // Composer (premium agent context mode)
  composerMultiTask,
  composerContextCarry,
  // Skill creation
  skillCreation,
]

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const scenarioArgs = args.filter(a => !a.startsWith('--'))
const replayFlag = (() => {
  const idx = args.indexOf('--replay')
  return idx !== -1 ? args[idx + 1] : undefined
})()
const runIdFlag = (() => {
  const idx = args.indexOf('--run-id')
  return idx !== -1 ? args[idx + 1] : undefined
})()
const noJudge = args.includes('--no-judge')
const runsFlag = (() => {
  const idx = args.indexOf('--runs')
  return idx !== -1 ? args[idx + 1] : undefined
})()
const variantFlag = (() => {
  const idx = args.indexOf('--variant')
  return idx !== -1 ? args[idx + 1] : undefined
})()

const runId = runIdFlag ?? `run-${crypto.randomUUID()}`

const scenarios = scenarioArgs.length > 0
  ? ALL_SCENARIOS.filter(s => scenarioArgs.includes(s.name))
  : ALL_SCENARIOS

if (scenarioArgs.length > 0 && scenarios.length === 0) {
  console.error(`Unknown scenario(s): ${scenarioArgs.join(', ')}`)
  console.error(`Available: ${ALL_SCENARIOS.map(s => s.name).join(', ')}`)
  process.exit(1)
}

const replayHistory = replayFlag ? loadHistoryFromResult(replayFlag) : undefined

console.log(`Run ID: ${runId}`)

const repoStateBefore = snapshotRepoState()

// Track per-scenario pass rates when using --runs
const passRates: Array<{ scenario: string; variant: string; pass: boolean }> = []

for (const scenario of scenarios) {
  // Determine how many runs and which variants
  const scenarioVariants = (scenario as any).variants as import('./harness.js').EvalVariant[] | undefined

  // If --variant specified, run just that one
  if (variantFlag && scenarioVariants) {
    const variant = scenarioVariants.find(v => v.name === variantFlag)
    if (!variant) {
      console.error(`[${scenario.name}] Unknown variant: ${variantFlag}`)
      console.error(`Available: ${scenarioVariants.map(v => v.name).join(', ')}`)
      continue
    }
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`Scenario: ${scenario.name} [variant: ${variant.name}]`)
    console.log(`  ${scenario.description}`)
    console.log('═'.repeat(60))
    try {
      const history = replayHistory ?? loadFixture(scenario.name)
      await scenario.run({ ...(history ? { replayHistory: history } : {}), noJudge, runId, variant })
    } catch (err) {
      console.error(`[${scenario.name}:${variant.name}] FAILED:`, (err as Error).message)
      if (process.env['DEBUG']) console.error(err)
    }
    continue
  }

  // Determine number of runs
  const variantCount = scenarioVariants?.length ?? 1
  const numRuns = runsFlag === 'all' ? variantCount : runsFlag ? parseInt(runsFlag, 10) : 1
  if (isNaN(numRuns) || numRuns < 1) {
    console.error(`Invalid --runs value: ${runsFlag}`)
    process.exit(1)
  }

  for (let i = 0; i < numRuns; i++) {
    const variant = scenarioVariants ? scenarioVariants[i % scenarioVariants.length] : undefined
    const label = variant ? `${scenario.name} [variant: ${variant.name}]` : scenario.name
    const runLabel = numRuns > 1 ? ` (run ${i + 1}/${numRuns})` : ''

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`Scenario: ${label}${runLabel}`)
    console.log(`  ${scenario.description}`)
    console.log('═'.repeat(60))
    try {
      const history = replayHistory ?? loadFixture(scenario.name)
      await scenario.run({ ...(history ? { replayHistory: history } : {}), noJudge, runId, ...(variant ? { variant } : {}) })
    } catch (err) {
      console.error(`[${label}] FAILED:`, (err as Error).message)
      if (process.env['DEBUG']) console.error(err)
    }
  }
}

// Print pass rate summary if --runs was used
if (runsFlag) {
  // Pass rates are tracked inside each scenario's writeResults call — we rely on the
  // console output for now. A future improvement could collect structured results here.
}

checkRepoClean(repoStateBefore)
