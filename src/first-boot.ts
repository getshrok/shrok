/**
 * Idempotent first-boot setup — daemon registration, CLI wrappers, PATH.
 * Runs every startup but no-ops if everything is already in place.
 * All errors are non-fatal: Shrok works fine without a daemon or CLI.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { log } from './logger.js'

const HOME = os.homedir()
const PLATFORM = process.platform

// ─── Daemon setup ────────────────────────────────────────────────────────────

function setupLinuxDaemon(shrokDir: string, workspacePath: string): void {
  const serviceDir = path.join(HOME, '.config', 'systemd', 'user')
  const servicePath = path.join(serviceDir, 'shrok.service')

  // Check if already enabled
  try {
    execSync('systemctl --user is-enabled shrok', { stdio: 'pipe' })
    return  // already set up
  } catch { /* not enabled, proceed */ }

  const daemon = path.join(shrokDir, 'bin', 'shrok-daemon')
  fs.mkdirSync(serviceDir, { recursive: true })
  fs.chmodSync(daemon, 0o755)
  fs.chmodSync(path.join(shrokDir, 'bin', 'shrok'), 0o755)

  fs.writeFileSync(servicePath, `[Unit]
Description=Shrok AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${daemon}
Restart=on-failure
RestartSec=5
Environment=WORKSPACE_PATH=${workspacePath}
Environment=PATH=${process.env['PATH']}

[Install]
WantedBy=default.target
`)

  execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  execSync('systemctl --user enable shrok', { stdio: 'pipe' })
  // Don't start — we're already running
  log.info('[first-boot] Installed systemd user service')
}

function setupMacDaemon(shrokDir: string, workspacePath: string): void {
  const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'com.shrok.agent.plist')

  // Check if already loaded
  try {
    execSync(`launchctl print gui/${process.getuid!()}/com.shrok.agent`, { stdio: 'pipe' })
    return  // already set up
  } catch { /* not loaded, proceed */ }

  const daemon = path.join(shrokDir, 'bin', 'shrok-daemon')
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.mkdirSync(path.join(HOME, '.shrok'), { recursive: true })
  fs.chmodSync(daemon, 0o755)
  fs.chmodSync(path.join(shrokDir, 'bin', 'shrok'), 0o755)

  // Detect node bin directory
  const nodeBin = path.dirname(process.execPath)

  // Clean up old labels
  for (const label of ['com.shrok.shrok', 'local.shrok']) {
    try { execSync(`launchctl bootout gui/${process.getuid!()}/${label}`, { stdio: 'pipe' }) } catch {}
  }
  const oldPlists = ['com.shrok.shrok.plist', 'local.shrok.plist']
  for (const p of oldPlists) {
    const full = path.join(HOME, 'Library', 'LaunchAgents', p)
    if (fs.existsSync(full)) fs.unlinkSync(full)
  }

  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.shrok.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${daemon}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${shrokDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKSPACE_PATH</key>
    <string>${workspacePath}</string>
    <key>PATH</key>
    <string>${nodeBin}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(HOME, '.shrok', 'shrok.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(HOME, '.shrok', 'shrok.log')}</string>
</dict>
</plist>
`)

  // Don't bootstrap — we're already running. It'll load on next login via RunAtLoad.
  try { execSync(`launchctl bootout gui/${process.getuid!()}/com.shrok.agent`, { stdio: 'pipe' }) } catch {}
  execSync(`launchctl bootstrap gui/${process.getuid!()} ${plistPath}`, { stdio: 'pipe' })
  log.info('[first-boot] Installed launchd agent')
}

function setupWindowsDaemon(shrokDir: string): void {
  // Check if task already exists
  try {
    execSync('schtasks /query /tn Shrok', { stdio: 'pipe' })
    return  // already set up
  } catch { /* not found, proceed */ }

  const vbsLauncher = path.join(shrokDir, 'bin', 'shrok-daemon.vbs')
  const psExe = 'wscript.exe'
  const taskArgs = `"${vbsLauncher}"`
  const domain = process.env['USERDOMAIN'] ?? ''
  const username = process.env['USERNAME'] ?? ''

  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${domain}\\${username}</UserId>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
  <Actions>
    <Exec>
      <Command>${psExe}</Command>
      <Arguments>${taskArgs}</Arguments>
      <WorkingDirectory>${shrokDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`

  const tmpXml = path.join(os.tmpdir(), `shrok-task-${Date.now()}.xml`)
  // schtasks requires UTF-16LE with BOM
  const bom = Buffer.from([0xFF, 0xFE])
  const content = Buffer.from(xml, 'utf16le')
  fs.writeFileSync(tmpXml, Buffer.concat([bom, content]))
  try {
    execSync(`schtasks /create /tn Shrok /xml "${tmpXml}" /f`, { stdio: 'pipe' })
    log.info('[first-boot] Installed Windows Task Scheduler task')
  } finally {
    try { fs.unlinkSync(tmpXml) } catch {}
  }
}

// ─── CLI wrapper setup ───────────────────────────────────────────────────────

function setupCli(shrokDir: string): void {
  if (PLATFORM === 'win32') {
    setupWindowsCli(shrokDir)
  } else {
    setupUnixCli(shrokDir)
  }
}

function setupUnixCli(shrokDir: string): void {
  const binDir = path.join(HOME, '.local', 'bin')
  const linkPath = path.join(binDir, 'shrok')

  // Check if symlink already exists and points to the right place
  try {
    const target = fs.readlinkSync(linkPath)
    if (target === path.join(shrokDir, 'bin', 'shrok')) return
  } catch { /* doesn't exist or not a symlink */ }

  fs.mkdirSync(binDir, { recursive: true })
  try { fs.unlinkSync(linkPath) } catch {}
  fs.symlinkSync(path.join(shrokDir, 'bin', 'shrok'), linkPath)

  // Add to PATH in shell rc
  const shell = process.env['SHELL'] ?? ''
  if (shell.includes('fish')) {
    const fishConfig = path.join(HOME, '.config', 'fish', 'config.fish')
    try {
      const content = fs.existsSync(fishConfig) ? fs.readFileSync(fishConfig, 'utf8') : ''
      if (!content.includes('.local/bin')) {
        fs.mkdirSync(path.dirname(fishConfig), { recursive: true })
        fs.appendFileSync(fishConfig, '\nfish_add_path $HOME/.local/bin\n')
        log.info('[first-boot] Added ~/.local/bin to PATH in config.fish')
      }
    } catch { /* best effort */ }
  } else {
    const shellRc = shell.includes('zsh')
      ? path.join(HOME, '.zshrc')
      : path.join(HOME, '.bashrc')

    if (fs.existsSync(shellRc)) {
      const content = fs.readFileSync(shellRc, 'utf8')
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(shellRc, '\nexport PATH="$HOME/.local/bin:$PATH"\n')
        log.info(`[first-boot] Added ~/.local/bin to PATH in ${shellRc}`)
      }
    }
  }

  log.info('[first-boot] CLI wrapper installed')
}

function setupWindowsCli(shrokDir: string): void {
  const binDir = path.join(HOME, '.local', 'bin')
  const cmdPath = path.join(binDir, 'shrok.cmd')
  const ps1Path = path.join(binDir, 'shrok.ps1')

  fs.mkdirSync(binDir, { recursive: true })

  // Install only the .cmd wrapper into PATH (not shrok.ps1). PowerShell's default
  // execution policy blocks .ps1 scripts in PATH, and PowerShell's own script
  // discovery picks .ps1 over .cmd when both are present, so installing shrok.ps1
  // actively harms users with a default policy. This is the same pattern npm uses
  // on Windows (npm.cmd is in PATH, npm.ps1 is not).
  //
  // The .cmd invokes the repo's bin\\shrok.ps1 via -ExecutionPolicy Bypass so it
  // works regardless of user policy. We generate a fresh .cmd with the repo path
  // hardcoded (rather than copying the repo's .cmd which uses %~dp0 for its ps1
  // sibling) so the single PATH-visible file doesn't need a nearby .ps1.
  const repoPs1 = path.join(shrokDir, 'bin', 'shrok.ps1')
  const cmdContent = `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "${repoPs1}" %*\r\n`

  // Always rewrite — idempotent and heals older installs that baked the wrong path.
  fs.writeFileSync(cmdPath, cmdContent)

  // Clean up the stale shrok.ps1 from earlier installs. Leaving it causes PowerShell
  // to resolve `shrok` to the ps1 (which fails under default execution policy)
  // instead of our cmd wrapper.
  if (fs.existsSync(ps1Path)) {
    try { fs.unlinkSync(ps1Path); log.info('[first-boot] Removed stale shrok.ps1 from PATH') } catch {}
  }

  // Add to user PATH — use -EncodedCommand to avoid shell injection from PATH contents
  try {
    const userPath = execSync('powershell -c "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { encoding: 'utf8' }).trim()
    if (!userPath.includes(binDir)) {
      const script = `[Environment]::SetEnvironmentVariable('PATH', '${binDir.replaceAll("'", "''")}' + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      execSync(`powershell -EncodedCommand ${encoded}`, { stdio: 'pipe' })
      log.info('[first-boot] Added ~/.local/bin to user PATH')
    }
  } catch {}

  log.info('[first-boot] CLI wrapper installed')
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runFirstBoot(shrokDir: string, workspacePath: string): Promise<void> {
  // Skip in Docker
  if (process.env['DOCKER_BUILD'] || fs.existsSync('/.dockerenv')) return

  // Daemon
  try {
    if (PLATFORM === 'linux') setupLinuxDaemon(shrokDir, workspacePath)
    else if (PLATFORM === 'darwin') setupMacDaemon(shrokDir, workspacePath)
    else if (PLATFORM === 'win32') setupWindowsDaemon(shrokDir)
  } catch (err) {
    log.warn(`[first-boot] Daemon setup failed (non-fatal): ${(err as Error).message}`)
  }

  // CLI
  try {
    setupCli(shrokDir)
  } catch (err) {
    log.warn(`[first-boot] CLI setup failed (non-fatal): ${(err as Error).message}`)
  }
}
