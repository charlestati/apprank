# Roadmap

Open work for AppRank. Done work leaves this file; git keeps it.

## Bug audit, 2026-11-11: what is left

Highest priority. The audit's findings that were traced to a failing input are
fixed; these are the ones that need a live Apple response, a device or
production data before the fix is known, and the few that were deliberately
left.

### Collection

Owner: [collector rules](.claude/rules/collector.md).

- [ ] [investigate] An empty by-name popularity answer is stored as
      `present = 0` for every term and never asked again. Confirm how Apple
      answers a week it has not published yet before choosing the guard.
- [ ] [investigate] Feed the runner's real ceiling (`MAX_UNITS`, fixed spacing)
      into cadence capacity instead of the learned rate it never uses.
- [ ] [investigate] `instancesStep` and `ascDetectSkippedDates` run one D1 query
      per instance; check them against the per-invocation query cap with a real
      report list. Check also whether a replacement ASC request re-lists old
      dates as `duplicate_processing_date`.
- [ ] [investigate] Confirm the `internal error; reference = …` lines the
      runner's wrangler log fills with (2,115 in the 2026-11-11 run) come from
      the remote bindings alone, as `refresh.sh` assumes, and cost no fetch.
- [ ] Delete the false `skipped_processing_date` rows recorded before the gap
      check read Apple's own listing; the fix does not retract them.
- [ ] Keep a manual `crawlNow` and an alarm crawl from picking the same due
      pair, and say so in the answer when a manual step finds an Apple Ads task
      waiting out a refusal instead of answering a bare `ok`.

### Tracking and scripts

- [ ] Drop `DEFAULT ''` from `suggestion.user_id`, which the baseline SQL
      carries and the schema does not. It needs a table rebuild on production
      data, so it was left.
- [ ] Decide whether keywords collapse repeated inner spaces. The collector, the
      dashboard and the planner all normalise without it, so `pnpm track` only
      warns; changing one alone would mint second keyword rows.
- [ ] Test `rebuild.mjs` beyond its pure helpers, and run `--verify` against
      production once.

### Web

Owner: [web rules](.claude/rules/web.md).

- [ ] [investigate] Accepting a suggestion for a storefront already tracked
      under another locale can leave a pair nobody holds; an unreadable payload
      is marked accepted with nothing promoted.
- [ ] [investigate] Metadata markers diff across storefront variants of one
      release, since `app_metadata_version` has no storefront column.
- [ ] Index `fetch_error` on `(params, fetched_at)` and `fetched_at`, compare
      raw millisecond bounds instead of `DATE()`, and decide a retention: three
      reads scan the whole table today and nothing prunes it.
- [ ] Index `review` on `app_id`.

### Dashboard

Owner: [dashboard rules](.claude/rules/dashboard.md).

- [ ] [investigate] Render at 1000, 1280 and 1920 px, in both skins and the
      light scheme. The audit's fixes were seen only at 377 px in the dark
      scheme: the new contrast tokens, the report headers that looked wider than
      their columns, the chart tooltip clamp and the French "sans donnée" cell
      are unseen.
- [ ] [investigate] At 377 px the page still scrolls about 220 px sideways
      although no element outside the table's own scroller crosses the edge.
      Find what widens the document.

### Repository and CI

- [ ] Add a keep-alive or a stale-run alert for the collect workflow: GitHub
      disables scheduled workflows in a public repository after 60 days without
      activity (documented in the deploy guide, not yet guarded).
- [ ] [investigate] The collect job runs `main` whether or not CI passed on it.
- [ ] Drop each transitive `overrides` entry in `pnpm-workspace.yaml` (`undici`,
      `zod`, `happy-dom`, `body-parser`, `qs`, `fast-uri`) once its parent ships
      the patched version, and re-check GHSA-gcqx-w48m-w2h4 (`deepmerge`,
      through `ultracite`) by 2027-01-20.
- [ ] Decide whether to rewrite history for the tracked keyword that commit
      `1deb689` put in `scripts/local-refresh/verify.sh`; the working tree is
      clean, the history is not.

### Tests

- [ ] `apps/collector/test/admin.test.ts` still leaves the `singleton` Durable
      Object's alarm armed after its last test.

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
