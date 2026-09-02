#!/bin/bash

# One local collection cycle, run from a machine Apple will actually answer.
#
# Why this exists: Apple rate-limits the public iTunes endpoints per IP, and
# every Cloudflare Worker egresses from a shared pool that is already spent, so
# the deployed collector is throttled to a standstill (see CLAUDE.md, invariant
# 4). This runs the *same* collector code under `wrangler dev` with remote D1
# and R2 bindings, so the observations it writes carry the same normaliser, the
# same provenance and the same idempotent keys as the scheduler's own.
#
# It is deliberately not a second scheduler. It crawls only what D1 says is
# due, at the rate lib/pacing.ts starts at, and stops dead on the first
# throttle.
set -uo pipefail

# launchd starts jobs with a minimal PATH, not the interactive shell's, so
# `npx` is absent and every wrangler call fails with "command not found".
# Resolve the toolchain explicitly rather than depending on inherited env.
for candidate in "$HOME/.vite-plus/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -x "$candidate/npx" ] && PATH="$candidate:$PATH" && break
done
export PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COLLECTOR="$ROOT/apps/collector"
CONFIG="wrangler.localcrawl.jsonc"
PORT="${APPRANK_REFRESH_PORT:-8799}"
BASE="http://localhost:$PORT/admin/run"
LOG_DIR="${APPRANK_LOG_DIR:-$HOME/Library/Logs/apprank}"
STATE_DIR="$LOG_DIR/state"
# 15s between fetches = 4/min, the rate lib/pacing.ts starts at. A residential
# IP is not a licence to rush.
SPACING="${APPRANK_REFRESH_SPACING:-15}"
# Ceilings on one cycle, in units. Both are sized against SPACING, since the
# sleep dominates: at 4/min these are 35 and 20 minutes of wall clock, and the
# measured cost is nearer 21s a unit than 15s because the POST round-trip lands
# on top of the sleep. So a full cycle is ~55 minutes, not 55/60 * 45.
#
# The pair ceiling has to clear the tracked set or the tail is never reached:
# ordering is overdue-age x storefront weight, so a cap below the set count
# starves the lowest-weighted storefront every run rather than sharing the
# shortfall. Nothing is lost when it does bind, since an uncrawled pair stays
# due, but it is silent, so keep this above the pair count.
MAX_UNITS="${APPRANK_REFRESH_MAX_UNITS:-140}"
# Consecutive stalls that mean the dev session is wedged rather than slow.
MAX_MISSES="${APPRANK_REFRESH_MAX_MISSES:-3}"
MAX_STEPS="${APPRANK_REFRESH_MAX_STEPS:-80}"

mkdir -p "$LOG_DIR" "$STATE_DIR"
LOG="$LOG_DIR/refresh-$(date -u +%Y-%m-%d).log"
# Every line goes to both the log file and stderr. The file is what the local
# loop keeps; stderr is what a CI job shows. Logging only to a file made a
# failed run completely opaque when the artifact upload found nothing.
say() {
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2
}

# Strip the keyword out of a response body before it is logged. This log ships
# as a CI artifact, and on a public repository both artifacts and job logs are
# readable by anyone with the run URL, and the tracked keyword set is the
# operator's ASO strategy and has no business being published with it. Applied
# to every body logged whole, not only the ones known to carry the field today.
redact() {
  printf '%s' "$1" | sed -E 's/"keyword":"([^"\\]|\\.)*"/"keyword":"<redacted>"/g'
}

cd "$COLLECTOR" || { say "FATAL cannot cd to $COLLECTOR"; exit 1; }
[ -f "$CONFIG" ] || { say "FATAL missing $CONFIG"; exit 1; }
[ -f .dev.vars ] || { say "FATAL missing .dev.vars (ADMIN_TOKEN)"; exit 1; }
TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars | head -1)"
[ -n "$TOKEN" ] || { say "FATAL ADMIN_TOKEN empty"; exit 1; }

# A previous cycle that died leaves the port held; refuse rather than fight it.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "SKIP port $PORT already in use, a cycle is still running"
  exit 0
fi

say "=== cycle start ==="
# One log per cycle. A shared daily file made the readiness grep match the
# *previous* cycle's "Ready on" line, so the warm-up fired at a server that had
# not started yet and the whole cycle failed in under a second.
DEV_LOG="$LOG_DIR/wrangler-$(date -u +%Y%m%dT%H%M%S).log"
# No TTY under launchd: wrangler dev is an interactive command, and left to
# infer that for itself it stalls part-way through establishing the remote
# binding session. Say so explicitly and give it a closed stdin.
npx wrangler dev -c "$CONFIG" --port "$PORT" \
  --show-interactive-dev-session=false </dev/null >>"$DEV_LOG" 2>&1 &
DEV_PID=$!
cleanup() {
  kill "$DEV_PID" 2>/dev/null
  # wrangler spawns a supervisor and workerd children; the group goes together.
  pkill -P "$DEV_PID" 2>/dev/null
  wait "$DEV_PID" 2>/dev/null
}
trap cleanup EXIT

# Wait for wrangler's own readiness line rather than probing HTTP: the port
# accepts connections before the remote D1/R2 session is established, so an
# early request can block for minutes.
for _ in $(seq 1 60); do
  grep -q "Ready on" "$DEV_LOG" 2>/dev/null && break
  sleep 2
done
if ! grep -q "Ready on" "$DEV_LOG" 2>/dev/null; then
  say "FATAL dev server never came up; see $DEV_LOG"
  exit 1
fi

post() { curl -s --max-time 300 -X POST -H "Authorization: Bearer $TOKEN" "$BASE?job=$1"; }

# First authenticated call opens the remote-binding session and can take far
# longer than a steady-state one. Spend that latency on a job that touches no
# Apple endpoint, so a slow start never looks like a throttle.
warm="$(post cadence)"
case "$warm" in
  *'"ok":true'*) say "warm-up ok" ;;
  *) say "FATAL warm-up failed: ${warm:-<empty response>}"; exit 1 ;;
esac

crawled=0
throttled=0
misses=0
for _ in $(seq 1 "$MAX_UNITS"); do
  r="$(post crawl)"
  case "$r" in
    *'"empty":true'*) say "drained after $crawled pair(s)"; break ;;
    *'"throttled":true'*)
      throttled=1
      say "THROTTLED, stopping this cycle: $(redact "$r")"
      break ;;
    *'"empty":false'*)
      crawled=$((crawled + 1))
      # A crawl that worked clears the miss count: only *consecutive* stalls
      # mean the session is wedged. Without this, two unrelated timeouts half an
      # hour apart abandon a window that was collecting fine.
      misses=0
      # The pair id, never the keyword (see redact), because an id means nothing
      # without the database.
      say "crawled pair $(printf '%s' "$r" | sed -n 's/.*"pairId":\([0-9]*\).*/\1/p')"
      sleep "$SPACING" ;;
    "")
      # An empty body is a timeout, not an answer. `wrangler dev` occasionally
      # stalls a request for the full --max-time; retry rather than give up on
      # a window that cannot be collected later.
      misses=$((misses + 1))
      say "empty response (miss $misses of $MAX_MISSES)"
      [ "$misses" -ge "$MAX_MISSES" ] && { say "stopping after $misses consecutive empty responses"; break; }
      sleep "$SPACING" ;;
    *)
      say "UNEXPECTED response, stopping: $(redact "$r")"
      break ;;
  esac
done

# App-level pulls: metadata lookup, ratings, reviews, charts, compaction, ASC.
#
# These are enqueued by the 03:00 cron into *production's* Durable Object and
# then die there: they hit the same public iTunes endpoints as the crawler, from
# the same blocked Cloudflare addresses, so they throttle, retry, and end in
# `pull_abandoned`. Running the same fan-out here puts them on an IP Apple
# answers. The DO queue is local to this dev session and persists in
# .wrangler/state, so anything a previous cycle left behind drains too.
#
# Once per UTC day, because that is the grain every one of these writes uses.
DAILY_MARKER="$STATE_DIR/daily-$(date -u +%F).done"
if [ "$throttled" -eq 0 ] && [ ! -f "$DAILY_MARKER" ]; then
  d="$(post daily)"
  case "$d" in
    *'"queued"'*) say "daily fan-out queued: $d"; : >"$DAILY_MARKER" ;;
    *) say "daily fan-out failed, will retry next cycle: ${d:-<empty response>}" ;;
  esac
fi

steps=0
step_fails=0
for _ in $(seq 1 "$MAX_STEPS"); do
  r="$(post step)"
  case "$r" in
    *'"empty":true'*) [ "$steps" -gt 0 ] && say "queue drained after $steps step(s)"; break ;;
    *'"ok":true'*)
      steps=$((steps + 1)); step_fails=0
      say "step: $r"
      sleep "$SPACING" ;;
    "")
      step_fails=$((step_fails + 1))
      say "step: empty response ($step_fails)"
      [ "$step_fails" -ge 2 ] && { say "stopping drain after repeated empty responses"; break; }
      sleep "$SPACING" ;;
    *)
      # A step that records a fetch_error still returns and still advances the
      # queue, so one bad unit must not end the drain, only a run of them.
      steps=$((steps + 1)); step_fails=$((step_fails + 1))
      say "step (recorded an error): $r"
      [ "$step_fails" -ge 4 ] && { say "stopping drain after $step_fails failing steps"; break; }
      sleep "$SPACING" ;;
  esac
done

say "crawled=$crawled throttled=$throttled steps=$steps"
printf '%s crawled=%s throttled=%s steps=%s\n' "$(date -u +%FT%TZ)" "$crawled" "$throttled" "$steps" \
  >>"$STATE_DIR/cycles.tsv"

"$ROOT/scripts/local-refresh/verify.sh" >>"$LOG" 2>&1
verify_status=$?
say "verify exit=$verify_status"
# Keep only the last day of per-cycle wrangler logs.
find "$LOG_DIR" -name 'wrangler-*.log' -mtime +1 -delete 2>/dev/null
say "=== cycle end ==="
exit "$verify_status"
