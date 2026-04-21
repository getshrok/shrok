# Shrok CLI - manage the Shrok daemon on Windows.
# Usage: shrok <start|stop|restart|status|logs|update>
$ErrorActionPreference = 'Stop'

$ShrokDir = Split-Path -Parent $PSScriptRoot
$TaskName    = 'Shrok'
$LogFile     = "$env:USERPROFILE\.shrok\shrok.log"
$Sentinel    = "$env:USERPROFILE\.shrok\.restart-requested"

function daemon_start {
  schtasks /run /tn $TaskName | Out-Null
  Write-Host "Shrok started."
}

function daemon_stop {
  schtasks /end /tn $TaskName 2>$null | Out-Null
  # Also kill any running tsx process spawned by the daemon
  Get-Process -Name "node" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*shrok*index*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host "Shrok stopped."
}

function daemon_restart {
  New-Item -ItemType File -Path $Sentinel -Force | Out-Null
  Write-Host "Shrok restart requested."
}

function daemon_status {
  $task = schtasks /query /tn $TaskName /fo LIST 2>$null
  if ($task) {
    $task | Select-String -Pattern "Status|Last Run Time|Next Run Time"
  } else {
    Write-Host "Shrok task not found."
  }
  Write-Host ""
  Write-Host "(For a richer health report, run: shrok doctor)"
}

function daemon_doctor {
  $doctorArgs = if ($args.Count -gt 0) { $args } else { @() }
  & npm --prefix $ShrokDir run doctor --silent -- @doctorArgs
  exit $LASTEXITCODE
}

function daemon_logs {
  if (Test-Path $LogFile) {
    Get-Content $LogFile -Wait -Tail 50
  } else {
    Write-Host "No log file found at $LogFile"
  }
}

function daemon_update {
  Write-Host "Pulling latest Shrok..."
  git -C $ShrokDir pull --ff-only
  Write-Host "Installing dependencies..."
  npm --prefix $ShrokDir install --quiet
  Write-Host "Restarting Shrok..."
  daemon_restart
  Write-Host "Done."
}

$cmd = if ($args.Count -gt 0) { $args[0] } else { "help" }

switch ($cmd) {
  "start"   { daemon_start }
  "stop"    { daemon_stop }
  "restart" { daemon_restart }
  "status"  { daemon_status }
  "logs"    { daemon_logs }
  "doctor"  { $argsRest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }; daemon_doctor @argsRest }
  "update"  { daemon_update }
  default   { Write-Host "Usage: shrok <start|stop|restart|status|doctor|logs|update>" }
}
