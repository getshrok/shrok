#!/usr/bin/env bash
# Shrok installer — macOS and Linux (Debian/Ubuntu, Fedora/RHEL, Arch, Alpine, openSUSE)
# Usage: curl -fsSL https://raw.githubusercontent.com/getshrok/shrok/main/scripts/install.sh | bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[38;2;0;229;204m'
RED='\033[38;2;230;57;70m'
YELLOW='\033[38;2;255;176;32m'
NC='\033[0m'

info()    { [[ "$VERBOSE" == "1" ]] && echo -e "${DIM}  $*${NC}" || echo -e "${DIM}  $*${NC}"; }
success() { echo -e "${CYAN}  ✓  $*${NC}"; }
warn()    { echo -e "${YELLOW}  ⚠  $*${NC}"; }
error()   { echo -e "${RED}  ✗  $*${NC}"; }
header()  { echo -e "\n${BOLD}${CYAN}  $*${NC}\n"; }
step()    { echo -e "\n${BOLD}  $*${NC}"; }
debug()   { [[ "$VERBOSE" == "1" ]] && echo -e "${DIM}    [debug] $*${NC}" || true; }
run()     {
  debug "\$ $*"
  if [[ "$DRY_RUN" == "1" ]]; then return 0; fi
  "$@"
}

# ─── Flags ────────────────────────────────────────────────────────────────────

DRY_RUN=0
VERBOSE=0
NO_START=0
SHROK_DIR="${SHROK_DIR:-$HOME/shrok}"

print_usage() {
  cat <<EOF
Shrok installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/getshrok/shrok/main/scripts/install.sh | bash
  ./scripts/install.sh [options]

Options:
  --dir <path>    Install directory (default: ~/shrok, or \$SHROK_DIR)
  --dry-run       Print what would happen without making changes
  --verbose       Print each command as it runs
  --no-start      Skip running 'npm start' at the end
  --help, -h      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --dir) SHROK_DIR="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) warn "Unknown flag: $1"; shift ;;
  esac
done

[[ "$DRY_RUN" == "1" ]] && warn "Dry run — no changes will be made"

# ─── Root / sudo helpers ──────────────────────────────────────────────────────

is_root() { [[ "$(id -u)" -eq 0 ]]; }

require_sudo() {
  [[ "$OS" != "linux" ]] && return 0
  is_root && return 0
  if ! command -v sudo &>/dev/null; then
    error "sudo is required but not installed. Install sudo or re-run as root."
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    info "Administrator privileges required; enter your password."
    sudo -v
  fi
}

maybe_sudo() {
  if is_root; then "$@"; else sudo "$@"; fi
}

# ─── Platform / distro detection ──────────────────────────────────────────────

OS="unknown"
ARCH="unknown"
DISTRO_FAMILY="unknown"  # debian|rhel|arch|alpine|suse|macos
PKG_MGR=""

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS="macos"; DISTRO_FAMILY="macos" ;;
    Linux)  OS="linux" ;;
    *) error "Unsupported operating system: $(uname -s)"; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  ARCH="x86_64" ;;
    arm64|aarch64) ARCH="arm64"  ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac

  if [[ "$OS" == "linux" ]]; then
    if   command -v apt-get &>/dev/null; then DISTRO_FAMILY="debian";  PKG_MGR="apt-get"
    elif command -v dnf     &>/dev/null; then DISTRO_FAMILY="rhel";    PKG_MGR="dnf"
    elif command -v yum     &>/dev/null; then DISTRO_FAMILY="rhel";    PKG_MGR="yum"
    elif command -v pacman  &>/dev/null; then DISTRO_FAMILY="arch";    PKG_MGR="pacman"
    elif command -v apk     &>/dev/null; then DISTRO_FAMILY="alpine";  PKG_MGR="apk"
    elif command -v zypper  &>/dev/null; then DISTRO_FAMILY="suse";    PKG_MGR="zypper"
    else
      error "No supported package manager found (apt-get, dnf, yum, pacman, apk, zypper)."
      info  "Install Node.js 22+ and git manually, then re-run this script."
      exit 1
    fi
  fi

  success "Platform: $OS ($ARCH)${DISTRO_FAMILY:+ / $DISTRO_FAMILY}${PKG_MGR:+ / $PKG_MGR}"
}

# ─── Package install dispatcher ───────────────────────────────────────────────

pkg_install() {
  # $@ = package names (use per-family names; caller picks the right one)
  local pkgs="$*"
  case "$DISTRO_FAMILY" in
    debian) run maybe_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y $pkgs ;;
    rhel)   run maybe_sudo "$PKG_MGR" install -y $pkgs ;;
    arch)   run maybe_sudo pacman -S --noconfirm --needed $pkgs ;;
    alpine) run maybe_sudo apk add --no-cache $pkgs ;;
    suse)   run maybe_sudo zypper --non-interactive install $pkgs ;;
    macos)  run brew install $pkgs ;;
    *) error "Unknown distro family: $DISTRO_FAMILY"; return 1 ;;
  esac
}

pkg_refresh() {
  case "$DISTRO_FAMILY" in
    debian) run maybe_sudo apt-get update -qq ;;
    rhel)   : ;;  # dnf/yum refresh on install
    arch)   run maybe_sudo pacman -Sy --noconfirm ;;
    alpine) run maybe_sudo apk update ;;
    suse)   run maybe_sudo zypper --non-interactive refresh ;;
    macos)  : ;;
  esac
}

# ─── macOS: Homebrew ──────────────────────────────────────────────────────────

ensure_homebrew() {
  if command -v brew &>/dev/null; then success "Homebrew already installed"; return; fi
  step "Installing Homebrew..."
  info "This may ask for your Mac password."
  run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ "$ARCH" == "arm64" && -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile" 2>/dev/null || true
  fi
  success "Homebrew installed"
}

# ─── Node.js ──────────────────────────────────────────────────────────────────

node_major() {
  command -v node &>/dev/null || return 1
  node --version | sed 's/v//' | cut -d. -f1
}

ensure_node() {
  if command -v node &>/dev/null; then
    local v; v="$(node_major || echo 0)"
    if [[ "$v" -ge 22 ]]; then success "Node.js $(node --version) already installed"; return; fi

    # NVM hint — installing system node won't help if nvm's shim shadows PATH
    if [[ "$(command -v node)" == *".nvm"* ]]; then
      error "NVM is active with Node $(node --version), but Shrok requires Node 22+."
      info "Fix: nvm install 22 && nvm alias default 22"
      info "Then restart your terminal and re-run the installer."
      exit 1
    fi
    warn "Node.js $(node --version) found but v22+ required — upgrading"
  fi

  step "Installing Node.js 22..."
  if [[ "$OS" == "macos" ]]; then
    # Unlink any existing node formula to avoid keg-only collision
    brew unlink node 2>/dev/null || true
    pkg_install node@22
    if ! brew link --overwrite --force node@22 2>/dev/null; then
      warn "brew link failed — adding node@22 to PATH directly"
      local node_prefix; node_prefix="$(brew --prefix node@22 2>/dev/null)"
      if [[ -n "$node_prefix" && -d "$node_prefix/bin" ]]; then
        export PATH="$node_prefix/bin:$PATH"
      else
        error "Could not find node@22 after install. Run: brew link --overwrite --force node@22"
      fi
    fi
    return
  fi

  require_sudo
  case "$DISTRO_FAMILY" in
    debian)
      # Remove distro nodejs if present — conflicts with NodeSource
      if dpkg -l nodejs 2>/dev/null | grep -q '^ii'; then
        run maybe_sudo apt-get remove -y nodejs npm 2>/dev/null || true
      fi
      run bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | $(is_root || echo sudo -E ) bash -"
      pkg_install nodejs
      ;;
    rhel)
      run bash -c "curl -fsSL https://rpm.nodesource.com/setup_22.x | $(is_root || echo sudo ) bash -"
      pkg_install nodejs
      ;;
    arch)    pkg_install nodejs npm ;;
    alpine)  pkg_install nodejs npm ;;
    suse)    pkg_install nodejs22 npm22 ;;
    *) error "Don't know how to install Node on $DISTRO_FAMILY"; exit 1 ;;
  esac
  success "Node.js $(node --version) installed"
}

# ─── Git ──────────────────────────────────────────────────────────────────────

ensure_git() {
  if command -v git &>/dev/null; then success "Git already installed"; return; fi
  step "Installing Git..."
  [[ "$OS" == "linux" ]] && require_sudo
  pkg_install git
  success "Git installed"
}

# ─── Clone Shrok ──────────────────────────────────────────────────────────────

clone_shrok() {
  if [[ -d "$SHROK_DIR/.git" ]]; then
    step "Shrok already cloned at $SHROK_DIR — pulling latest..."
    run git -C "$SHROK_DIR" pull --ff-only
    success "Updated"
  else
    step "Cloning Shrok into $SHROK_DIR..."
    run git clone https://github.com/getshrok/shrok.git "$SHROK_DIR"
    success "Cloned"
  fi
}

# ─── npm install + setup wizard ───────────────────────────────────────────────

run_setup() {
  step "Installing dependencies..."
  run cd "$SHROK_DIR"
  if [[ "$DRY_RUN" != "1" ]]; then cd "$SHROK_DIR"; fi
  NPM_LOG="${TMPDIR:-/tmp}/shrok-npm-install.log"
  run bash -c "npm install --no-audit --no-fund --loglevel=error 2>&1 | tee '$NPM_LOG'"
  success "Dependencies installed (full log: $NPM_LOG)"

  step "Running setup wizard..."
  echo ""
  SETUP_EXIT=0
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    run bash -c 'node --import tsx/esm scripts/setup/index.ts </dev/tty' || SETUP_EXIT=$?
  else
    info "No interactive terminal available — skipping wizard."
    info "Run manually: cd $SHROK_DIR && npm run setup"
    SETUP_EXIT=99
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}${CYAN}  Shrok${NC}"
  echo -e "${DIM}  Personal AI assistant installer${NC}"
  echo ""

  detect_platform
  [[ "$OS" == "macos" ]] && ensure_homebrew

  ensure_node
  ensure_git
  clone_shrok
  run_setup

  if [[ "$SETUP_EXIT" == "99" ]]; then
    warn "Setup wizard was skipped (no TTY)."
    info "Run it manually: cd $SHROK_DIR && npm run setup"
  elif [[ "$SETUP_EXIT" == "2" ]]; then
    # Exit 2 = user chose "Start later" — config is saved, don't start
    success "Setup complete. Start when ready: cd $SHROK_DIR && npm start"
  elif [[ "$SETUP_EXIT" != "0" ]]; then
    warn "Setup wizard exited with code $SETUP_EXIT."
    info "Re-run it: cd $SHROK_DIR && npm run setup"
  elif [[ "$NO_START" == "1" ]]; then
    info "Skipped 'npm start' (--no-start)."
    info "Start manually: cd $SHROK_DIR && npm start"
  elif [[ "$DRY_RUN" != "1" ]]; then
    local log_file="$HOME/.shrok/shrok.log"
    mkdir -p "$HOME/.shrok"
    (cd "$SHROK_DIR" && npm start >> "$log_file" 2>&1 &)
    disown 2>/dev/null || true
    success "Shrok is starting. Logs: $log_file"
  fi
}

main "$@"
