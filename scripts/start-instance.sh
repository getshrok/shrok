#!/bin/bash
set -e
ID=${1:?Usage: start-instance.sh <instance-id>}
LOG="/tmp/shrok-$ID-$(date +%Y%m%d-%H%M%S).log"
WORKSPACE_PATH="$HOME/.shrok-$ID" npx tsx src/index.ts > "$LOG" 2>&1 &
echo "Started $ID (PID $!). Logs: $LOG"
