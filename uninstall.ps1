# Shrok uninstaller - Windows
# Usage: powershell -File "$env:USERPROFILE\shrok\uninstall.ps1"
$ErrorActionPreference = 'Stop'

function Write-Info    { param([string]$Msg) Write-Host "    $Msg" -ForegroundColor DarkGray }
function Write-Success { param([string]$Msg) Write-Host "  v  $Msg" -ForegroundColor Cyan }
function Write-Warn    { param([string]$Msg) Write-Host "  !  $Msg" -ForegroundColor Yellow }
function Write-Step    { param([string]$Msg) Write-Host "`n  $Msg" -ForegroundColor White }

$ShrokDir = if ($env:SHROK_DIR) { $env:SHROK_DIR } else { "$env:USERPROFILE\shrok" }
$BinDir      = "$env:USERPROFILE\.local\bin"
$TaskName    = 'Shrok'

function Stop-Shrok {
  Write-Step "Stopping Shrok..."
  # Process may not be running — that's fine
  $conns = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $conns) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Write-Success "Shrok process stopped"
}

function Remove-Daemon {
  Write-Step "Removing daemon..."
  # Task may not exist — that's fine
  schtasks /end /tn $TaskName 2>$null | Out-Null
  Start-Sleep -Seconds 2
  schtasks /delete /tn $TaskName /f 2>$null | Out-Null
  Write-Success "Daemon removed (Task Scheduler)"
}

function Remove-Cli {
  Write-Step "Removing CLI..."
  # Files may not exist — that's fine
  Remove-Item "$BinDir\shrok.ps1" -Force -ErrorAction SilentlyContinue
  Remove-Item "$BinDir\shrok.cmd" -Force -ErrorAction SilentlyContinue

  # Remove $BinDir from user PATH if it's there
  try {
    $userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -like "*$BinDir*") {
      $newPath = ($userPath -split ';' | Where-Object { $_ -ne $BinDir }) -join ';'
      [System.Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    }
  } catch {
    Write-Warn "Could not update PATH: $_"
  }
  Write-Success "CLI removed"
}

function Remove-Repo {
  Write-Step "Removing Shrok..."
  # Sanity check: refuse to delete home dir or root
  $resolved = (Resolve-Path $ShrokDir -ErrorAction SilentlyContinue).Path
  if ($resolved -eq $env:USERPROFILE -or $resolved -eq "${env:USERPROFILE}\" -or $resolved -eq 'C:\') {
    Write-Warn "SHROK_DIR is set to '$ShrokDir' - refusing to delete. Unset it or fix the path."
    return
  }
  if (-not (Test-Path "$ShrokDir\package.json")) {
    Write-Warn "'$ShrokDir' doesn't look like a Shrok install (no package.json). Skipping."
    return
  }
  # Can't delete a directory we're running from — move out first.
  Set-Location $env:USERPROFILE

  # The .cmd wrapper that launched us lives inside $ShrokDir. cmd.exe holds it
  # open for read while iterating lines, so deleting it here would cause
  # "The batch file cannot be found" when cmd.exe tries to read the next line
  # after powershell returns. Dispatch a detached helper that waits for our
  # process tree to exit, then removes the directory.
  $helper = @"
@echo off
rem Wait for the invoking powershell + cmd wrapper to fully exit
timeout /t 2 /nobreak > nul 2>&1
rmdir /s /q "$ShrokDir" 2> nul
del "%~f0"
"@
  $helperPath = Join-Path $env:TEMP "shrok-rmdir-$([Guid]::NewGuid().ToString('N')).cmd"
  Set-Content -Path $helperPath -Value $helper -Encoding Ascii
  Start-Process cmd.exe -ArgumentList '/c', "`"$helperPath`"" -WindowStyle Hidden
  Write-Success "Shrok directory will finish removing in a few seconds: $ShrokDir"
}

function Remove-Workspace {
  Write-Step "Workspace data..."
  Write-Host ""
  Write-Warn "${env:USERPROFILE}\.shrok contains your memories, credentials, and conversation history."
  $ans = Read-Host "  Remove it? [y/N]"
  if ($ans -eq 'y' -or $ans -eq 'Y') {
    $removed = $false
    try {
      Remove-Item "${env:USERPROFILE}\.shrok" -Recurse -Force
      $removed = $true
    } catch {
      Write-Warn "Could not fully remove workspace — some files may be locked: $_"
    }
    if ($removed) { Write-Success "Workspace data removed" }
  } else {
    Write-Info "Workspace data kept at ${env:USERPROFILE}\.shrok"
  }
}

Write-Host ""
Write-Host "  Shrok - Uninstall" -ForegroundColor Cyan
Write-Host "  This will remove Shrok from your system." -ForegroundColor DarkGray
Write-Host ""

Stop-Shrok
Remove-Daemon
Remove-Cli
Remove-Repo
Remove-Workspace

Write-Host ""
Write-Host "  Shrok has been uninstalled." -ForegroundColor Cyan
Write-Host ""
