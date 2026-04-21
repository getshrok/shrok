# Shrok installer - Windows
# Usage: powershell -c "irm https://raw.githubusercontent.com/getshrok/shrok/main/scripts/install.ps1 | iex"

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Allow running scripts (npm.ps1, etc.) in this session - does not affect system policy
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# --- Non-interactive guard ---------------------------------------------------

if (-not [Environment]::UserInteractive) {
  Write-Host "  x  This installer requires an interactive terminal." -ForegroundColor Red
  Write-Host "     Open PowerShell and run:" -ForegroundColor DarkGray
  Write-Host "     powershell -c `"irm https://raw.githubusercontent.com/getshrok/shrok/main/scripts/install.ps1 | iex`"" -ForegroundColor DarkGray
  exit 1
}

# --- Output helpers -----------------------------------------------------------

function Write-Info    { param([string]$Msg) Write-Host "    $Msg" -ForegroundColor DarkGray }
function Write-Success { param([string]$Msg) Write-Host "  v  $Msg" -ForegroundColor Cyan }
function Write-Warn    { param([string]$Msg) Write-Host "  !  $Msg" -ForegroundColor Yellow }
function Write-Err     { param([string]$Msg) Write-Host "  x  $Msg" -ForegroundColor Red; exit 1 }
function Write-Step    { param([string]$Msg) Write-Host "`n  $Msg" -ForegroundColor White }

# --- Refresh PATH from registry (picks up newly installed tools) --------------

function Invoke-RefreshPath {
  $machine = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  $env:PATH = "$machine;$user"
}

# --- winget -------------------------------------------------------------------

function Ensure-Winget {
  if (Get-Command winget -ErrorAction SilentlyContinue) { return }
  Write-Host ""
  Write-Host "  x  winget is not available." -ForegroundColor Red
  Write-Host "     Please update Windows or install App Installer from the Microsoft Store." -ForegroundColor DarkGray
  Write-Host "     https://aka.ms/getwinget" -ForegroundColor DarkGray
  exit 1
}

# --- Node.js ------------------------------------------------------------------

# Fallback direct download - no hash pinning since versions are resolved dynamically.
# Prefer winget (tried first in Ensure-Node) which has its own package verification.
function Install-NodeDirect {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' }
         elseif ([Environment]::Is64BitOperatingSystem) { 'x64' }
         else { 'x86' }
  # Resolve latest LTS version dynamically
  $nodeVersion = (Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing |
    Where-Object { $_.lts -and [int]$_.version.TrimStart('v').Split('.')[0] -ge 22 } |
    Select-Object -First 1).version
  if (-not $nodeVersion) { $nodeVersion = 'v22.15.0' }  # fallback
  $msiUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-$arch.msi"
  $msiPath = "$env:TEMP\node-install.msi"

  Write-Info "Downloading Node.js from nodejs.org..."
  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
  Write-Info "Running installer..."
  Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Wait -NoNewWindow
  Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
}

function Ensure-Node {
  Invoke-RefreshPath
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $ver = [int](node --version).TrimStart('v').Split('.')[0]
    if ($ver -ge 22) {
      Write-Success "Node.js $(node --version) already installed"
      return
    }
    Write-Warn "Node.js $(node --version) found but v22+ required - upgrading"
  } else {
    Write-Step "Installing Node.js 22..."
  }

  # Try winget first, fall back to direct MSI download
  $wingetOk = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object { Write-Info $_ }
      Invoke-RefreshPath
      if (Get-Command node -ErrorAction SilentlyContinue) { $wingetOk = $true }
    } catch {
      Write-Warn "winget install failed: $_"
    }
  }

  if (-not $wingetOk) {
    Write-Warn "winget failed or unavailable - downloading Node.js directly"
    Install-NodeDirect
    Invoke-RefreshPath
  }

  # Check known install locations if still not in PATH
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $candidates = @("$env:ProgramFiles\nodejs", "${env:ProgramFiles(x86)}\nodejs", "$env:LOCALAPPDATA\Programs\nodejs")
    foreach ($dir in $candidates) {
      if (Test-Path "$dir\node.exe") {
        $env:PATH = "$dir;$env:PATH"
        break
      }
    }
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "Could not install Node.js. Please install Node.js 22+ manually from https://nodejs.org and re-run."
  }

  Write-Success "Node.js $(node --version) installed"
}

# --- Git ----------------------------------------------------------------------

function Install-GitDirect {
  $arch = if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }
  # Use the Git for Windows release API to get the latest installer URL
  Write-Info "Downloading Git from github.com/git-for-windows..."
  $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
  $asset = $releases.assets | Where-Object { $_.name -match "$arch\.exe$" -and $_.name -notmatch 'portable' } | Select-Object -First 1
  if (-not $asset) {
    Write-Err "Could not find Git installer. Please install Git manually from https://git-scm.com and re-run."
  }
  $exePath = "$env:TEMP\git-install.exe"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exePath -UseBasicParsing
  Write-Info "Running installer..."
  Start-Process $exePath -ArgumentList "/VERYSILENT /NORESTART" -Wait -NoNewWindow
  Remove-Item $exePath -Force -ErrorAction SilentlyContinue
}

function Ensure-Git {
  Invoke-RefreshPath
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Success "Git already installed"
    return
  }

  Write-Step "Installing Git..."

  # Try winget first, fall back to direct download
  $wingetOk = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object { Write-Info $_ }
      Invoke-RefreshPath
      if (Get-Command git -ErrorAction SilentlyContinue) { $wingetOk = $true }
    } catch {
      Write-Warn "winget install failed: $_"
    }
  }

  if (-not $wingetOk) {
    Write-Warn "winget failed or unavailable - downloading Git directly"
    Install-GitDirect
    Invoke-RefreshPath
  }

  # Check known install locations if still not in PATH
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $candidates = @("$env:ProgramFiles\Git\cmd", "${env:ProgramFiles(x86)}\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")
    foreach ($dir in $candidates) {
      if (Test-Path "$dir\git.exe") {
        $env:PATH = "$dir;$env:PATH"
        break
      }
    }
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "Could not install Git. Please install Git manually from https://git-scm.com and re-run."
  }

  Write-Success "Git installed"
}

# --- Clone Shrok -----------------------------------------------------------

function Invoke-CloneShrok {
  Invoke-RefreshPath
  $installDir = if ($env:SHROK_DIR) { $env:SHROK_DIR } else { "$env:USERPROFILE\shrok" }

  if (Test-Path "$installDir\.git") {
    Write-Step "Shrok already cloned at $installDir - pulling latest..."
    git -C $installDir pull --ff-only
    Write-Success "Updated"
  } else {
    Write-Step "Cloning Shrok into $installDir..."
    git clone https://github.com/getshrok/shrok.git $installDir
    Write-Success "Cloned"
  }

  $script:ShrokDir = $installDir
}

# --- npm install + setup wizard ----------------------------------------------

function Invoke-Setup {
  Set-Location $script:ShrokDir
  Invoke-RefreshPath

  Write-Step "Installing dependencies..."
  # Resolve npm.cmd explicitly - PowerShell's execution policy blocks npm.ps1
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { $npmCmd = Get-Command npm.exe -ErrorAction SilentlyContinue }
  if (-not $npmCmd) { Write-Err "npm not found. Please install Node.js 22+ from https://nodejs.org and re-run." }
  $npmLog = Join-Path $env:TEMP "shrok-npm-install.log"
  # Route through cmd.exe so stderr merging (2>&1) happens inside cmd rather than PowerShell.
  # PowerShell wraps native stderr as error records, which terminates the script under
  # `irm | iex` even when npm succeeds (update-notifier writes to stderr regardless of
  # --loglevel). cmd folds stderr into stdout before PowerShell sees it - no interpretation.
  & cmd.exe /c "`"$($npmCmd.Source)`" install --no-audit --no-fund --loglevel=error 2>&1" | Tee-Object -FilePath $npmLog
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed (exit $LASTEXITCODE). See log: $npmLog" }
  Write-Success "Dependencies installed (full log: $npmLog)"

  Write-Step "Running setup wizard..."
  Write-Host ""
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { Write-Err "node not found." }
  & $nodeCmd.Source --import tsx/esm scripts/setup/index.ts
  $script:SetupExit = $LASTEXITCODE
}

# --- Main ---------------------------------------------------------------------

Write-Host ""
Write-Host "  Shrok" -ForegroundColor Cyan
Write-Host "  Personal AI assistant installer" -ForegroundColor DarkGray
Write-Host ""

Ensure-Node
Ensure-Git
Invoke-CloneShrok
Invoke-Setup

if ($script:SetupExit -eq 0) {
  Write-Step "Starting Shrok (first boot will register daemon + CLI)..."
  # Launch via the shipped VBS daemon wrapper - wscript.exe has no console and
  # invokes the daemon ps1 with -WindowStyle Hidden, so nothing visible is spawned.
  # Using `Start-Process npm -WindowStyle Hidden` doesn't work here because npm.cmd
  # re-spawns cmd.exe which creates its own console regardless of the parent's flags.
  # First-boot runs inside this node process, registering the scheduled task + CLI.
  $vbsPath = Join-Path $script:ShrokDir "bin\shrok-daemon.vbs"
  if (Test-Path $vbsPath) {
    Start-Process "wscript.exe" -ArgumentList "`"$vbsPath`""
    Write-Success "Shrok is running silently. Daemon will auto-start on login."
    Write-Info "Run 'shrok status' or 'shrok doctor' after opening a new terminal."
  } else {
    Write-Warn "Daemon wrapper not found at $vbsPath - start Shrok manually: cd $($script:ShrokDir) && npm start"
  }
} elseif ($script:SetupExit -eq 2) {
  # Exit 2 = user chose "Start later" - config is saved, don't start
  Write-Success "Setup complete. Start when ready: cd $($script:ShrokDir) && npm start"
} else {
  Write-Warn "Setup wizard exited with code $($script:SetupExit)."
  Write-Info "Re-run it: cd $($script:ShrokDir) && npm run setup"
}
