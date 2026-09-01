# Architecture

Two Workers (`apprank-collector`, `apprank-web`), one D1 database, one R2
bucket.

| Path                 | What it is                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | Drizzle schema + migrations, SQL seeds, Apple clients (WebCrypto ES256 JWT for Ads and App Store Connect), iTunes normalisers |
| `apps/collector`     | The crawler. Two crons drive one `SchedulerDO` work loop                                                                      |
| `apps/web`           | Hono JSON API + React SPA on Workers Static Assets                                                                            |
| `scripts/rebuild-d1` | Rebuild or verify D1 observations from the R2 archive                                                                         |

## Four rules that shape the rest

- **History cannot be backfilled**, so the collector ships before the UI and
  runs gap-free from day one.
- **Visible gaps beat silent garbage.** Every observation carries provenance
  (HTTP status, response time, result count, collector version, archive key);
  Apple's 403-with-empty-results rate limit is recorded as an error, never
  stored as "not ranking".
- **Politeness is a correctness requirement.** All Workers egress shares
  Cloudflare IPs and Apple rate-limits by IP, so the crawler discovers its own
  sustainable rate and backs off hard.
- **Reference data is rows, not code.** Adding a storefront, locale, genre or
  keyword is an `INSERT`, never a migration or a redeploy.

## The work loop

The collector runs one bounded unit of work per Durable Object alarm tick — one
API task, or one keyword crawl — at an adaptive learned rate. Two brakes,
deliberately separate: any 403/429 **pauses** the loop with exponential backoff
(30 m to a 4 h cap), while the **rate** is a per-day trend — it starts at 4/min,
halves once on the throttle that takes a day past tolerance, and recovers 10%
per day that stayed within it (floor 1/min, ceiling 6/min). Halving on every hit
made the rate a one-way ratchet to the floor on a shared egress IP, which
silently shrinks the crawl budget.

A 10-minute watchdog cron re-arms the alarm; a 03:00 UTC cron queues the daily
jobs (archive compaction, App Store Connect poll, Monday Apple Ads pull, per-app
lookups, reviews and charts).

Alarms are at-least-once with automatic retries, so every write is idempotent:
`ranking` is unique on `(pair_id, observed_date)` and reviews key on Apple's own
review id.

## Cadence

Crawl cadence adapts to the tracked set. Each day the collector works out how
many fetches the learned rate affords, subtracts what the app-level pulls cost,
and re-spaces every tracked pair across a `1 / 2 / 3 / 7`-day ladder so the
total fits. Pairs are ordered by keyword popularity, how close the app sits to
the top-10 boundary, how much the rank has been moving, storefront weight, and
whether the app's metadata changed recently.

Adding apps or keywords costs resolution on the least informative pairs — never
coverage, because a dropped pair loses its history for good. The current plan
appears on the data-health page ("340 pairs every 1d, 260 every 2d").

## Data model

User intent (`tracked_app`, `tracked_keyword`) is separate from what the
collector observes. The crawl unit is `crawl_pair` — the reference-counted union
of distinct (keyword, storefront, locale) triples — so two users tracking the
same keyword produce one fetch, not two.

A keyword is always tracked against a **(storefront, locale)** pair because
Apple cross-localizes: Canada indexes `en-CA` and `fr-CA`, Belgium `en-GB`, `nl`
and `fr`, Switzerland four locales. Which storefronts matter follows the app's
content language (`app_language`), not market size.

`app_localization` records "this app has no localization for this storefront's
indexed locale" as a first-class state, because that gap is itself an ASO
finding — an extra localization buys an extra keyword field.

`ranking` stores the full ordered list of up to 200 track ids as JSON plus
provenance; `rank_entry` indexes only the top 10 and any tracked app, because a
row per position would be 18× the write budget.

## R2 archive

```
rankings/v1/{yyyy-mm}/{storefront}/{date}.ndjson     permanent, the rebuild source
staging/rankings/{date}/{pairId}.json                pre-compaction (7-day lifecycle)
verbatim/{date}/…                                    failures + 1-in-10 sample (21-day lifecycle)
asc/{appId}/{report}/{granularity}/{date}-….tsv.gz   App Store Connect, as downloaded
ads/popularity/{week}/{storefront}/{genre}.json      Apple Ads, as fetched
charts/… lookups/… reviews/…                         as fetched
```

D1 holds a hot window; the archive holds everything. `scripts/rebuild-d1`
reconstructs the observation tables from R2 alone, which is what makes pruning,
retention and schema changes performance choices rather than lossy ones.

## Difficulty

Computed daily from observations already held — the rating mass of the top 3 and
top 10 on the result page, how much that page turns over, and how full it is,
all on a log scale. Every input is stored beside the score along with
`formula_version` and the sample size, so the weights can change and the whole
history be recomputed. Pages with no known rating counts are skipped, never
scored from nothing. Hovering the score shows what produced it; an asterisk
marks a score built from fewer than five known incumbents.

## Not built yet

The Tier-2 global market sweep (which will calibrate difficulty against
market-wide distributions rather than the current absolute scale), brand-versus-
generic keyword classification, iPad as a separate device dimension, hourly
granularity, and Google Play.

Explicitly out of scope: download and revenue estimation for other people's apps
(it needs panel data this does not have), team accounts and billing, and
anything with an LLM in it.
