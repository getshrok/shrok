// Workspace-layer check: verifies the on-disk layout the daemon expects.
//
// Missing sub-dirs are warns, not fails — they're created lazily, but operators
// want to know when they don't exist yet (e.g. fresh install vs broken install).

import * as path from 'node:path'
import type { Check, CheckOutcome, Ctx } from '../types.js'

export const workspaceCheck: Check = {
  id: 'config.workspace',
  title: 'workspace layout',
  layer: 'config',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) {
      return { status: 'skip', detail: 'config did not load' }
    }
    const ws = ctx.config.workspacePath
    const issues: string[] = []

    const envFile = path.join(ws, '.env')
    if (!ctx.fs.existsSync(envFile)) {
      issues.push('.env missing (daemon can run without it — env may come from process env)')
    } else {
      try { ctx.fs.accessSync(envFile, ctx.fs.constants.R_OK) }
      catch { issues.push('.env exists but is not readable') }
    }

    const dataDir = path.join(ws, 'data')
    if (!ctx.fs.existsSync(dataDir)) issues.push('data/ missing (will be created on first run)')

    const tasksDir = path.join(ws, 'tasks')
    if (!ctx.fs.existsSync(tasksDir)) issues.push('tasks/ missing (created lazily)')

    const skillsDir = path.join(ws, 'skills')
    if (!ctx.fs.existsSync(skillsDir)) issues.push('skills/ missing (created lazily)')

    if (issues.length === 0) {
      return { status: 'ok', detail: 'workspace has .env, data/, tasks/, skills/' }
    }
    return {
      status: 'warn',
      detail: issues.join('; '),
      hint: 'run `shrok start` once to materialize the default workspace, or create these dirs by hand',
    }
  },
}
