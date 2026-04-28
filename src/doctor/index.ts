// `shrok doctor` orchestrator + CLI entrypoint.
//
// Runs four layers (process, config, creds, live) sequentially. Failures in one
// layer never abort subsequent layers — operators see the full picture even
// when the daemon is dead or the config is broken.

import * as fs from 'node:fs'
import * as os from 'node:os'
import { loadConfig, type Config } from '../config.js'
import type { Check, CheckResult, Ctx, Layer, Status } from './types.js'
import { renderHuman, renderJson } from './printer.js'
import { processPidCheck, processPortCheck } from './checks/process.js'
import { configLoadCheck, configPathsCheck } from './checks/config.js'
import { workspaceCheck } from './checks/workspace.js'
import { dbCheck } from './checks/db.js'
import { buildCredentialsChecks } from './checks/credentials.js'
import { buildProviderChecks } from './checks/providers.js'
import { buildAdapterChecks } from './checks/adapters.js'

const VALID_LAYERS: Layer[] = ['process', 'config', 'creds', 'live']

export function computeExitCode(results: CheckResult[]): 0 | 1 | 2 {
  let sawWarn = false
  for (const r of results) {
    if (r.status === 'fail') return 1
    if (r.status === 'warn') sawWarn = true
  }
  return sawWarn ? 2 : 0
}

export interface RunOptions {
  onlyLayer?: Layer
}

/**
 * Runs a list of checks against a ctx, wrapping each with id/title/layer/durationMs
 * and converting thrown errors into fail results. Layer:'live' checks are skipped
 * unless ctx.deep is true. An onlyLayer filter strips non-matching checks.
 */
export async function runChecks(checks: Check[], ctx: Ctx, opts: RunOptions = {}): Promise<CheckResult[]> {
  const filtered = opts.onlyLayer ? checks.filter(c => c.layer === opts.onlyLayer) : checks
  const results: CheckResult[] = []
  for (const c of filtered) {
    const start = Date.now()
    if (c.layer === 'live' && !ctx.deep) {
      results.push({
        id: c.id, title: c.title, layer: c.layer,
        status: 'skip', detail: 'use --deep to enable live probes',
        durationMs: Date.now() - start,
      })
      continue
    }
    try {
      const outcome = await c.run(ctx)
      results.push({
        id: c.id, title: c.title, layer: c.layer,
        status: outcome.status,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
        durationMs: Date.now() - start,
      })
    } catch (err) {
      results.push({
        id: c.id, title: c.title, layer: c.layer,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        hint: 'Check threw — file a bug if reproducible',
        durationMs: Date.now() - start,
      })
    }
  }
  return results
}

/** Env-file loader replicated from src/index.ts:8-42 to avoid importing the main daemon. */
function loadEnvFile(): void {
  if (!process.env['SHROK_ENV_FILE']) {
    const ws = process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'] ?? `${os.homedir()}/.shrok/workspace`
    process.env['SHROK_ENV_FILE'] = `${ws}/.env`
  }
  const envFile = process.env['SHROK_ENV_FILE']!
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n')
    for (const line of lines) {
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
        if (quoteChar === '"') {
          val = val.replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\\\', '\\').replaceAll('\\"', '"')
        } else {
          val = val.replaceAll("\\'", "'")
        }
      }
      if (key && !(key in process.env)) process.env[key] = val
    }
  } catch {
    // env file not found — fine, rely on process env
  }
}

interface ParsedArgs {
  deep: boolean
  json: boolean
  onlyLayer?: Layer
  help: boolean
  /** When set, the caller should print an error, print usage, and exit 2. */
  error?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { deep: false, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--deep') out.deep = true
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else if (a === '--only') {
      const next = argv[i + 1]
      if (!next) { out.error = '--only requires a layer argument'; return out }
      if (!(VALID_LAYERS as string[]).includes(next)) {
        out.error = `unknown layer '${next}' — valid: ${VALID_LAYERS.join('|')}`
        return out
      }
      out.onlyLayer = next as Layer
      i += 1
    } else {
      out.error = `unknown flag '${a}'`
      return out
    }
  }
  return out
}

const USAGE = `Usage: shrok doctor [--deep] [--json] [--only <${VALID_LAYERS.join('|')}>]`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    process.stderr.write(`shrok doctor: ${parsed.error}\n${USAGE}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n\n` +
      `  --deep         run live probes against configured providers (list-models endpoints, zero tokens)\n` +
      `  --json         emit a stable JSON document instead of the human-readable report\n` +
      `  --only <layer> only run checks in that layer (${VALID_LAYERS.join('|')})\n`)
    return 0
  }

  loadEnvFile()

  let config: Config | null = null
  let configError: Error | null = null
  try {
    config = loadConfig()
  } catch (err) {
    configError = err instanceof Error ? err : new Error(String(err))
  }

  const priority = config?.llmProviderPriority ?? []
  const ctx: Ctx = {
    config,
    configError,
    deep: parsed.deep,
    fetch: globalThis.fetch,
    fs,
    now: () => Date.now(),
  }

  const checks: Check[] = [
    processPidCheck,
    processPortCheck,
    configLoadCheck,
    configPathsCheck,
    workspaceCheck,
    dbCheck,
    ...buildCredentialsChecks(priority),
    ...buildProviderChecks(priority),
    ...buildAdapterChecks(),
  ]

  const started = Date.now()
  const results = await runChecks(
    checks,
    ctx,
    parsed.onlyLayer ? { onlyLayer: parsed.onlyLayer } : {},
  )
  const durationMs = Date.now() - started

  const rendered = parsed.json
    ? renderJson(results, { deep: parsed.deep, durationMs })
    : renderHuman(results, { deep: parsed.deep, durationMs })
  process.stdout.write(parsed.json ? rendered + '\n' : rendered)

  return computeExitCode(results)
}

// Only run main when executed directly (not when imported by tests). Use
// import.meta.url vs argv[1] — the standard pattern for ESM scripts.
const _argv1 = process.argv[1]
if (_argv1 && import.meta.url === `file://${_argv1}`) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`shrok doctor: fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}

// Suppress "unused" warning on Status (it's used indirectly via CheckResult types).
export type { Status }
