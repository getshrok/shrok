#!/usr/bin/env tsx
/**
 * config:set — Safely write known env var keys to the Shrok .env file.
 *
 * Usage:
 *   npm run config:set -- TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy
 *
 * Only keys in ENV_KEY_ALLOWLIST (from src/config.ts) are accepted.
 * Existing keys are replaced in-place; new keys are appended.
 * Writes atomically via a temp file + rename.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ENV_KEY_ALLOWLIST } from '../src/config.js'

const allowlist = new Set<string>(ENV_KEY_ALLOWLIST)

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: npm run config:set -- KEY=VALUE [KEY2=VALUE2 ...]')
  console.error(`Allowed keys: ${[...allowlist].join(', ')}`)
  process.exit(1)
}

// Parse KEY=VALUE args
const pairs: { key: string; value: string }[] = []
for (const arg of args) {
  const eq = arg.indexOf('=')
  if (eq === -1) {
    console.error(`Invalid argument (expected KEY=VALUE): ${arg}`)
    process.exit(1)
  }
  const key = arg.slice(0, eq).trim()
  const value = arg.slice(eq + 1)
  if (!allowlist.has(key)) {
    console.error(`Unknown config key: ${key}`)
    console.error(`Allowed keys: ${[...allowlist].join(', ')}`)
    process.exit(1)
  }
  pairs.push({ key, value })
}

const ws = process.env['SHROK_WORKSPACE_PATH'] ?? process.env['WORKSPACE_PATH'] ?? path.join(os.homedir(), '.shrok', 'workspace')
const envFile = process.env['SHROK_ENV_FILE'] ?? path.join(ws, '.env')

// Read existing file, or start empty
let lines: string[] = []
try {
  lines = fs.readFileSync(envFile, 'utf8').split('\n')
} catch {
  // File doesn't exist yet — will be created
  fs.mkdirSync(path.dirname(envFile), { recursive: true })
}

// Apply each pair: replace existing line or append
for (const { key, value } of pairs) {
  const prefix = `${key}=`
  const idx = lines.findIndex(l => l.startsWith(prefix) || l.trim() === key)
  const newLine = `${key}=${value}`
  if (idx !== -1) {
    lines[idx] = newLine
  } else {
    lines.push(newLine)
  }
}

// Remove trailing empty lines, ensure single trailing newline
const content = lines.join('\n').trimEnd() + '\n'

// Atomic write
const tmp = `${envFile}.tmp.${process.pid}`
fs.writeFileSync(tmp, content, 'utf8')
fs.renameSync(tmp, envFile)

for (const { key } of pairs) {
  console.log(`✓ ${key} written to ${envFile}`)
}
