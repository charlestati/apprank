---
paths:
  - "packages/core/src/apple/**"
  - "apps/collector/src/tasks/**"
---

# Apple's APIs

- The public iTunes Search API rate-limits by IP and Cloudflare's egress is
  shared, so 429s arrive at volumes far below the documented ~20/min. The body
  reads `Rate limit has been exceeded for: itunes-apple-com|general|<ip>`. This
  is expected; the answer is patience, not parallelism.
- Apple Ads popularity is **weekly** (`WEEKLY_SUN_SAT`) and posted about a week
  late. Absence is "no data", not "low popularity", hence `popularity.present`.
- **Popularity is collected in two passes, and neither can reach a long-tail
  term.**
  1. `ads_pull` asks `insights/apps/search-term-popularity` for the ranked top
     500 of a storefront × top-level category. Apple's own description is that
     it returns the most popular terms for a genre and country, for campaign
     setup: it is a discovery feed for `seed_term`, not a lookup. The floor is
     wherever rank 500 lands, popularity 51 for FR/GAMES in August 2026, and a
     tracked keyword appears in it by luck (3 of 129, measured).
  2. `ads_terms` filters the same endpoint on `searchTerm IN [...]` with **no
     genre filter**, which is the only way to see a term Apple attributes to
     another category: one app's own brand term comes back under
     PRODUCTIVITY_UTILITIES at 53, and a GAMES-scoped query can never return it.
     It still cannot reach past rank 500, because that is the whole corpus this
     endpoint serves.
- **`suggestions/keywords/query` does not return Search Popularity, and was
  tried.** The endpoint exists, is scoped to a promoted app through
  `promotedObjectId`, accepts one seed term at a time, and answers for terms far
  below the insights floor, so it looks exactly like the missing lookup. Its
  `popularity` is a different quantity: relevance to _that app_, not search
  volume. Measured on the same storefront and week, from each term's own seeded
  request:

  | term                  | insights `searchPopularity1to100` | suggestions `popularity` | Appfigures |
  | --------------------- | --------------------------------- | ------------------------ | ---------- |
  | competitor brand A    | 64                                | 7                        | 64         |
  | competitor brand B    | 54                                | 8                        | 52         |
  | generic category term | 59                                | 51                       | 57         |
  | the app's own brand   | 53                                | 62                       | 54         |

  The app's own brand term scores _higher_ on suggestions than a head term with
  ten times the volume, which is the tell. Appfigures tracks the insights
  column, not this one. Writing it into `popularity` silently replaced a real
  measurement with an unrelated score, which is exactly the failure invariant 3
  exists to prevent. Do not reach for it again for volume; it is a keyword
  _discovery_ signal and would need its own table and its own name.

- **Where Appfigures' sub-51 numbers come from is still unknown, and the
  Campaign Management API is not it.** Probed against this account, which holds
  a live campaign and ad group, so the surface is reachable: `v5/campaigns` and
  `v5/campaigns/{id}/adgroups` answer 200, `v5/keywords/searchpopularity` and
  `v5/keywords/recommendations` answer the API's own JSON `RESOURCE_NOT_FOUND`,
  and every `v5/keyword/*` path returns an HTML 503 from Apple's edge, meaning
  it never reaches the API at all. The two error shapes are the useful
  distinction: JSON means the request arrived and the route does not exist, HTML
  means no such route was ever published. So there is no arbitrary keyword
  popularity endpoint on either API, and the remaining explanations are that
  Appfigures models the long tail or buys it.
- **A backfill is possible, and it is the only one in this repository.** Apple's
  filterable-fields table takes `week` with `IN`, and history reaches back at
  least to 2026-05-31 (measured; the pull simply stopped there because thirteen
  weeks is the default). `POST /admin/run?job=ads_backfill` queues the by-name
  pass for every tracked keyword a recent week holds no answer for, bounded by
  `ads:backfill_weeks`. Only the by-name pass: replaying the genre pull would
  rewrite 500 `seed_term` rows a unit a week to re-derive a discovery list
  nobody is waiting for.
- **The 500-term ceiling is Apple's, not our page size.** Asking for
  `pageSize: 1000` comes back with `pageSize: 500`, 500 rows, and the last at
  `rankInGenre` 500. Worth having settled: every pull before the probe asked for
  500 and received 500, which looks identical to our own limit binding.
- **A 200 is an answer even when it spent the window.** Apple puts
  `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every
  response. Treating `remaining = 0` on a 200 like a 429 threw away a body that
  had already cost quota, before it was archived, and the retry paid again, so
  only a real 429 is a refusal. There, `Retry-After` wins over
  `RateLimit-Reset`: Apple documents it as the exact wait for the request it
  just rejected. A rate-limited Ads task is requeued at most five times, then
  recorded as `pull_abandoned`, because an uncapped requeue cycled on every tick
  while the health page counted it as harmless back-pressure.
- Apple's own Node SDK does not run on workerd (`fs` + axios). The hand-rolled
  clients in `packages/core/src/apple` are deliberate.
- App Store Connect `ONGOING` report requests die if not polled
  (`stoppedDueToInactivity`), and Apple sometimes publishes a duplicate
  `processingDate` then skips the next day permanently. Both are detected and
  recorded; do not treat either as normal.
- **ASC bookkeeping is per app, and that column is load-bearing.** Report
  requests are created per app, so `asc_report_instance.app_id` is known at
  write time, and it must be stored. Without it both anomaly detectors answer
  for the union of tracked apps: one app's published day satisfies another app's
  `NOT EXISTS` gap check, and a second app's legitimate report is flagged as the
  first app's `duplicate_date`. There is also no column for `ownsApp` to check,
  so first-party analytics has no owner. The archive key carries the app for the
  same reason: the dimension has to exist in R2 or it cannot be rebuilt into D1.
- **ASC carries no per-search-term report.** Verified against the live report
  list (156 reports for one app, archived at
  `asc/{appId}/report-list-{requestId}.json`): 103 `FRAMEWORK_USAGE`, 23
  `PERFORMANCE`, 15 `APP_USAGE`, 10 `COMMERCE`, and only 5
  `APP_STORE_ENGAGEMENT`: Discovery and Engagement (Standard/Detailed), Web
  Preview Engagement (Standard/Detailed), Retention Messaging. Search appears as
  a _source type_, never as a term. So popularity↔traffic calibration is capped
  at source-type level; do not plan a feature that assumes term-level
  impressions.
- **Apple Ads popularity is per top-level category, not per sub-genre.** The
  endpoint's own allowed values are exactly fifteen:
  `BUSINESS EDUCATION ENTERTAINMENT FINANCE FOOD_DRINK GAMES HEALTH_FITNESS LIFESTYLE NEW_PUBLICATION PHOTO_VIDEO PRODUCTIVITY_UTILITIES SHOPPING SOCIAL_NETWORKING SPORTS TRAVEL`.
  Word, Puzzle, Board, Trivia and Educational all collapse to `GAMES` and return
  one identical list, so `lib/ads-genres.ts` lifts each tracked genre to its
  parent and dedupes the queue; without that, five tracked sub-genres fetch one
  identical list five times per storefront. Popularity is stored against the
  parent genre id (Games = 6014); recording a GAMES-wide ranking under
  "Games/Word" would claim precision Apple does not provide.
- **The genres worked in are the tracked apps' own, never a constant.** Both the
  Ads pull and the chart pull derive from the distinct `app.primary_genre_id` of
  tracked apps (`trackedGenreIds` in `index.ts`), overridable per deployment
  through the `ads:focus_genres` and `chart_genres` `collector_state` keys. A
  hardcoded list is wrong for every operator outside that category, and it was
  hardcoded to five Games sub-genres once. Empty is a real answer: a fresh
  deploy has looked nothing up yet, and under `COLLECTION_MODE=credentialed`
  that lookup runs from the Actions runner, so the column stays null for a
  while. The Ads pull is then skipped and only the storefront-wide chart
  (`genreId: null`) runs, because guessing a category would write popularity for
  terms nobody tracks.
- **The genre table has to cover every category, or the derivation dead-ends.**
  `buildAdsTask` resolves `primary_genre_id` through a `SELECT ... FROM genre`,
  so an unseeded genre yields no rows, no Ads category, and a popularity table
  that is silently empty rather than visibly unsupported. `reference.sql` seeds
  the tree from Apple's live genre endpoint
  (`MZStoreServices .../ws/genres?id=36`): all 27 top-level genres and the 18
  Games children. Only Games, Magazines & Newspapers (28) and Stickers (15) have
  children at all. Eleven top-level genres map to no Ads category at all
  (Weather, Reference, Navigation, Music, Books, Medical, Magazines, Catalogs,
  Stickers, Developer Tools, Graphics & Design), because Ads reports fifteen and
  the App Store has twenty-seven; `resolveAdsCategory` returns null there, which
  is recorded rather than guessed.
- **Genre ids are worth checking against Apple, not against memory.** 7003 is
  Games/Casual; the seed called it Games/Card, which is 7005, for as long as
  nobody charted it. Ads never noticed because everything lifts to the parent,
  but `chart_pull` takes a genre id directly, so the mislabel would have
  collected Casual under the name Card.
- The Platform API request body is
  `{ timeRange: { start, end, granularity }, filters: [{ field, operator, value }], sorting, pagination }`.
  The older Campaign Management
  `{ granularity, selector: { conditions, orderBy } }` envelope earns
  `REQUEST_UNRECOGNIZED_PROPERTY`. The response is `{ result: { rows } }`, not
  `{ data }`.
- The Ads pull is **weekly data, so it is gated on the week already held**
  (`ads:pulled:{storefront}:{category}` in `collector_state`); without the gate
  a repeat pull rewrites 500 seed terms plus every popularity row per unit, and
  re-pulls are common because the manual trigger is how a credential gets
  verified. The manual path passes `force`, so a credential check still makes a
  real request rather than silently skipping one.
- **Three rules keep the crawl affordable.** (1) `pickDuePair` will not return a
  pair that already has a `ranking` row for today: the table is unique on
  `(pair_id, observed_date)`, so a same-day re-crawl overwrites its own row for
  ~30 writes and no new history. Without it, anything moving `next_due_at`
  backwards, a reseed or a manual re-run, re-crawls the whole set. (2) The `app`
  upsert carries a `WHERE`, because `last_seen_at = now` always differs and
  would make every top-10 app on every pair a guaranteed daily write for a
  column nothing reads. (3) `rank_entry` is rewritten only when the indexed page
  moved; a board holding its order otherwise costs a delete plus eleven inserts
  to arrive at the same rows.
- Two write paths are knowingly left unconditional. The **heartbeat**
  (`collector_state.loop_heartbeat`) writes once per alarm tick, about 150/day,
  but its whole value is that its timestamp always changes, so throttling it
  would trade observability for a rounding error. `applyIntervals` rewrites
  `interval_hours` for every active pair daily (~125/day) because guarding it
  would mean duplicating a non-trivial `CASE` into the `WHERE`, and two copies
  of that expression drifting apart is a worse bug than the writes it saves.
- **D1 writes are the scarcest Cloudflare resource, though the collection window
  binds first.** The free tier allows 100k row-writes a day. Measured on a cold
  pass, 50 pairs cost 1,057 rows: 50 `ranking`, 512 `rank_entry`, 225 `app`, 270
  `app_metadata_version`, so ~21 a pair with every app and metadata row new, and
  far less once those stop changing. That puts the write ceiling near 4,700
  crawls a day, well past what one 45-minute Actions run can fetch (~100 pairs
  at the observed 2.6 units/min). Guard writes anyway: the guards are what keep
  steady state near 1 row a pair instead of 21, and `docs/limits.md` carries the
  arithmetic. Whether a skipped write is free depends on the table, and it is
  worth knowing which: measured against remote D1, a conflicting upsert whose
  `WHERE` skips costs **0** rows-written on a natural-key table (`storefront`)
  and **1** on an `AUTOINCREMENT` one (`seed_term`, `keyword`,
  `app_metadata_version`), because SQLite touches `sqlite_sequence` regardless.
  A conflicting `INSERT OR IGNORE` behaves the same way. So on autoincrement
  tables the guard has to be a _read_ before the statement, not a `WHERE` inside
  it. `crawl.ts` reads the stored content hashes once per pair rather than
  attempting eleven ignored inserts, and `pulls.ts` reuses the lookup the
  metadata-burst check was already doing. Before re-running anything in bulk,
  check what is already due:
  `SELECT SUM(next_due_at <= strftime('%s','now')*1000) FROM crawl_pair WHERE ref_count > 0`.
- `job=ads` verifies by default and writes nothing: it fetches, archives to R2,
  and stops. `?write=1` opts into the full pull. The archive already proves the
  JWT signed, Apple answered and the shape parsed, which is everything a
  credential check asks; the full pull would spend ~500 writes per unit to learn
  it again.
- **Sub-genre ids in `seed_term`/`popularity` are always a bug.** Only the
  parent genre id (Games = 6014) is ever correct for a genre-pull row, because
  that is the granularity Apple reports at. If sub-genre ids appear, something
  is writing `unit.genreId` from the tracked genre rather than the resolved
  parent, and the rows will hold one storefront-wide list duplicated under
  several labels.
- **`popularity.genre_id = 0` (`STOREFRONT_WIDE_GENRE_ID`) is the by-name pass,
  not a missing value.** Apple publishes popularity per country; a genre only
  ever scopes a _ranking_ within it, so a row fetched by search term has no
  genre and carries no `rank_in_genre`. Storing it under 6014 would label a
  storefront-wide number "Games popularity" and make the column incomparable
  between two keywords. A keyword can therefore hold two rows for one week;
  readers prefer the sentinel, which is why `fetchPopularity` orders rather than
  grouping bare columns.
- Coverage is thin at the long tail of the _genre_ list, and this is the normal
  case, not an error: only a small minority of tracked terms appear in Apple's
  top-500 list for their parent genre at all, and those that do sit in the 60s
  on the 1–100 scale. That is why the by-name pass exists. Any code that reads
  popularity must keep three states apart: measured, asked-and-absent
  (`present = 0`), and never asked (no row). The report exposes all three as
  `popularityStatus`, and the page words the last two differently on purpose:
  collapsing them reported our own coverage gap as Apple's answer. (Terms
  themselves stay out of this file: the repository is public and the tracked set
  is the operator's ASO strategy.)
- Apple Ads discovery goes through `GET /v1/acls`, not `/v1/ad-accounts`: it is
  one of only two endpoints that work without the `X-AP-Context` header, and it
  returns the granted roles beside each account. `/v1/ad-accounts` answers
  `404 RESOURCE_NOT_FOUND` when the user holds no grant, which is
  indistinguishable from a wrong URL. An empty `acls` array means valid
  credentials with no ad-account grant, which is a user-management problem
  rather than a key problem.
- The `marketingtools` chart API has no top-grossing and no genre filter; the
  legacy `itunes.apple.com/{cc}/rss/top*applications` feeds are the only source
  for those and are undocumented, so provenance records which endpoint served
  each observation.
