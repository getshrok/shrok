import * as child_process from 'node:child_process'
import { log } from '../logger.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Use a fixed identity for automated commits so they work without global git config.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Shrok',
  GIT_AUTHOR_EMAIL: 'shrok@local',
  GIT_COMMITTER_NAME: 'Shrok',
  GIT_COMMITTER_EMAIL: 'shrok@local',
}

function git(args: string[], cwd: string): string {
  return child_process.execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim()
}

// The workspace repo is a local-only safety net for reverting agent mistakes
// (deleted skills, corrupted identity files, etc.). It never leaves the user's
// machine, so credentials in history aren't a leak concern.
//
// The ignore file is an ALLOWLIST — nothing is tracked unless it's explicitly
// included. The repo exists to recover specific things agents could corrupt,
// so we want the failure mode "I forgot to allowlist something and it didn't
// land in history" (discovered when recovery is attempted) rather than "new
// thing got tracked silently and bloated the repo." Any new feature that
// creates content worth recovering must add an explicit `!` rule here.
export const WORKSPACE_GITIGNORE = `# Workspace repo is an allowlist — nothing tracked unless explicitly included.

# Default: ignore everything at the root
/*

# Allowlist — things agents could corrupt or delete
!/.env
!/.gitignore
!/config.json
!/identity/
!/tasks/
!/skills/
!/sub-agents/
!/topics/

# Within allowlisted dirs, still exclude skill runtime artifacts
# (reinstallable, large, platform-specific)
skills/*/node_modules/
skills/*/.playwright-browsers/
skills/*/.browser-session.json
skills/*/.browser-sidecar.log
skills/*/.highlight-*.png
skills/*/.venv/
skills/*/__pycache__/
skills/*/*.pyc

# OS junk anywhere
**/.DS_Store
**/Thumbs.db
`

// The original seed value shipped in early versions. Detecting this exact
// content lets us safely auto-upgrade old workspaces without overwriting a
// .gitignore the user themselves customized.
const LEGACY_SEEDED_GITIGNORE = '*.tmp\n.DS_Store\n'

/**
 * Ensure the workspace directory exists and is a git repo.
 * Creates it and runs `git init` if not already initialised. Also migrates
 * old workspaces whose .gitignore is still the original 2-line seed: rewrites
 * it to the current list and untracks any files that now match. No-op if git
 * is not installed (silently skipped).
 */
export function ensureWorkspaceRepo(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true })

  try {
    const ignorePath = path.join(workspacePath, '.gitignore')
    const freshInit = !fs.existsSync(path.join(workspacePath, '.git'))

    if (freshInit) {
      git(['init'], workspacePath)
      fs.writeFileSync(ignorePath, WORKSPACE_GITIGNORE)
      git(['add', '-A'], workspacePath)
      git(['commit', '--allow-empty', '-m', 'Initialize workspace'], workspacePath)
      log.info('[workspace] Initialized git repo at', workspacePath)
      return
    }

    // Migration: upgrade old workspaces with the legacy 2-line ignore.
    let existing = ''
    try { existing = fs.readFileSync(ignorePath, 'utf8') } catch { /* no ignore yet */ }

    if (existing === WORKSPACE_GITIGNORE) return  // already on current list

    // Only auto-upgrade if the current content matches the exact legacy seed
    // or is missing entirely. If the user customized it, leave alone — they
    // may have deliberately tracked things we'd exclude.
    if (existing !== '' && existing !== LEGACY_SEEDED_GITIGNORE) return

    fs.writeFileSync(ignorePath, WORKSPACE_GITIGNORE)

    // Untrack anything that matches the new ignore list. Files stay on disk
    // (cached removal only); subsequent commits just stop including them.
    try {
      git(['rm', '--cached', '-r', '--ignore-unmatch', '--quiet', '.'], workspacePath)
      git(['add', '.gitignore'], workspacePath)
      git(['add', '.'], workspacePath)  // re-stage everything not now ignored
      const status = git(['status', '--porcelain'], workspacePath)
      if (status) {
        git(['commit', '-m', 'chore: upgrade workspace .gitignore + untrack now-ignored files'], workspacePath)
        log.info('[workspace] Upgraded .gitignore and untracked newly-ignored files')
      }
    } catch {
      // Migration is best-effort. The new .gitignore is on disk, so at least
      // future commits get the right behavior even if untracking failed.
    }
  } catch {
    // git not available or failed — workspace git is best-effort
  }
}

/**
 * Stage all changes in the workspace and commit with the given message.
 * No-op if there are no changes or if git is unavailable.
 */
export function commitWorkspace(workspacePath: string, message: string): void {
  try {
    git(['add', '-A'], workspacePath)
    const status = git(['status', '--porcelain'], workspacePath)
    if (!status) return  // nothing to commit

    // Truncate message to a reasonable commit line length
    const firstLine = message.replace(/[\r\n]+/g, ' ').slice(0, 120)
    git(['commit', '-m', firstLine], workspacePath)
  } catch {
    // Best-effort — never throw from a commit hook
  }
}
