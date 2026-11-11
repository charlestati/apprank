# Roadmap

Open work for AppRank. Done work leaves this file; git keeps it.

## Bug audit, 2026-11-11

Highest priority: everything a full audit found. `[fix]` items were traced to a
concrete failing input; `[investigate]` items need a live Apple response, a
device or production data before the fix is known. The order inside each group
is severity.

### Collection

Owner: [collector rules](.claude/rules/collector.md).

- [ ] [fix] Stop the runner's `wrangler dev` Durable Object from draining the
      queue and crawling on its own alarm beside `refresh.sh`. Confirmed on the
      2026-11-11 Collect run: four alarm-only `crawled pair N` lines in the
      wrangler log. It fetches past the script's fixed spacing and fetches the
      head task twice (invariant 4).
- [ ] [investigate] The same run's wrangler log holds 2,115
      `Error: internal error; reference = …` lines in 27 minutes. Find what
      throws them and whether each one costs an Apple fetch.
- [ ] [fix] Re-read pacing just before `onThrottle` and `onAdminThrottle` save
      it, and before the daily roll, so a step that loaded it seconds earlier
      cannot erase a new pause or the roll-over.
- [ ] [fix] Stop `maybeRaise` raising the rate 10% on a day with no evidence: a
      day with no loop fetch, or with only admin-path throttles, counts as clean
      today, so the rate climbs from 4 to 18 a minute in about 16 days.
- [ ] [fix] Drop the Monday-only gate on the Ads genre pull and discovery and
      let the per-unit week marker decide, so a failed Monday is retried on
      Tuesday instead of losing the week.
- [ ] [fix] Honour Apple Ads `Retry-After`: `retryAfterSeconds` has no reader,
      so a 429 unit burns five attempts at tick pace, is abandoned, and the next
      unit does the same.
- [ ] [fix] Have the lookup upsert fill `bundle_id`, developer and
      `primary_genre_id` on an existing `app` row. `pnpm track` always
      pre-creates the row, so a tracked app keeps a null genre (no genre charts,
      no Ads genre pull) until it shows up in a crawl.
- [ ] [investigate] An empty by-name popularity answer is stored as
      `present = 0` for every term and never asked again. Confirm how Apple
      answers a week it has not published yet before choosing the guard.
- [ ] [fix] Stop recording our own failed ASC download as Apple's
      `skipped_processing_date`: only flag a date Apple's instance list lacks.
- [ ] [fix] Give a pair with zero observations its new-pair boost (`obs.n < 7`
      is NULL without a `COALESCE`), and aggregate cadence volatility and latest
      position per app before per pair, so two apps sharing a keyword do not
      read as one volatile app.
- [ ] [fix] Count chart pulls in the cadence budget the way the daily fan-out
      builds them (every target storefront times tracked genres plus one).
- [ ] [investigate] Feed the runner's real ceiling (`MAX_UNITS`, fixed spacing)
      into cadence capacity instead of the learned rate it never uses.
- [ ] [fix] Class an unparseable 2xx body as `invalid_body`, not `http_error`,
      and record the response time and a truncated body on lookup, review and
      chart failures as the crawl does.
- [ ] [investigate] `instancesStep` and `ascDetectSkippedDates` run one D1 query
      per instance; check them against the per-invocation query cap with a real
      report list. Check also whether a replacement ASC request re-lists old
      dates as `duplicate_processing_date`.

### Tracking and scripts

- [ ] [fix] Make `pnpm track` warn about, or activate, a listed storefront with
      `active = 0`. Six storefronts are seeded inactive and the shipped example
      lists two of them: the crawl runs there while lookups, reviews, charts and
      both Ads passes silently skip it, and that history cannot be backfilled.
- [ ] [fix] Keep `pnpm track --prune` from retiring a pair the file still lists
      when its storefront has no `storefront_locale` row: an unresolved locale
      is not a removed storefront.
- [ ] [fix] Validate the tracked file up front: integer `appId` (a string
      re-emits three statements on every run), no empty keyword, inner
      whitespace collapsed, and a warning when two entries produce the same
      search URL.
- [ ] [fix] Make `rebuild.mjs --verify` compare the archive with D1 per date and
      exit non-zero on drift; today it prints two totals and exits 0.
- [ ] [fix] Give `rebuild-d1` a date range and stream its output to per-month
      files: it joins every statement into one string and throws near 124,000
      observations.
- [ ] [fix] Exit non-zero from `refresh.sh` when the port is held, instead of
      logging SKIP and reporting a successful cycle.
- [ ] [fix] Guard `pnpm relevance --apply` with `status = 'pending'` and reject
      a threshold outside 0 to 1; validate `--storefront` and `--days` in
      `rank-churn/measure.mjs`.
- [ ] [fix] Drop `DEFAULT ''` from `suggestion.user_id`, which the baseline SQL
      carries and the schema does not.

### Web

Owner: [web rules](.claude/rules/web.md).

- [ ] [fix] Give a keyword with no observation in the window its own outcome
      instead of "dormant: not ranking at all", in the verdict, the insight
      counts, the CSV, the MCP tools and the table cell. A throttled week reads
      as advice to drop the keyword today (invariant 3).
- [ ] [fix] Derive a tracked app's position from `ranking.result_ids` when
      `rank_entry` has no row for it: an app tracked after a pair already had
      history reads as outside the top 200 on every earlier day.
- [ ] [fix] Pass `get_keyword_report` an explicit start date. `daysIn` rounding
      stacks with `sinceDate`, so the window starts one or two days early, and a
      window older than 400 days comes back empty.
- [ ] [fix] Collapse `get_keyword_popularity` and the legacy keywords read to
      one row per keyword and week, with the preference `fetchPopularity` uses.
- [ ] [fix] Derive coverage `degraded` from the ratio and `isLoss()` classes
      only, and count missing days against the pair's cadence, as the web rules
      already promise.
- [ ] [fix] Base `unproven` on how long the current rank has been held; it can
      never be true on a pair checked every three days or more.
- [ ] [fix] Compare full boards in `get_chart_movement` and apply `limit` to the
      sorted moves only.
- [ ] [fix] Reject a non-numeric `appId` on `/pairs/:pairId/history` with 400.
- [ ] [fix] Charge the MCP burst limiter after the secret verifies, and limit
      before authentication by client address, so a known token id cannot be
      used to lock its holder out.
- [ ] [fix] Allow-list preference keys and cap rows per user.
- [ ] [investigate] Accepting a suggestion for a storefront already tracked
      under another locale can leave a pair nobody holds; an unreadable payload
      is marked accepted with nothing promoted.
- [ ] [investigate] Metadata markers diff across storefront variants of one
      release, since `app_metadata_version` has no storefront column.
- [ ] [fix] Remove the unused `ARCHIVE` and `APP_URL` bindings from the web
      Worker, or use them.
- [ ] Index `fetch_error` on `(params, fetched_at)` and `fetched_at`, compare
      raw millisecond bounds instead of `DATE()`, and decide a retention: three
      reads scan the whole table today and nothing prunes it.
- [ ] Index `review` on `app_id`.

### Dashboard

Owner: [dashboard rules](.claude/rules/dashboard.md).

- [ ] [fix] Show an empty or failed state when the storefront list is empty or
      fails, instead of "Loading…" for ever.
- [ ] [fix] Hold the app list as "not loaded yet" until it answers, so "No app
      is being tracked yet." stops flashing on every load and staying after a
      failed request; start the shell's requests in parallel.
- [ ] [fix] Give the pair, health, reviews and suggestions pages a "could not
      load" state: a failed request reads as "nothing collected yet" or loads
      for ever.
- [ ] [fix] Make the InfoTips and the difficulty footnote open on tap, and move
      the footnote trigger out of the `role="meter"` element.
- [ ] [fix] Read the health-badge acknowledgement back from the server
      preference, which is written but never applied.
- [ ] [fix] Show the day on the "Last daily job" tile and flag a run older than
      about 26 hours.
- [ ] [fix] Chart: land on the newest day on the first ArrowLeft; key metadata
      markers and error marks so two on one day do not collide; keep muted
      lone-dot series visible; clear the dimming when focus leaves the table.
- [ ] [fix] Say "no keyword selected" when every keyword is unticked, not "the
      collector fills this in daily".
- [ ] [fix] Give the "~" unproven mark and the "contested" arrow a reachable
      explanation, and keep toggle buttons' names constant beside
      `aria-pressed`.
- [ ] [fix] Localise the hard-coded English in the chart, delta, meter and
      health components, format their ISO dates for the locale, and route counts
      through `plural`.
- [ ] [fix] Define `--ds-weight-regular`; stop the Appfigures skin flattening
      the difficulty band colours, or delete the band classes.
- [ ] [fix] Fix the results drawer subtitle, the suggestions `busy` state, the
      unvalidated suggestion payload and the nullable `errorClass` type.
- [ ] [fix] Raise the Appfigures skin's light-scheme contrast: link 4.06:1,
      active navigation 3.45:1, input border 1.42:1, muted series 1.10:1.
- [ ] [investigate] Render at 390, 1000, 1280 and 1920 px in both skins: the
      table toolbar looks clipped at phone width, report headers look wider than
      their columns at laptop widths, and the chart tooltip has no edge clamp.
      None of this was seen rendered.
- [ ] [investigate] A late preferences answer can undo a choice just made, and
      preferences are refetched on every app or storefront change.

### Repository, CI and security

- [ ] [fix] Clear `pnpm audit`: 17 advisories, 16 with a patched release
      (`undici`, `zod`, `happy-dom` through the Vitest chain; `body-parser`,
      `qs`, `fast-uri` through `agents`). CI's first step fails on them.
- [ ] [fix] Put `packages/core` under the 80% coverage gate. The collector's
      include pattern matches nothing, so no core file is measured.
- [ ] [fix] Fail the collect job when the cycle was throttled or left pairs due,
      so a day with nothing collected is not a green run.
- [ ] [investigate] GitHub disables scheduled workflows on a public repository
      after 60 days without activity. Confirm, then add a keep-alive or a stale
      run alert.
- [ ] [investigate] The collect job runs `main` whether or not CI passed on it.
- [ ] [fix] Scope the Cloudflare secrets in `collect.yml` to the step that uses
      them and add `permissions: contents: read` to both workflows.
- [ ] [fix] Remove the tracked keyword quoted in
      `scripts/local-refresh/verify.sh`, and redact step responses and the
      wrangler log before they reach the public run log and artifact.
- [ ] [fix] Typecheck the Vitest and Vite configs and run `vite build` in CI.

### Tests

- [ ] [fix] `admin.test.ts` "verifies the ads credential without writing rows"
      passes because the key import fails first; test verify-only directly.
- [ ] [fix] Derive the route and tool ownership walkers from the registered
      routes and tools, and test scope denial for every tool.
- [ ] [fix] Assert the spacing between ticks, and archive-before-derive on the
      lookup, review, chart, Ads, ASC and compaction paths.
- [ ] [fix] Delete storage and alarm for every Durable Object a test touched.
- [ ] [fix] Smaller defects: the Monday-only "no ads pull" assertion, the
      verify-only archive assertion satisfied by an earlier test,
      `health.test.tsx` asserting before the failure, `run_worker_first`
      asserted truthy, `do_restarted` unpinned, spies restored after assertions,
      and four assertions that cannot fail.

### Documentation

- [ ] [fix] Tell the operator to set `COLLECTION_MODE=credentialed` in the
      deploy guide.
- [ ] [fix] Reconcile the throughput figures in `docs/limits.md`, `README.md`,
      `collect.yml` and `refresh.sh`.
- [ ] [fix] Small drift: the `ads/popularity-terms` key format and two missing
      prefixes in `docs/architecture.md`, the jitter comment in `pacing.ts`, the
      `mcp_credential` rebuild claim in `scripts/mcp-token/issue.mjs`, the
      `testing.md` glob and the "every strict flag" claim in `AGENTS.md`, the R2
      credentials `rebuild:d1` needs, and `/api/health` in `docs/access.md`.

## Repository

- [ ] Close Dependabot PRs #13 to #18 once the dependency refresh is on `main`;
      it ships every version they propose, or a newer one.
- [ ] Move to Node 26 once it enters LTS (scheduled for 2026-10-28): bump
      `.node-version`, `engines` and `@types/node`, then run `pnpm run ci`.
- [ ] Re-check GHSA-vfj7-8cjw-p6xm (`braces`, reached through `ultracite`) by
      2027-01-20, and drop its `audit.ignore` entry once a patched release or an
      `ultracite` without it exists.
- [ ] Drop the `@esbuild-kit/core-utils>esbuild` override once `drizzle-kit`
      stops depending on the deprecated `@esbuild-kit` loader.
- [ ] Generate each `wrangler.local.jsonc` from the committed template plus the
      real ids, as `scripts/local-refresh/write-config.mjs` does for CI, so a
      binding added to the template cannot silently miss the deploy (the MCP
      rate limit did).

## Collection

Owner: [architecture](docs/architecture.md).

- [ ] Download the ASC `ONE_TIME_SNAPSHOT` request `initStep` creates: keep its
      id and run it through the reports, instances and segments flow, or the
      history it exists to capture is never fetched.
- [ ] Check the collect job's worst case against its 210-minute timeout at the
      measured 2.56 units a minute: 500 crawls plus the step drain come to about
      212 minutes, and the daily fan-out runs last.
- [ ] Take difficulty's rating counts from `rating_snapshot` per storefront;
      `app_metadata_version` freezes them at the first storefront that saw that
      content.
- [ ] Treat a reviews feed whose `entry` is a single object as one review, and
      validate a lookup 200 that carries no `results` before booking it as
      `app_not_in_storefront`. Both need a live Apple response to confirm.

## Archive and rebuild

Owner: [architecture](docs/architecture.md).

- [ ] Teach `scripts/rebuild-d1` to rebuild metadata, reviews, ratings and
      charts from R2, so invariant 2 holds for every table and not only rankings
      and popularity.
- [ ] Archive the crawl's top results verbatim (gzipped) before deriving `app`
      and `app_metadata_version` from them, or derive those only from the
      archived lookups: one fetch in ten is sampled today, so crawl-sourced
      metadata cannot be rebuilt.
- [ ] Resolve rebuilt `ranking.pair_id` by keyword, storefront and locale rather
      than the archived id, and add the keyword's `language` to the staging line
      (with a `COLLECTOR_VERSION` bump), so a fresh or re-tracked D1 can take
      the rebuild.

## Web

Owner: [web rules](.claude/rules/web.md).

- [ ] Filter `pairResultPage` and the `newest_meta` CTE to the page's result ids
      through `json_each`, instead of reading every `app` and
      `app_metadata_version` row.
- [ ] Bound the ratings history query by the requested window in SQL.

## Tests

- [ ] Run the web API test files one at a time like the collector's, or prove
      their storage is isolated: they share D1 and empty tables in `beforeEach`.
- [ ] Restore the global fetch stub in `apps/collector/test/discover.test.ts`
      (`vi.unstubAllGlobals`), and inject one clock where tests compare today's
      date, so a run across UTC midnight cannot fail.
