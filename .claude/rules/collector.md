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

`tracked.local.json` (gitignored) is a local copy of the tracked set that you
edit. Each user holds an `apps` array, because `tracked_app` has always been
keyed `(user_id, app_id)` and one person routinely ships more than one;
`pnpm track` prints what the file would add, and `pnpm track --apply` writes it.
`tracked.example.json` shows the shape.

**The file is a copy, the rows are the truth, and the tool only adds unless told
otherwise.** The file is not the only writer: accepting a suggestion on the
dashboard creates tracking rows too. When `pnpm track` treated the file as
complete, its next run deleted those rows and retired their pairs, silently,
because an accepted keyword and a deleted line look identical from the file's
side. So a plain run reports what the database holds and the file does not, and
keeps it. `pnpm track --pull` adds those keywords to the file. A keyword's
storefronts are the ones it is collected in _and_ that user claimed, through an
entry for that app and language or an accepted suggestion, because `crawl_pair`
is shared and holds other users' storefronts too. It joins an entry only when
that entry's storefronts are exactly its own, since joining a wider one creates
pairs on the next apply that nobody chose. Removal is `pnpm track --prune`,
which touches only the users the file names and never retires a pair someone
else still tracks. Pull before pruning, or the prune takes the dashboard's
additions with it.

The truth stays in rows because three things depend on it. `crawl_pair` is
reference-counted, so two users tracking the same keyword in the same storefront
share one row and one fetch a day. Ownership lives on `tracked_keyword.user_id`,
which is what makes another operator's data a 404. And removing a keyword
**retires** its pairs (`ref_count = 0`) rather than deleting them, because
history cannot be backfilled and a deleted day is the same as an uncollected
one.

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

## Backfill

Popularity is the one thing here that can be recovered after the fact:
`POST /admin/run?job=ads_backfill` queues the Apple Ads by-name pass for every
tracked keyword a recent week holds no storefront-wide answer for, bounded by
the `ads:backfill_weeks` collector_state key (13 weeks, the report's longest
window). Ranks cannot be recovered and never will be, so do not reach for a
similar job there.

## Keyword discovery

`job=ads_discover` asks Apple's `suggestions/keywords/query` one seed at a time,
seeded from the keywords somebody already tracks, and writes what comes back to
`suggestion`. It spends no crawl budget: a proposal is a row, and only an
operator accepting one creates a pair.

Two filters, in two places, because they can afford different things.

- **In the collector**, a proposal must share a whole word with its seed. That
  is the best rule a Worker can apply with no model, and it is the floor: it
  runs whether or not anyone is at a laptop. Token-based, never substring, since
  "local" sits inside "localisation" and "locality".
- **On a laptop**, `pnpm relevance` scores what got through against the tracked
  set with a local embedding model and dismisses the tail. Word overlap admits
  same-word false friends the model catches easily: measured on the live French
  set, two such false friends scored 0.700 and 0.689, while the first real
  variant sat at 0.785. It never proposes anything, only rules out, so a laptop
  that never runs costs precision and not coverage.

Absolute scores mean little and the cut is model-specific:
`qwen3-embedding:0.6b` puts short related phrases between 0.69 and 0.99, so only
the ranking informs. The script prints the whole distribution and dismisses
nothing without `--apply`.

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

**Archive writes go through `lib/archive`, never `env.ARCHIVE.put` directly.**
R2 on this account really does refuse: twenty `put`s failed on 2026-09-11 with
"We encountered an internal error. Please try again. (10001)", and because the
refusal arrives as a _throw_, a retry loop that only re-checks `head` never runs
a second time. `putArchived` retries the call itself and then reads the object
back, and throws when it did not land, so no row is derived from a response
nothing can prove we received (invariant 2). `tryPut` is for the diagnostic
objects only, where losing the sample costs less than losing the observation
that depends on it.

Task steps swallow a failed unit into `fetch_error` and return normally, so that
one bad unit cannot wedge the queue. Manual fetches also book their throttles
through `onAdminThrottle`, which records `lastErrorAt` and nothing else: the
admin path already ignores `pauseUntil` because it is a diagnostic, so letting
its hits feed the daily tally would let the measurement halve the rate it was
measuring. `runNow` therefore judges success by diffing `fetch_error` across the
call, not by whether the step threw. A manual trigger that answered `ok: true`
on a rejected credential would be worse than no trigger.
