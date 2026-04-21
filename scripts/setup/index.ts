/**
 * Shrok setup wizard — modular rewrite.
 * Exports runSetup(deps) for testability; main() wires real dependencies.
 */

import { intro, outro, note, confirm, spinner } from '@clack/prompts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'

import type { SetupDeps, SetupResult } from './types.js'
import { SetupCancelledError } from './types.js'
import { assertNotCancelled, buildEnvFile, readExistingEnv, installSkills } from './utils.js'
import { setupLlm } from './llm.js'
import { setupChannels } from './channels.js'
import { setupSearch } from './search.js'
import { setupSkills } from './skills.js'
import { setupServer } from './server.js'

// Re-export public API for consumers and tests
export { buildEnvFile, readExistingEnv } from './utils.js'
export { SetupCancelledError } from './types.js'
export type { SetupPaths, SetupDeps, SetupResult } from './types.js'

// ─── Main wizard ──────────────────────────────────────────────────────────────

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { paths } = deps

  // Load existing env/config (if any)
  const existingEnvContent = fs.existsSync(paths.envFile)
    ? fs.readFileSync(paths.envFile, 'utf8')
    : ''
  const existingEnv = readExistingEnv(existingEnvContent)

  const existingConfig: Record<string, unknown> = (() => {
    if (!fs.existsSync(paths.workspaceConfig)) return {}
    try { return JSON.parse(fs.readFileSync(paths.workspaceConfig, 'utf8')) as Record<string, unknown> }
    catch { return {} }
  })()

  const alreadyConfigured = existingEnv['LLM_PROVIDER'] !== undefined

  // ── Banner ─────────────────────────────────────────────────────────────────
  intro('Shrok Setup')

  // ── Risk acknowledgement ───────────────────────────────────────────────────
  note(
    `This assistant can take real actions on your behalf: reading files, running ` +
    `commands, sending messages, and accessing any account you connect. It does ` +
    `this autonomously, including when you're not watching. ` +
    '\n' +
    '\n' +
    `Keep in mind:` +
    '\n' +
    '\n' +
    `You control what it can reach. Only connect accounts and grant permissions ` +
    `you're comfortable with. Start small, you can always add more later. ` +
    '\n' +
    '\n' +
    `Incoming content can influence it. Messages, emails, and web pages it ` +
    `processes may contain hidden instructions that cause unexpected behavior. ` +
    '\n' +
    '\n' +
    `Treat this like giving someone else access to your desk. Don't run it on ` +
    `a machine with sensitive files, saved passwords, or credentials you aren't ` +
    `prepared to rotate if something goes wrong. ` +
    '\n' +
    '\n' +
    `I've done my best to make this safe and reliable, but AI agents can behave ` +
    `in unexpected ways. Check in on what it's doing from time to time. `,
    'Before you start',
  )
  const accepted = assertNotCancelled(await confirm({
    message: 'I understand and want to continue',
    initialValue: false,
  }))
  if (!accepted) {
    outro("No problem, come back when you're ready.")
    return { aborted: true, startNow: false, secrets: existingEnv, userConfig: existingConfig }
  }

  if (alreadyConfigured) {
    const reconfigure = assertNotCancelled(await confirm({
      message: 'Shrok is already configured. Change settings?',
      initialValue: false,
    }))
    if (!reconfigure) {
      outro('Nothing changed.')
      return { aborted: true, startNow: false, secrets: existingEnv, userConfig: existingConfig }
    }
  }

  const secrets: Record<string, string> = { ...existingEnv }
  const userConfig: Record<string, unknown> = { ...existingConfig }

  const ctx = { deps, existingEnv, existingConfig, secrets, userConfig, alreadyConfigured }

  // ── Wizard sections ────────────────────────────────────────────────────────
  await setupLlm(ctx)
    await setupChannels(ctx)
    await setupSearch(ctx)
    const selectedSkills = await setupSkills(ctx)
    await setupServer(ctx)

  // ── Save ───────────────────────────────────────────────────────────────────
  const proceed = assertNotCancelled(await confirm({
    message: 'Save this configuration and continue?',
    initialValue: true,
  }))

  if (!proceed) {
    outro('Aborted, nothing was saved.')
    return { aborted: true, startNow: false, secrets, userConfig }
  }

  // Write .env (only now, after confirmation)
  const template = fs.readFileSync(paths.envExample, 'utf8')
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true })
  fs.writeFileSync(paths.envFile, buildEnvFile(template, secrets), { encoding: 'utf8', mode: 0o600 })

  // Write config.json
  fs.mkdirSync(paths.workspacePath, { recursive: true })
  // Seed the static default so fresh installs have a branding name on disk.
  // The LLM-extraction path (src/system.ts:onIdentityChanged) can overwrite this
  // when the user actually edits SOUL.md.
  if (typeof userConfig['assistantName'] !== 'string' || !userConfig['assistantName']) {
    userConfig['assistantName'] = 'Shrok'
  }
  fs.writeFileSync(paths.workspaceConfig, JSON.stringify(userConfig, null, 2) + '\n', 'utf8')

  // Create required directories
  fs.mkdirSync(path.join(paths.workspacePath, 'data'), { recursive: true })

  // Create workspace identity dir (user overrides go here; defaults ship with the repo)
  fs.mkdirSync(path.join(paths.workspacePath, 'identity'), { recursive: true })

  // Install skills
  if (selectedSkills.length > 0) {
    const s3 = spinner()
    s3.start(`Installing ${selectedSkills.join(', ')}…`)
    try {
      await installSkills(paths, selectedSkills, deps.execSync)
      s3.stop('Skills installed')
    } catch (err) {
      s3.stop(`Could not install skills, you can install them manually later`)
    }
  }

  const startNow = assertNotCancelled(await confirm({
    message: 'Start Shrok now?',
    initialValue: true,
  }))

  note(
    [
      'Dashboard: http://localhost:8888',
      'Overview:  https://github.com/getshrok/shrok/blob/main/docs/overview.md',
      '',
      'Docs are also available in the dashboard sidebar.',
      'If something breaks, send ~bug in chat to file a report.',
    ].join('\n'),
    'Quick links'
  )

  outro(startNow ? "Starting Shrok..." : "Setup complete. Run 'npm start' when you're ready.")

  return { aborted: false, startNow: !!startNow, secrets, userConfig }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  // Skip in CI / Docker builds / non-interactive shells
  if (process.env['CI'] || process.env['DOCKER_BUILD'] || !process.stdin.isTTY) {
    process.exit(0)
  }

  const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')
  const HOME = os.homedir()
  const WORKSPACE_PATH = process.env['WORKSPACE_PATH'] ?? path.join(HOME, '.shrok', 'workspace')

  const { execSync, spawn } = await import('node:child_process')

  try {
    const result = await runSetup({
      paths: {
        root: ROOT,
        envFile: path.join(WORKSPACE_PATH, '.env'),
        envExample: path.join(ROOT, '.env.example'),
        workspacePath: WORKSPACE_PATH,
        workspaceConfig: path.join(WORKSPACE_PATH, 'config.json'),
        skillsDir: path.join(WORKSPACE_PATH, 'skills'),
      },
      execSync: (cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]),
      spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]) as { unref(): void },
      fetch: globalThis.fetch,
    })
    // Exit 0 = start now, 2 = don't start (1 = error)
    process.exit(result.startNow ? 0 : 2)
  } catch (err) {
    if (err instanceof SetupCancelledError) {
      process.exit(0)
    }
    console.error('\n  Setup failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

// Only auto-run when invoked directly (not when imported by tests)
const isMain = process.argv[1] === url.fileURLToPath(import.meta.url)
  || process.argv[1]?.endsWith('setup/index.ts')
if (isMain) main()
