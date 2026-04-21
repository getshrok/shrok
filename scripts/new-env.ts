/**
 * Create a named Shrok environment.
 *
 * Usage:
 *   npm run new-env <id>          # run interactive setup wizard
 *   npm run new-env <id> <src>    # clone from ~/.shrok-<src>, start immediately
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import * as url from 'node:url'

const args = process.argv.slice(2)
const id = args[0]
const fromId = args[1] ?? null

if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
  console.error('Usage: npm run new-env <id> [<src>]')
  console.error('  id must be alphanumeric (hyphens and underscores allowed)')
  process.exit(1)
}

if (fromId && !/^[a-zA-Z0-9_-]+$/.test(fromId)) {
  console.error('Source id must be alphanumeric (hyphens and underscores allowed)')
  process.exit(1)
}

const HOME = os.homedir()
const workspacePath = path.join(HOME, `.shrok-${id}`)
const configPath = path.join(workspacePath, 'config.json')
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')

// Resolve source workspace
let sourceWorkspace: string | null = null
if (fromId) {
  const candidate = path.join(HOME, `.shrok-${fromId}`)
  if (!fs.existsSync(path.join(candidate, '.env'))) {
    console.error(`Source environment '${fromId}' not found or has no .env`)
    process.exit(1)
  }
  sourceWorkspace = candidate
}

fs.mkdirSync(workspacePath, { recursive: true })
fs.mkdirSync(path.join(workspacePath, 'data'), { recursive: true })
fs.mkdirSync(path.join(workspacePath, 'identity'), { recursive: true })
fs.mkdirSync(path.join(workspacePath, 'skills'), { recursive: true })

console.log(`\nEnvironment: ${id}`)
console.log(`  Workspace:  ${workspacePath}`)
console.log(`  DB:         ${workspacePath}/data/shrok.db`)

if (sourceWorkspace) {
  // Clone mode — copy .env and merge config, start immediately
  fs.copyFileSync(path.join(sourceWorkspace, '.env'), path.join(workspacePath, '.env'))
  console.log(`  Cloned from: ${sourceWorkspace}\n`)

  const srcConfig: Record<string, unknown> = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(sourceWorkspace, 'config.json'), 'utf8')) as Record<string, unknown> }
    catch { return {} }
  })()
  const existingDest: Record<string, unknown> = (() => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> }
    catch { return {} }
  })()
  fs.writeFileSync(configPath, JSON.stringify({ ...srcConfig, ...existingDest }, null, 2) + '\n', 'utf8')

  const child = spawn('npm', ['start'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    shell: true,
    env: { ...process.env, WORKSPACE_PATH: workspacePath },
  })
  child.unref()
  console.log(`Shrok is starting in the background.\n`)
} else {
  // No --from — run interactive wizard

  const existing: Record<string, unknown> = (() => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> }
    catch { return {} }
  })()
  fs.writeFileSync(configPath, JSON.stringify({ ...existing }, null, 2) + '\n', 'utf8')

  const result = spawnSync(
    'npx', ['tsx', 'scripts/setup/index.ts'],
    {
      cwd: root,
      env: { ...process.env, WORKSPACE_PATH: workspacePath },
      stdio: 'inherit',
    }
  )
  process.exit(result.status ?? 0)
}
