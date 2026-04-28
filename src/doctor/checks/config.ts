// Config-layer checks: did loadConfig() succeed, and are the declared paths usable?
//
// loadConfig is called by the orchestrator before checks run so individual
// checks don't duplicate the parse. The result lives on ctx.config / ctx.configError.

import * as path from 'node:path'
import type { Check, CheckOutcome, Ctx } from '../types.js'

export const configLoadCheck: Check = {
  id: 'config.load',
  title: 'config loads and parses',
  layer: 'config',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (ctx.configError) {
      return {
        status: 'fail',
        detail: ctx.configError.message,
        hint: 'fix config.json or the offending env var and re-run',
      }
    }
    if (!ctx.config) {
      return { status: 'fail', detail: 'config is null but no error recorded — internal bug' }
    }
    return {
      status: 'ok',
      detail: `workspacePath=${ctx.config.workspacePath}  dbPath=${ctx.config.dbPath}`,
    }
  },
}

export const configPathsCheck: Check = {
  id: 'config.paths',
  title: 'declared paths exist and are writable',
  layer: 'config',
  async run(ctx: Ctx): Promise<CheckOutcome> {
    if (!ctx.config) {
      return { status: 'skip', detail: 'config did not load' }
    }
    const ws = ctx.config.workspacePath
    if (!ctx.fs.existsSync(ws)) {
      return {
        status: 'fail',
        detail: `workspacePath does not exist: ${ws}`,
        hint: 'create the workspace dir or set SHROK_WORKSPACE_PATH',
      }
    }
    try {
      ctx.fs.accessSync(ws, ctx.fs.constants.W_OK)
    } catch {
      return {
        status: 'fail',
        detail: `workspacePath not writable: ${ws}`,
        hint: `fix permissions: chmod u+w ${ws}`,
      }
    }
    const dbParent = path.dirname(ctx.config.dbPath)
    if (!ctx.fs.existsSync(dbParent)) {
      return {
        status: 'warn',
        detail: `dbPath parent dir missing: ${dbParent}`,
        hint: 'daemon will create it on first run — safe to ignore if this is a fresh install',
      }
    }
    return { status: 'ok', detail: `workspace writable; dbPath parent exists` }
  },
}
