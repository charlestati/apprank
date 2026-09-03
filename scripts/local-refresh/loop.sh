#!/bin/bash

# Hourly supervisor for refresh.sh.
#
# Deliberately not a launchd agent: `wrangler dev` never completes its remote
# D1/R2 connection under launchd's session (it reaches "Ready on" and then
# stalls), while the identical command from a normal login environment connects
# in seconds. Rather than fight that, this runs as a detached process started
# from a real shell, which does mean it dies on logout or reboot, and does not
# run while the Mac is asleep. Start it with `caffeinate` if it needs to
# survive the night.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERVAL="${APPRANK_REFRESH_INTERVAL:-3600}"
LOG_DIR="${APPRANK_LOG_DIR:-$HOME/Library/Logs/apprank}"
mkdir -p "$LOG_DIR"
echo "$(date -u +%FT%TZ) loop start (pid $$, every ${INTERVAL}s)" >>"$LOG_DIR/loop.log"
trap 'echo "$(date -u +%FT%TZ) loop stop" >>"$LOG_DIR/loop.log"; exit 0' TERM INT
while true; do
  "$ROOT/scripts/local-refresh/refresh.sh"
  echo "$(date -u +%FT%TZ) cycle exit=$?, sleeping ${INTERVAL}s" >>"$LOG_DIR/loop.log"
  # `sleep` as a foreground command defers signal handling until it returns, so
  # a plain TERM sat queued for up to an hour and the loop looked unkillable.
  # Backgrounding it lets the trap fire immediately.
  sleep "$INTERVAL" &
  wait $!
done
