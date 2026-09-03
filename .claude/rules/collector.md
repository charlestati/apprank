---
paths:
  - "apps/collector/**"
---

# The collector

A single `SchedulerDO` Durable Object owns all collection. Its `alarm()` does
**one** bounded unit of work per tick, one queued task step or one keyword
crawl, then reschedules itself at the learned rate. Two crons drive it:
`*/10 * * * *` re-arms a lost alarm, `0 3 * * *` queues the daily jobs
(compaction, App Store Connect poll, Monday Apple Ads pull, per-app lookups,
reviews, charts).

Two things adapt, and they are separate:

- **Rate** (`lib/pacing.ts`): how fast we may fetch. Two brakes, deliberately
  separate. The **pause** is per incident: any 403/429 parks the loop with
  exponential backoff (30m → 1h → 2h → 4h cap). The **rate** is a per-day trend:
  it starts at 4 fetches/min, halves **once** on the throttle that takes a day
  past `DAILY_THROTTLE_TOLERANCE` (floor 1/min), and recovers 10% per day that
  stayed within it (ceiling 18/min, just under Apple's documented 20). Once per
  day, not once per throttle: applying it to every subsequent hit turned the
  rate back into a one-way ratchet (4 → 2 → 1 in three hits), which is the
  failure the two-brake split exists to prevent. Persisted in `collector_state`,
  so a redeploy does not restart discovery.

  Recovery is judged on the closed day, **not** on a throttle-free 24h.
  Requiring a clean 24h made the raise unreachable on a shared egress IP that
  throttles most days, so the rate became a one-way ratchet down to the floor,
  and a floored rate silently shrinks the cadence budget. Most of Apple's bucket
  is consumed by other Workers on the same address, so halving our own share on
  one stray 429 costs coverage and relieves nothing; that is why the pause, not
  the rate, absorbs isolated hits.

- **Cadence** (`lib/budget.ts` + `tasks/cadence.ts`): how often each pair is
  checked, given that rate and how much work exists. The daily job measures
  capacity (`rate × window − app-level overhead`), scores every pair
  (popularity, proximity to the top-10 boundary, volatility, storefront weight,
  new-pair backfill, metadata burst), and splits them across two adjacent rungs
  of the ladder `[1, 2, 3, 7]` days so the load fits the budget exactly. Adding
  apps or keywords therefore costs resolution, never coverage; the plan is
  stored as `cadence_plan` and shown on the data-health page.

**Collection is split across two execution environments by design, and
`COLLECTION_MODE` is what divides it.** The deployed Worker sets `credentialed`
in the gitignored `wrangler.local.jsonc` and queues only App Store Connect and
Apple Ads. Rank crawls, metadata lookups, reviews and charts run from
`.github/workflows/collect.yml` and `scripts/local-refresh`, whose generated
config forces `all`. The default is `all`, which suits those two callers and
would be wrong on a Worker. Attempting them from a Worker was never free: each
429 fed `windowErrorCount`, and once that passed tolerance it halved the learned
rate, a known-broken path quietly degrading the signal that sets crawl cadence.
Manual triggers stay exempt: `crawlNow` fetches whatever it is asked to, which
is what makes "is Apple still blocking this IP?" answerable in one request.

Alarms are **at-least-once with automatic retries**, so every write must be
idempotent (`ranking` is unique on `(pair_id, observed_date)`; reviews key on
Apple's own review id). Never call `deleteAlarm()` inside `alarm()`.

`ensureAlarm()` pulls in an alarm parked more than a minute out, because a stale
long park (from an old deploy) otherwise blocks newly due work. The one
exception is a park matching an active `pauseUntil`: that park is deliberate,
and dragging it forward wakes the loop on every watchdog tick for the whole
backoff, spending two reads and a write each time to conclude it is still
paused.

## Adding an app or keywords

`tracked.local.json` (gitignored) is how the tracked set is authored. Each user
holds an `apps` array, because `tracked_app` has always been keyed
`(user_id, app_id)` and one person routinely ships more than one; `pnpm track`
reconciles it against the database and prints the difference, and
`pnpm track --apply` writes it. `tracked.example.json` shows the shape.

The file is the authoring surface, not the source of truth. That stays in rows,
because three things depend on it. `crawl_pair` is reference-counted, so two
users tracking the same keyword in the same storefront share one row and one
fetch a day. Ownership lives on `tracked_keyword.user_id`, which is what makes
another operator's data a 404. And removing a keyword **retires** its pairs
(`ref_count = 0`) rather than deleting them, because history cannot be
backfilled and a deleted day is the same as an uncollected one.

`language` does three jobs at once. It stamps every keyword in the entry,
records `app_language`, and picks each storefront's locale, so **one entry
cannot mix languages**. To track Spanish terms in the Spanish store beside
French ones, list the same `appId` twice with different `language` values;
`app_language` ends up with both rows, which is right for a bilingual listing.
`tracked.example.json` shows it. Keys beginning with an underscore are notes and
are skipped, so that annotated example can be copied as-is.

The dashboard picks the app with a switcher in the topbar, shown only when the
operator tracks more than one, because a select with a single option is a
control that cannot do anything. The choice persists in `localStorage` under
`apprank.app`, falls back to the first tracked app when the stored id is no
longer tracked, and returns to the report when switched from a pair detail,
since that route addresses one pair of the app being left behind.

The planner is pure and tested (`pnpm test:scripts`); the two rules worth not
breaking are that an unchanged config emits **no** statements (D1 charges for a
conflicting upsert even when it changes nothing), and that a storefront missing
from the reference data produces a warning rather than a guessed locale.

## Traps

- `wrangler dev --remote` no longer works for a Worker that declares a Durable
  Object: "`wrangler dev --remote` is no longer supported for Durable Objects."
  That is why the collector has one public route, `POST /admin/run?job=…` behind
  `ADMIN_TOKEN` (`src/lib/admin.ts`). Without it, verifying an Apple credential
  costs a day (the ASC cron) or a week (the Monday Ads gate).
- A throttled batch unit is retried in place twice, then rotated to the back of
  its own queue, and the batch is abandoned for the day once every unit has had
  its turn (`pull_abandoned`). `attempt` must actually be read: a storefront
  answering a persistent 403 on the lookup/reviews/charts endpoints otherwise
  starves every unit behind it indefinitely and burns the pause ladder daily,
  leaving `rating_snapshot`, `review` and `chart_ranking` empty with only
  `throttled` rows to show for it.

Task steps swallow a failed unit into `fetch_error` and return normally, so that
one bad unit cannot wedge the queue. Manual fetches also book their throttles
through `onAdminThrottle`, which records `lastErrorAt` and nothing else: the
admin path already ignores `pauseUntil` because it is a diagnostic, so letting
its hits feed the daily tally would let the measurement halve the rate it was
measuring. `runNow` therefore judges success by diffing `fetch_error` across the
call, not by whether the step threw. A manual trigger that answered `ok: true`
on a rejected credential would be worse than no trigger.
