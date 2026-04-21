#!/usr/bin/env bash
# Shrok uninstaller — macOS and Linux
# Usage: bash ~/shrok/scripts/uninstall.sh
set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[38;2;0;229;204m'
RED='\033[38;2;230;57;70m'
YELLOW='\033[38;2;255;176;32m'
NC='\033[0m'

info()    { echo -e "${DIM}  $*${NC}"; }
success() { echo -e "${CYAN}  ✓  $*${NC}"; }
warn()    { echo -e "${YELLOW}  ⚠  $*${NC}"; }
error()   { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
step()    { echo -e "\n${BOLD}  $*${NC}"; }

SHROK_DIR="${SHROK_DIR:-$HOME/shrok}"
OS="unknown"

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *) error "Unsupported OS: $(uname -s)" ;;
  esac
}

stop_shrok() {
  step "Stopping Shrok..."
  local pid
  pid="$(lsof -ti :8888 2>/dev/null || ss -tlnp 'sport = :8888' 2>/dev/null | grep -oP 'pid=\K\d+')" || true
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  success "Shrok process stopped"
}

remove_daemon() {
  step "Removing daemon..."
  if [[ "$OS" == "linux" ]]; then
    systemctl --user stop shrok    2>/dev/null || true
    systemctl --user disable shrok 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/shrok.service"
    systemctl --user daemon-reload    2>/dev/null || true
    success "Daemon removed (systemd)"
  elif [[ "$OS" == "macos" ]]; then
    local uid
    uid="$(id -u)"
    # Remove all known plist labels (current + legacy)
    for label in com.shrok.agent com.shrok.shrok local.shrok; do
      launchctl bootout "gui/$uid/$label" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/${label}.plist"
    done
    success "Daemon removed (launchd)"
  fi
}

remove_cli() {
  step "Removing CLI..."
  rm -f "$HOME/.local/bin/shrok"

  # Clean up PATH lines added by first-boot
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]]; then
      grep -v '\.local/bin' "$rc" > "$rc.tmp" && mv "$rc.tmp" "$rc" || rm -f "$rc.tmp"
    fi
  done
  local fish_config="$HOME/.config/fish/config.fish"
  if [[ -f "$fish_config" ]]; then
    grep -v '\.local/bin' "$fish_config" > "$fish_config.tmp" && mv "$fish_config.tmp" "$fish_config" || rm -f "$fish_config.tmp"
  fi

  success "CLI removed"
}

remove_repo() {
  step "Removing Shrok..."
  # Sanity check: refuse to delete home dir or root
  case "$SHROK_DIR" in
    /|"$HOME"|"$HOME/")
      warn "SHROK_DIR is set to '$SHROK_DIR' — refusing to delete. Unset it or fix the path."
      return 1
      ;;
  esac
  if [[ ! -f "$SHROK_DIR/package.json" ]]; then
    warn "'$SHROK_DIR' doesn't look like a Shrok install (no package.json). Skipping."
    return 1
  fi
  cd "$HOME"
  rm -rf "$SHROK_DIR"
  success "Shrok removed from $SHROK_DIR"
}

remove_workspace() {
  step "Workspace data..."
  echo ""
  warn "~/.shrok/ contains your memories, credentials, and conversation history."
  read -rp "  Remove it? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    rm -rf "$HOME/.shrok"
    success "Workspace data removed"
  else
    info "Workspace data kept at ~/.shrok/"
  fi
}

main() {
  echo ""
  echo -e "${BOLD}${CYAN}  Shrok — Uninstall${NC}"
  echo -e "${DIM}  This will remove Shrok from your system.${NC}"
  echo ""

  detect_platform
  remove_daemon
  stop_shrok
  remove_cli
  remove_repo
  remove_workspace

  echo ""
  echo -e "${CYAN}  Shrok has been uninstalled.${NC}"
  echo ""
}

main "$@"
