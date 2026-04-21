import { isCancel, cancel } from '@clack/prompts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SetupPaths, SetupDeps } from './types.js'
import { SetupCancelledError } from './types.js'

// ─── Pure helpers (exported for unit testing) ────────────────────────────────

/**
 * Merges secrets into a .env template string.
 * Only replaces keys that already exist in the template.
 */
export function buildEnvFile(template: string, secrets: Record<string, string>): string {
  return template.split('\n').map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line
    const key = line.split('=')[0]!.trim()
    if (key in secrets && secrets[key] !== undefined) return `${key}=${secrets[key]}`
    return line
  }).join('\n')
}

/**
 * Parses a .env file content string into a key→value map.
 * Handles values containing '=' and ignores comments/blank lines.
 */
export function readExistingEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    result[key] = val
  }
  return result
}

// ─── Internal helpers ────────────────────────────────────────────────────────

export function assertNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Setup cancelled.')
    throw new SetupCancelledError()
  }
  return value
}

export async function installSkills(
  paths: SetupPaths,
  skills: string[],
  execSyncFn: SetupDeps['execSync'],
): Promise<void> {
  if (skills.length === 0) return

  const SKILLS_REPO = 'https://github.com/getshrok/skills'
  fs.mkdirSync(paths.skillsDir, { recursive: true })

  const tmpDir = path.join(os.tmpdir(), `shrok-skills-${Date.now()}`)
  try {
    execSyncFn(
      `git clone --depth=1 --filter=blob:none --sparse "${SKILLS_REPO}" "${tmpDir}"`,
      { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    )
    execSyncFn(`git sparse-checkout set ${skills.join(' ')}`, { cwd: tmpDir, stdio: 'pipe' })

    for (const skill of skills) {
      const src = path.join(tmpDir, skill)
      const dest = path.join(paths.skillsDir, skill)
      if (fs.existsSync(src)) {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(src, dest, { recursive: true })
      }
    }
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

