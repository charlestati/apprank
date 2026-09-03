# Architecture

Two Workers (`apprank-collector`, `apprank-web`), one D1 database, one R2
bucket.

| Path                    | What it is                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`         | Drizzle schema + migrations, SQL seeds, Apple clients (WebCrypto ES256 JWT for Ads and App Store Connect), iTunes normalisers |
| `apps/collector`        | The collector Worker. Two crons drive one `SchedulerDO` work loop, plus one admin route to trigger a job by hand              |
| `apps/web`              | Hono JSON API, MCP endpoint, and the React SPA on Workers Static Assets                                                       |
| `scripts/local-refresh` | Drives the collector from a runner or your own machine. This is what the GitHub Actions half runs                             |
| `scripts/track`         | Reconciles the tracked set against `tracked.local.json`                                                                       |
| `scripts/mcp-token`     | Issues an MCP credential and prints the SQL to apply it                                                                       |
| `scripts/rebuild-d1`    | Rebuild or verify rank observations from the R2 archive                                                                       |

## Three rules that shape the rest

- **History cannot be backfilled.** Apple publishes no past ranks. Pairs carry a
  `next_due_at`, so an outage runs late rather than never, but midnight UTC is
  the deadline: an observation is keyed to its date.
- **Visible gaps beat silent garbage.** Every observation carries provenance
  (HTTP status, response time, result count, collector version, archive key);
  Apple's 403-with-empty-results rate limit is recorded as an error, not stored
  as "not ranking".
- **Reference data is rows, not code.** Adding a storefront, locale, genre or
  keyword is an `INSERT`, not a migration or a redeploy.

## The work loop

One bounded unit of work per Durable Object alarm tick: a single API task or
keyword crawl, at a learned rate. Two brakes, deliberately separate. Any 403/429
**pauses** the loop, backing off 30 m to a 4 h cap. The **rate** is a per-day
trend, starting at 4/min, halving once on the day a throttle passes tolerance
and recovering 10% per clean day (floor 1/min, ceiling 18/min, just under
Apple's documented 20). Halving on every hit instead of once a day ratchets it
to the floor on a shared egress IP.

A 10-minute cron re-arms a lost alarm; 03:00 UTC queues the daily jobs.

Alarms are at-least-once, so writes are idempotent: `ranking` is unique on
`(pair_id, observed_date)`, reviews key on Apple's review id.

## Cadence

Each day the collector works out what the learned rate affords, subtracts the
app-level pulls, and re-spaces every pair across a `1 / 2 / 3 / 7`-day ladder so
the total fits. Pairs are ranked by popularity, proximity to the top-10
boundary, recent movement, storefront weight, and whether the metadata changed.

Adding keywords therefore costs resolution on the least informative pairs, never
coverage, because a dropped pair loses its history for good. The current plan
appears on the data-health page ("340 pairs every 1d, 260 every 2d").

## Data model

User intent (`tracked_app`, `tracked_keyword`) is separate from what is
observed. The crawl unit is `crawl_pair`, the reference-counted union of
distinct (keyword, storefront, locale) triples, so two users tracking one
keyword produce one fetch.

A keyword is tracked against a **(storefront, locale)** pair because Apple
cross-localizes: Canada indexes `en-CA` and `fr-CA`, Belgium three, Switzerland
four. Which storefronts matter follows the app's content language
(`app_language`), not market size. `app_localization` records "no localization
for this storefront's indexed locale" as a first-class state, since that gap is
itself an ASO finding.

`ranking` stores up to 200 track ids as JSON plus provenance; `rank_entry`
indexes only the top 10 and any tracked app, because a row per position would be
18× the write budget.

## R2 archive

```
rankings/v1/{yyyy-mm}/{storefront}/{date}.ndjson     permanent, the rebuild source
staging/rankings/{date}/{pairId}.json                pre-compaction (7-day lifecycle)
verbatim/{date}/…                                    failures + 1-in-10 sample (21-day lifecycle)
asc/{appId}/{report}/{granularity}/{date}-….tsv.gz   App Store Connect, as downloaded
ads/popularity/{week}/{storefront}/{genre}.json      Apple Ads, as fetched
charts/… lookups/… reviews/…                         as fetched
```

D1 holds a hot window, the archive holds everything, which is what makes
pruning, retention and schema changes performance choices rather than lossy
ones. Rebuild with `pnpm rebuild:d1` (not `pnpm rebuild`, a pnpm built-in).

It reads `rankings/v1/` and writes `ranking`. The other observation tables are
recoverable in principle but no script does it, so treat a D1 prune as
reversible only for rank observations.

## Release markers

The rank chart pins an app's releases as numbered markers, and nothing enters
them by hand. The daily lookup pull stores one `app_metadata_version` row per
change to the listing (version, title, subtitle, price, description,
release-notes and screenshot hashes), and that table is the event log the
markers are drawn from. A release therefore appears the day after Apple starts
serving it, tagged with what changed, and cannot be added early or backdated: a
release before tracking began has no row and gets no pin. If a release is
missing, the lookup for that storefront failed that day; the data-health page
shows the error.

## Difficulty

Computed daily from observations already held: the rating mass of the top 3 and
top 10, how much the page turns over, and how full it is, on a log scale. Every
input is stored beside the score with `formula_version` and the sample size, so
the weights can change and the history be recomputed. Pages with no known rating
counts are skipped rather than scored from nothing, and an asterisk marks a
score built from fewer than five known incumbents.

## Not built yet

The Tier-2 global market sweep (to calibrate difficulty against market-wide
distributions rather than the current absolute scale), brand-versus-generic
keyword classification, iPad as a separate device dimension, hourly granularity,
and Google Play.

Out of scope: download and revenue estimation for other people's apps, which
needs panel data this does not have; team accounts and billing; anything with an
LLM in it.
