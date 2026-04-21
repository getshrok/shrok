import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../logger.js'

export const BASELINE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'NODE_PATH', 'WORKSPACE_PATH', 'SHROK_ENV_FILE', 'SHROK_ROOT', 'SHROK_SKILLS_DIR']

export async function ensureSkillDeps(skillPath: string, deps: string[]): Promise<void> {
  const missing = deps.filter(dep => !fs.existsSync(path.join(skillPath, 'node_modules', dep)))
  if (missing.length === 0) return
  log.info(`[skill-deps] Installing ${missing.join(', ')} into ${skillPath}`)
  await new Promise<void>((resolve, reject) => {
    child_process.execFile(
      'npm', ['install', '--prefix', skillPath, '--no-save', ...missing],
      { timeout: 120_000 },
      err => err ? reject(new Error(`Skill dep install failed: ${err.message}`)) : resolve(),
    )
  })
}

export function buildScopedEnv(
  declaredVars: string[],
  envDict: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...BASELINE_ENV_KEYS, ...declaredVars]) {
    if (envDict[key] !== undefined) env[key] = envDict[key]!
  }
  return env
}
