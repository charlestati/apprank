# Roadmap

Open work for AppRank. Done work leaves this file; git keeps it.

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
- [ ] Stop the runner's `wrangler dev` Durable Object from draining the queue on
      its own alarm beside the step loop, after confirming that `wrangler dev`
      fires alarms: it would fetch faster than the step spacing and feed the
      shared throttle tally.
- [ ] Keep a manual `stepNow` and the alarm from fetching the same head task
      twice; settling by id stops duplicate follow-ups, not the duplicate fetch.
- [ ] Re-read pacing just before `onThrottle` and `onAdminThrottle` save it, so
      a step that loaded it seconds earlier cannot erase a new pause or
      roll-over.
- [ ] Count chart pulls in the cadence budget the way the daily fan-out builds
      them (every target storefront times tracked genres plus one), and feed the
      runner's real ceiling (`MAX_UNITS`, fixed spacing) into capacity instead
      of the learned rate it never uses.
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

- [ ] Index `fetch_error` on `(params, fetched_at)` and `fetched_at`, compare
      raw millisecond bounds instead of `DATE()`, and decide a retention: three
      reads scan the whole table today and nothing prunes it.
- [ ] Filter `pairResultPage` and the `newest_meta` CTE to the page's result ids
      through `json_each`, instead of reading every `app` and
      `app_metadata_version` row.
- [ ] Bound the ratings history query by the requested window in SQL.
- [ ] Read the health-badge acknowledgement back from the server preference,
      which is written but never applied.
- [ ] Localise the hard-coded English in the chart, delta, meter and health
      components, and format their ISO dates for the locale.
- [ ] Move the difficulty tooltip trigger out of the `role="meter"` element,
      whose children are presentational.

## Tests

- [ ] Run the web API test files one at a time like the collector's, or prove
      their storage is isolated: they share D1 and empty tables in `beforeEach`.
- [ ] Restore the global fetch stub in `apps/collector/test/discover.test.ts`
      (`vi.unstubAllGlobals`), and inject one clock where tests compare today's
      date, so a run across UTC midnight cannot fail.
