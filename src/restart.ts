import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Restart the Shrok process.
 * When running under the daemon (SHROK_DAEMON=1): writes a sentinel file
 * and exits — the daemon's restart loop detects the sentinel and respawns.
 * When standalone (npm start): spawns a detached replacement process, then exits.
 * Callers should stop their own loops/timers before calling this.
 */
export function restartProcess(): never {
  if (process.env['SHROK_DAEMON']) {
    // Running under daemon — write sentinel so the daemon restarts us
    const sentinelPath = path.join(os.homedir(), '.shrok', '.restart-requested')
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true })
    fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8')
  } else if (process.platform === 'win32') {
    // Standalone Windows — spawn replacement via cmd
    const cleanEnv: Record<string, string> = {}
    for (const key of ['PATH', 'NODE_ENV', 'WORKSPACE_PATH', 'SHROK_ENV_FILE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']) {
      if (process.env[key]) cleanEnv[key] = process.env[key]!
    }
    spawn('cmd', ['/c', 'timeout /t 2 /nobreak >nul && npm start'], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: cleanEnv,
    }).unref()
  } else {
    // Standalone Unix — spawn replacement via sh
    const cleanEnv: Record<string, string> = {}
    for (const key of ['PATH', 'NODE_ENV', 'WORKSPACE_PATH', 'SHROK_ENV_FILE', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM']) {
      if (process.env[key]) cleanEnv[key] = process.env[key]!
    }
    spawn('sh', ['-c', 'sleep 2 && npm start'], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: cleanEnv,
    }).unref()
  }

  process.exit(0)
}
