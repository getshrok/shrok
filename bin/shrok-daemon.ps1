# Shrok daemon wrapper - started by Windows Task Scheduler at login.
# Handles env loading, log rotation, and restart-on-request via sentinel file.
$ErrorActionPreference = 'Stop'

$ShrokDir = Split-Path -Parent $PSScriptRoot
Set-Location $ShrokDir

$LogFile = "$env:USERPROFILE\.shrok\shrok.log"
$SentinelFile = "$env:USERPROFILE\.shrok\.restart-requested"
$StopFile = "$env:USERPROFILE\.shrok\.stop-requested"

# --- Log rotation (>10 MB) ----------------------------------------------------

if (Test-Path $LogFile) {
  $logSize = (Get-Item $LogFile).Length
  if ($logSize -gt 10MB) {
    Move-Item $LogFile "$LogFile.1" -Force
  }
}

# --- Load .env ----------------------------------------------------------------

$envFile = "$env:USERPROFILE\.shrok\workspace\.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $eq = $line.IndexOf('=')
      if ($eq -gt 0) {
        $key = $line.Substring(0, $eq).Trim()
        $val = $line.Substring($eq + 1)
        # Strip inline comments unless the value is quoted (mirrors TS parseEnvFile)
        if ($val -notmatch '^\s*["\x27]') { $val = $val -replace '#.*$', '' }
        $val = $val.Trim().Trim('"').Trim("'")
        [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
      }
    }
  }
}

# --- Restart loop -------------------------------------------------------------

# Clear any stale stop marker from a previous lifecycle. Without this, a fresh
# start after `shrok stop` / uninstall would see the old marker and exit at once.
Remove-Item $StopFile -Force -ErrorAction SilentlyContinue

while ($true) {
  # Re-read .env on every (re)start so settings changes via the dashboard take effect.
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith('#')) {
        $eq = $line.IndexOf('=')
        if ($eq -gt 0) {
          $key = $line.Substring(0, $eq).Trim()
          $val = $line.Substring($eq + 1)
          if ($val -notmatch '^\s*["\x27]') { $val = $val -replace '#.*$', '' }
          $val = $val.Trim().Trim('"').Trim("'")
          [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
        }
      }
    }
  }

  $stderrLog = "$LogFile.err"
  [System.Environment]::SetEnvironmentVariable('SHROK_DAEMON', '1', 'Process')
  $nodeExe = (Get-Command node.exe).Source
  $proc = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList "--import tsx/esm src/index.ts" `
    -PassThru `
    -NoNewWindow `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $stderrLog
  $proc.WaitForExit()
  # Merge stderr into the main log
  if (Test-Path $stderrLog) {
    Get-Content $stderrLog | Add-Content $LogFile -ErrorAction SilentlyContinue
    Remove-Item $stderrLog -Force -ErrorAction SilentlyContinue
  }

  $ts = (Get-Date).ToUniversalTime().ToString('o')

  # Intentional stop (shrok stop / uninstall write this before killing node).
  # Checked first so it always wins over a restart request or a crash relaunch.
  if (Test-Path $StopFile) {
    Remove-Item $StopFile -Force -ErrorAction SilentlyContinue
    Write-Host "[shrok-daemon] $ts Stop requested - exiting"
    exit 0
  }

  # Explicit restart request (dashboard button, update skill, `shrok restart`).
  if (Test-Path $SentinelFile) {
    Remove-Item $SentinelFile -Force
    Write-Host "[shrok-daemon] $ts Restart requested - restarting"
    continue
  }

  # Anything else (crash, OOM, external kill) is unexpected: back off briefly
  # so a boot-loop can't peg the CPU, then relaunch. This is the crash
  # supervision the wrapper previously lacked.
  Write-Host "[shrok-daemon] $ts Daemon exited unexpectedly (code $($proc.ExitCode)) - restarting in 5s"
  Start-Sleep -Seconds 5
}
