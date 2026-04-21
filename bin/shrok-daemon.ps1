# Shrok daemon wrapper - started by Windows Task Scheduler at login.
# Handles env loading, log rotation, and restart-on-request via sentinel file.
$ErrorActionPreference = 'Stop'

$ShrokDir = Split-Path -Parent $PSScriptRoot
Set-Location $ShrokDir

$LogFile = "$env:USERPROFILE\.shrok\shrok.log"
$SentinelFile = "$env:USERPROFILE\.shrok\.restart-requested"

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
        $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
        [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
      }
    }
  }
}

# --- Restart loop -------------------------------------------------------------

while ($true) {
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

  if (Test-Path $SentinelFile) {
    Remove-Item $SentinelFile -Force
    Write-Host "[shrok-daemon] $((Get-Date).ToUniversalTime().ToString('o')) Restart requested - restarting"
    continue
  }

  exit $proc.ExitCode
}
