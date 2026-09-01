#!/bin/bash
# Post-cycle consistency check against the live database.
#
# Every check here is a claim the collector's invariants make, phrased so that
# a violation is loud rather than plausible:
#
#   1. No observation was stored from a throttled or failed fetch. Apple
#      answers a rate limit with an *empty result array*, so a 403/429 that
#      reached `ranking` would read as "the app is not ranking" — the exact
#      silent-garbage failure invariant 3 forbids.
#   2. Every ranking carries its provenance (status, collector version, count).
#   3. Every ranking has its indexed rank_entry rows, or the top-10 index and
#      the stored result list disagree.
#   4. R2 holds the normalised record for every ranking written today, because
#      R2 is the source of truth and `rebuild-d1` reads it, not D1.
#   5. Nothing is overdue by more than a day — a pair that stops being picked
#      loses history permanently and silently.
set -uo pipefail

# launchd starts jobs with a minimal PATH — not the interactive shell's — so
# `npx` is absent and every wrangler call fails with "command not found".
# Resolve the toolchain explicitly rather than depending on inherited env.
for candidate in "$HOME/.vite-plus/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -x "$candidate/npx" ] && PATH="$candidate:$PATH" && break
done
export PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/apps/collector" || exit 1
# wrangler.local.jsonc is gitignored, so it exists on the operator's machine and
# never on a runner. Prefer it when present, else the generated crawl config.
for candidate in wrangler.local.jsonc wrangler.localcrawl.jsonc wrangler.jsonc; do
  [ -f "$candidate" ] && CFG="$candidate" && break
done
[ -n "${CFG:-}" ] || { echo "  FAIL no wrangler config found"; exit 1; }
TODAY="$(date -u +%F)"
fail=0
note() { printf '  %s\n' "$*"; }

q() {
  npx wrangler d1 execute apprank --remote -c "$CFG" --json --command "$1" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[0]["results"]))' 2>/dev/null
}

echo "--- verify $TODAY ---"

row="$(q "SELECT
  (SELECT COUNT(*) FROM ranking WHERE observed_date='$TODAY') AS today,
  (SELECT COUNT(*) FROM ranking WHERE observed_date='$TODAY' AND (http_status!=200 OR valid!=1)) AS bad_status,
  (SELECT COUNT(*) FROM ranking WHERE observed_date='$TODAY' AND (collector_version IS NULL OR result_count IS NULL OR response_ms IS NULL)) AS no_provenance,
  (SELECT COUNT(*) FROM ranking WHERE observed_date='$TODAY' AND result_count=0) AS empty_results,
  (SELECT COUNT(*) FROM ranking r WHERE r.observed_date='$TODAY' AND NOT EXISTS (SELECT 1 FROM rank_entry re WHERE re.ranking_id=r.id)) AS no_entries,
  (SELECT COUNT(*) FROM crawl_pair WHERE ref_count>0) AS active_pairs,
  (SELECT COUNT(*) FROM crawl_pair WHERE ref_count>0 AND next_due_at < (strftime('%s','now')-86400)*1000) AS overdue,
  (SELECT COUNT(*) FROM fetch_error WHERE fetched_at > (strftime('%s','now')-3600)*1000) AS errors_1h,
  (SELECT COUNT(*) FROM rating_snapshot WHERE observed_date='$TODAY') AS ratings,
  (SELECT COUNT(*) FROM chart_ranking WHERE observed_date='$TODAY') AS charts,
  (SELECT COUNT(*) FROM review) AS reviews,
  (SELECT COUNT(*) FROM rating_snapshot WHERE observed_date='$TODAY' AND (rating_count IS NULL AND rating_avg IS NULL)) AS empty_ratings,
  (SELECT COUNT(*) FROM chart_ranking WHERE observed_date='$TODAY' AND (result_ids IS NULL OR result_ids='[]')) AS empty_charts,
  (SELECT COUNT(*) FROM fetch_error WHERE error_class='pull_abandoned' AND fetched_at > (strftime('%s','now')-86400)*1000) AS abandoned")"
[ -n "$row" ] || { note "FAIL could not read the database"; exit 1; }

get() { printf '%s' "$row" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['$1'])"; }

today=$(get today); bad=$(get bad_status); noprov=$(get no_provenance)
empty=$(get empty_results); noent=$(get no_entries); pairs=$(get active_pairs)
overdue=$(get overdue); err1h=$(get errors_1h)
ratings=$(get ratings); charts=$(get charts); reviews=$(get reviews)
empty_ratings=$(get empty_ratings); empty_charts=$(get empty_charts)
abandoned=$(get abandoned)

note "rankings today: $today / $pairs active pairs"
[ "$bad" -eq 0 ]    || { note "FAIL $bad ranking(s) stored from a non-200 or invalid fetch"; fail=1; }
[ "$noprov" -eq 0 ] || { note "FAIL $noprov ranking(s) missing provenance"; fail=1; }
[ "$empty" -eq 0 ]  || { note "FAIL $empty ranking(s) with zero results — a throttle stored as an observation"; fail=1; }
[ "$noent" -eq 0 ]  || { note "FAIL $noent ranking(s) with no rank_entry rows"; fail=1; }
[ "$overdue" -eq 0 ] || { note "WARN $overdue pair(s) overdue by more than a day"; }
[ "$err1h" -eq 0 ]  || note "note: $err1h fetch_error row(s) in the last hour"

# The app-level feeds. These sat at zero for a day because they ran only on
# Cloudflare, throttled, and gave up — and nothing here noticed, because the
# checks above only ever looked at `ranking`. A feed that is silently empty is
# the same class of failure as an observation that is silently wrong.
note "today: ratings=$ratings charts=$charts · reviews (all time)=$reviews"
[ "$empty_ratings" -eq 0 ] || { note "FAIL $empty_ratings rating_snapshot row(s) with no rating at all"; fail=1; }
[ "$empty_charts" -eq 0 ]  || { note "FAIL $empty_charts chart_ranking row(s) with an empty result list"; fail=1; }
[ "$abandoned" -eq 0 ] || note "WARN $abandoned batch(es) abandoned in the last 24h — a feed gave up for the day"
[ "$ratings" -gt 0 ] || note "WARN no rating_snapshot for today yet"
[ "$charts" -gt 0 ]  || note "WARN no chart_ranking for today yet"

# R2 is the rebuild source, so a D1 row without its archive object is the one
# failure that cannot be repaired later.
missing=0
for pid in $(q "SELECT pair_id FROM ranking WHERE observed_date='$TODAY' ORDER BY pair_id" \
             | python3 -c 'import json,sys; [print(r["pair_id"]) for r in json.load(sys.stdin)]'); do
  npx wrangler r2 object get "apprank-archive/staging/rankings/$TODAY/$pid.json" \
    --remote -c "$CFG" --file /dev/null >/dev/null 2>&1 || { missing=$((missing+1)); note "FAIL no R2 record for pair $pid"; }
done
[ "$missing" -eq 0 ] || fail=1
[ "$today" -eq 0 ] || note "R2 archive: $((today - missing))/$today present"

if [ "$fail" -eq 0 ]; then
  note "OK all consistency checks passed"
else
  note "*** $fail check group(s) FAILED ***"
fi
exit "$fail"
