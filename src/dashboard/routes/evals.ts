import express from 'express'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from '../../db/index.js'
import { requireAuth, requireSameOrigin } from '../auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCENARIOS_DIR = path.resolve(__dirname, '../../../scripts/eval/scenarios')
const EVAL_RUNNER   = path.resolve(__dirname, '../../../scripts/eval/run.ts')

/** Parse a .env file and return key/value pairs (without overwriting existing process.env). */
function loadDotEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
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
      if (key) result[key] = val
    }
  } catch { /* file not found */ }
  return result
}

/** Build the env for eval subprocesses: process.env + workspace .env file vars. */
function buildEvalEnv(): Record<string, string> {
  const ws = process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'] ?? path.join(os.homedir(), '.shrok', 'workspace')
  const envFile = process.env['SHROK_ENV_FILE'] ?? path.join(ws, '.env')
  const dotEnvVars = loadDotEnv(envFile)
  // Start with process.env, then let dotEnv fill in keys that are absent or empty string
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) result[k] = v
  }
  for (const [k, v] of Object.entries(dotEnvVars)) {
    if (v && !result[k]) result[k] = v
  }
  return result
}

// ─── Scenario metadata extraction ────────────────────────────────────────────

interface ScenarioMeta {
  name: string
  description: string
  category: string
  rubric: string[]
  estimatedCostUsd: number
  variants: string[]
}

function extractScenarioMeta(filePath: string): ScenarioMeta | null {
  let src: string
  try { src = fs.readFileSync(filePath, 'utf8') } catch { return null }

  const nameMatch    = src.match(/^export const name\s*=\s*'([^']+)'/m)
  const descMatch    = src.match(/^export const description\s*=\s*'([^']+)'/m)
  const catMatch     = src.match(/^export const category\s*=\s*'([^']+)'/m)
  const costMatch    = src.match(/^export const estimatedCostUsd\s*=\s*([0-9.]+)/m)

  if (!nameMatch || !descMatch) return null

  // Extract rubric array: lines between `export const rubric = [` and the closing `]`
  const rubricBlock = src.match(/^export const rubric\s*=\s*\[([\s\S]*?)^\s*\]/m)
  const rubric: string[] = []
  if (rubricBlock) {
    const items = rubricBlock[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)
    for (const m of items) rubric.push(m[1]!.replace(/\\'/g, "'"))
  }

  // Extract variant names — look for name: 'xxx' in any VARIANTS array or the export
  const variants: string[] = []
  const variantArrays = src.matchAll(/(?:export\s+)?const\s+\w*(?:variants|VARIANTS)\b[^=]*=\s*\[([\s\S]*?)^\]$/gmi)
  for (const block of variantArrays) {
    const names = block[1]!.matchAll(/name:\s*'([^']+)'/g)
    for (const m of names) {
      if (!variants.includes(m[1]!)) variants.push(m[1]!)
    }
  }

  return {
    name: nameMatch[1]!,
    description: descMatch[1]!,
    category: catMatch?.[1] ?? 'uncategorized',
    rubric,
    estimatedCostUsd: costMatch ? parseFloat(costMatch[1]!) : 0.10,
    variants,
  }
}

function loadAllScenarios(): ScenarioMeta[] {
  if (!fs.existsSync(SCENARIOS_DIR)) return []
  return fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => extractScenarioMeta(path.join(SCENARIOS_DIR, f)))
    .filter((s): s is ScenarioMeta => s !== null)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

interface EvalResultRow {
  id: string
  run_id: string
  scenario: string
  category: string
  pass: number
  dimensions: string
  narrative: string
  overall: string
  result_file: string
  created_at: string
}

function tableExists(db: DatabaseSync): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='eval_results'`
  ).get() as { n: number }
  return row.n > 0
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createEvalsRouter(db: DatabaseSync, evalResultsDir: string) {
  const router = express.Router()

  // GET /api/evals — scenario list with latest result per scenario
  router.get('/', requireAuth, (_req, res) => {
    const scenarios = loadAllScenarios()

    let latestByScenario: Record<string, { pass: boolean; createdAt: string; runId: string; minScore: number | null }> = {}
    if (tableExists(db)) {
      const rows = db.prepare(
        `SELECT scenario, pass, created_at, run_id, dimensions FROM eval_results
         WHERE id IN (
           SELECT id FROM eval_results e2
           WHERE e2.scenario = eval_results.scenario
           ORDER BY created_at DESC LIMIT 1
         )`,
      ).all() as unknown as EvalResultRow[]
      for (const row of rows) {
        let minScore: number | null = null
        try {
          const dims = JSON.parse(row.dimensions) as Record<string, { score: number }>
          const scores = Object.values(dims).map(d => d.score)
          if (scores.length > 0) minScore = Math.min(...scores)
        } catch { /* ignore malformed dimensions */ }
        latestByScenario[row.scenario] = {
          pass: row.pass === 1,
          createdAt: row.created_at,
          runId: row.run_id,
          minScore,
        }
      }
    }

    res.json({
      scenarios: scenarios.map(s => ({
        ...s,
        lastResult: latestByScenario[s.name] ?? null,
        estimatedCostUsd: s.estimatedCostUsd,
      })),
    })
  })

  // GET /api/evals/runs — batch run history
  router.get('/runs', requireAuth, (_req, res) => {
    if (!tableExists(db)) { res.json({ runs: [] }); return }
    const rows = db.prepare(
      `SELECT run_id, COUNT(*) AS total, SUM(pass) AS passed, MIN(created_at) AS started_at
       FROM eval_results GROUP BY run_id ORDER BY started_at DESC LIMIT 50`,
    ).all() as { run_id: string; total: number; passed: number; started_at: string }[]
    res.json({ runs: rows.map(r => ({ runId: r.run_id, total: r.total, passed: r.passed, startedAt: r.started_at })) })
  })

  // GET /api/evals/results/:scenario — result history for a scenario
  router.get('/results/:scenario', requireAuth, (req, res) => {
    const scenario = (req.params['scenario'] as string) ?? ''
    if (!tableExists(db)) { res.json({ results: [] }); return }
    const rows = db.prepare(
      `SELECT * FROM eval_results WHERE scenario = ? ORDER BY created_at DESC LIMIT 20`,
    ).all(scenario) as unknown as EvalResultRow[]
    res.json({
      results: rows.map(r => ({
        id: r.id,
        runId: r.run_id,
        scenario: r.scenario,
        category: r.category,
        pass: r.pass === 1,
        dimensions: JSON.parse(r.dimensions) as unknown,
        narrative: r.narrative,
        overall: r.overall,
        createdAt: r.created_at,
      })),
    })
  })

  // GET /api/evals/results/detail/:id — full result with history
  router.get('/results/detail/:id', requireAuth, (req, res) => {
    const id = (req.params['id'] as string) ?? ''
    if (!tableExists(db)) { res.status(404).json({ error: 'Not found' }); return }
    const row = db.prepare(`SELECT * FROM eval_results WHERE id = ?`).get(id) as EvalResultRow | undefined
    if (!row) { res.status(404).json({ error: 'Not found' }); return }

    const filePath = path.join(evalResultsDir, row.result_file)
    let history: unknown[] = []
    let output: unknown = null
    let traces: Record<string, string> = {}
    try {
      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { history: unknown[]; output: unknown; traces?: Record<string, string> }
      history = fileData.history
      output = fileData.output
      traces = fileData.traces ?? {}
    } catch { /* file may not exist */ }

    res.json({
      id: row.id,
      runId: row.run_id,
      scenario: row.scenario,
      category: row.category,
      pass: row.pass === 1,
      dimensions: JSON.parse(row.dimensions) as unknown,
      narrative: row.narrative,
      overall: row.overall,
      createdAt: row.created_at,
      history,
      output,
      traces,
    })
  })

  // GET /api/evals/run?scenarios=a,b,c[&variant=name][&runs=N|all] — SSE stream for running evals
  router.get('/run', requireAuth, requireSameOrigin, (req, res) => {
    const scenariosParam = (req.query['scenarios'] as string | undefined) ?? ''
    const scenarioNames = scenariosParam
      ? scenariosParam.split(',').map(s => s.trim()).filter(s => s && /^[a-zA-Z0-9_-]+$/.test(s))
      : []
    const variantParam = req.query['variant'] as string | undefined
    if (variantParam && !/^[a-zA-Z0-9_-]+$/.test(variantParam)) {
      res.status(400).json({ error: 'Invalid variant name' })
      return
    }
    const runsParam = req.query['runs'] as string | undefined
    if (runsParam && !/^\d+$/.test(runsParam)) {
      res.status(400).json({ error: 'Invalid runs count' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const runId = `run-${crypto.randomUUID()}`

    function send(type: string, data: unknown) {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send('start', { runId, scenarios: scenarioNames, time: Date.now() })

    const evalEnv = buildEvalEnv()
    const args = ['tsx', EVAL_RUNNER, ...scenarioNames, '--run-id', runId]
    if (variantParam) args.push('--variant', variantParam)
    if (runsParam) args.push('--runs', runsParam)
    const child = spawn('npx', args, {
      cwd: path.resolve(__dirname, '../../..'),
      env: evalEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) send('line', { text: line })
    })

    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) send('line', { text: line })
    })

    child.on('close', (code) => {
      send('done', { runId, code, passed: code === 0 })
      res.end()
    })

    req.on('close', () => { child.kill() })
  })

  return router
}
