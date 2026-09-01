# AppRank

Self-hosted App Store Optimization tracking on Cloudflare Workers. Collects keyword ranks, Apple Ads search popularity, metadata changes, ratings and reviews for the iOS apps you track — free-tier first, with an R2 archive as the source of truth and D1 as a rebuildable materialised view.

Design principles that shape everything here:

- **History cannot be backfilled**, so the collector ships before the UI and runs gap-free from day one.
- **Visible gaps beat silent garbage.** Every observation carries provenance (HTTP status, response time, result count, collector version, archive key); Apple's 403-with-empty-results rate limit is recorded as an error, never stored as "not ranking".
- **Politeness is a correctness requirement.** All Workers egress shares Cloudflare IPs and Apple rate-limits by IP, so the crawler discovers its own sustainable rate and backs off hard.
- **Reference data is rows, not code.** Adding a storefront, locale, genre or keyword is an `INSERT`, never a migration or a redeploy.

## Apple blocks Cloudflare, so collection runs from GitHub Actions

The one thing to know before deploying this. Apple rate-limits the public iTunes endpoints per IP, and every Cloudflare Worker egresses from a shared pool that is already spent: the deployed collector gets HTTP 429 on **every** keyword search, while the identical request from an ordinary connection succeeds. That is not a volume problem — it happens at one request per minute.

So the fetching runs somewhere else, and `.github/workflows/collect.yml` is that somewhere. It starts `wrangler dev` on a runner with `remote: true` bindings, which means the **same collector code** executes against the same D1 and R2 — only the source address differs. Observations carry the same normaliser, the same provenance and the same idempotent keys as the scheduler's own.

Cloudflare still runs App Store Connect and Apple Ads, which are credentialed, reached over different infrastructure, and work fine from a Worker. The deployment sets `COLLECTION_MODE=credentialed` so it stops attempting the fetches it cannot complete — those 429s were not free, each one fed the daily tally that halves the learned crawl rate.

`scripts/local-refresh` runs the same cycle from your own machine, which is useful for backfilling a day or verifying a credential.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Drizzle schema + migrations, SQL seeds, Apple clients (WebCrypto ES256 JWT for Ads and App Store Connect), iTunes normalisers |
| `apps/collector` | The crawler. Two crons drive one `SchedulerDO` work loop |
| `apps/web` | Hono JSON API + React SPA on Workers Static Assets |
| `scripts/rebuild-d1` | Rebuild or verify D1 observations from the R2 archive |

The collector runs one bounded unit of work per Durable Object alarm tick — one API task, or one keyword crawl — at an adaptive learned rate. Two brakes, deliberately separate: any 403/429 **pauses** the loop with exponential backoff (30m to a 4h cap), while the **rate** is a per-day trend — it starts at 4/min, halves once on the throttle that takes a day past tolerance, and recovers 10% per day that stayed within it (floor 1/min, ceiling 6/min). Halving on every hit made the rate a one-way ratchet to the floor on a shared egress IP, which silently shrinks the crawl budget. A 10-minute watchdog cron re-arms the alarm; a 03:00 UTC cron queues the daily jobs (archive compaction, App Store Connect poll, Monday Apple Ads pull, per-app lookups, reviews and charts).

Crawl cadence adapts to the tracked set. Each day the collector works out how many fetches the learned rate affords, subtracts what the app-level pulls cost, and re-spaces every tracked pair across a `1 / 2 / 3 / 7`-day ladder so the total fits. Pairs are ordered by keyword popularity, how close the app sits to the top-10 boundary, how much the rank has been moving, storefront weight, and whether the app's metadata changed recently. Adding apps or keywords costs resolution on the least informative pairs — never coverage, because a dropped pair loses its history for good. The current plan appears on the data-health page ("340 pairs every 1d, 260 every 2d").

## Getting started

Requirements: Node 24+, pnpm 11+, a Cloudflare account, `wrangler login`.

```sh
pnpm install

# 1. Create your own Cloudflare resources
npx wrangler d1 create apprank
npx wrangler r2 bucket create apprank-archive
npx wrangler r2 bucket lifecycle add apprank-archive expire-verbatim "verbatim/" --expire-days 21
npx wrangler r2 bucket lifecycle add apprank-archive expire-staging "staging/" --expire-days 7

# 2. Point the deployment at them. wrangler.local.jsonc is gitignored and wins
#    over the committed placeholder config in every script.
cp apps/collector/wrangler.jsonc apps/collector/wrangler.local.jsonc
cp apps/web/wrangler.jsonc apps/web/wrangler.local.jsonc
#    …then paste your database_id into both, and set APP_URL in the web config.

# 3. Schema + reference data (storefronts, locales, cross-localization, genres)
pnpm migrate:remote
pnpm seed:remote

# 4. Tell it what to track
cp tracked.example.json tracked.local.json
#    …edit it: app id, language, storefronts, keywords.
pnpm track            # shows what would change, writes nothing
pnpm track --apply

# 5. Deploy
pnpm deploy
```

`tracked.local.json` is gitignored, so your app ids and keyword lists stay out of the repository. `pnpm track` is idempotent and diff-first: re-running it reports "already in sync" and writes nothing, and removing a keyword **retires** its crawl pairs rather than deleting them, because a deleted day and an uncollected day are the same loss.

Then add the GitHub Actions secrets so collection can run: `CLOUDFLARE_API_TOKEN` (needs Workers Scripts Edit as well as D1 and R2 — remote bindings provision a proxy Worker), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and `ADMIN_TOKEN` (any high-entropy string, also set via `wrangler secret put` on the collector).

## Commands

```sh
pnpm lint          # ultracite (oxlint + oxfmt) across the workspace
pnpm lint:fix      # autofix and format
pnpm typecheck     # tsc across every workspace
pnpm test          # vitest (Workers runtime via @cloudflare/vitest-pool-workers)
pnpm coverage      # tests with istanbul coverage thresholds
pnpm generate      # drizzle-kit generate after a schema change
pnpm migrate:local # apply migrations to the local D1 copy
pnpm deploy        # deploy collector + web
```

Coverage thresholds are enforced per workspace: 80% statements/lines/functions, 70% branches.

## Credentials

Nothing personal lives in the repository. Every credential is a Worker secret, and the apps to collect for come from the `tracked_app` table rather than configuration.

Collector (`cd apps/collector && npx wrangler secret put <NAME> -c wrangler.local.jsonc`):

| Secret | Where it comes from |
| --- | --- |
| `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY` | App Store Connect → Users and Access → Integrations → App Store Connect API (`.p8` file contents for the key) |
| `ADS_CLIENT_ID`, `ADS_TEAM_ID`, `ADS_KEY_ID`, `ADS_PRIVATE_KEY` | Apple Ads → Account Settings → API: upload your public key, then copy the client/team/key ids |

The daily job skips the Apple APIs quietly until these exist. Setting them is what starts official-API ingestion — a `ONE_TIME_SNAPSHOT` fires on the first poll to capture all available history, so do it early: App Store Connect only retains a limited window.

Web (`cd apps/web && npx wrangler secret put <NAME> -c wrangler.local.jsonc`):

| Secret | Where it comes from |
| --- | --- |
| `BASIC_AUTH_ACCOUNTS` | You. A JSON array of accounts — see [Who can see what](#who-can-see-what) below. Without it the Worker serves nothing at all |

The seed template creates its rows under the user id `admin`. If your account uses a different `userId`, hand those rows over:

```sql
UPDATE tracked_app     SET user_id = '<your-user-id>' WHERE user_id = 'admin';
UPDATE tracked_keyword SET user_id = '<your-user-id>' WHERE user_id = 'admin';
```

## Who can see what

The Worker gates the whole origin with HTTP Basic. An unauthenticated visitor gets a 401 and a browser credential prompt — not the page, not the API. With no accounts configured it serves nothing at all (503), so a fresh deployment is never accidentally public.

Accounts live in one secret, as JSON:

```sh
cd apps/web
npx wrangler secret put BASIC_AUTH_ACCOUNTS
# [
#   { "username": "you",       "password": "…", "userId": "admin" },
#   { "username": "colleague", "password": "…", "userId": "colleague" }
# ]
```

Generate passwords with `openssl rand -base64 24`. `userId` is what ties an account to its data (`tracked_app.user_id`); leave it out and it defaults to the username. Set it to `admin` to inherit rows created by the seed template.

Ownership is a second, separate check: a request for an app or keyword you do not track answers 404, not 403, because a 403 would confirm that the id exists. Crawled observations are deliberately shared — two operators tracking one keyword produce one fetch — so ownership gates access to a pair's data rather than the data itself. First-party App Store Connect analytics is the exception: it is scoped per app and answers only for apps you track.

Two known limits of Basic auth, both deliberate trades: there is no sign-out short of closing the browser, and rotating a password means updating the secret. In exchange the Worker is 84 KiB instead of 1.9 MB, with no session tables to maintain. If you want real sign-out, single sign-on, or self-service accounts, put Cloudflare Access in front of the Worker route — the `userId` plumbing stays exactly as it is.

## Querying it from Claude Code (MCP)

The same data the dashboard shows is available to Claude Code over MCP, at `/mcp` on the same Worker — streamable HTTP, no separate deployment.

It is never anonymous. The endpoint has its own credential type, stored in the `mcp_credential` table and checked before any tool code is constructed. A credential is scoped to MCP alone: it will not open the web API, and a browser account will not open MCP.

Issue one — the token is printed once and only its SHA-256 is stored:

```sh
node scripts/mcp-token/issue.mjs --user admin --name charles-laptop
# prints the token, the INSERT to apply, and the claude mcp add line
```

`--user` is the durable `userId`, the same value as in `BASIC_AUTH_ACCOUNTS` and `tracked_app.user_id` — not the username. `--name` is how you tell two credentials apart later. Optional flags: `--days 365`, `--scopes read:all` (or a comma-separated subset: `read:rankings`, `read:popularity`, `read:metadata`, `read:charts`, `read:reviews`, `read:ratings`, `read:health`).

Connect it, at user scope — never a committed `.mcp.json`, since this repository is public:

```sh
claude mcp add --scope user --transport http apprank \
  https://<your-app-url>/mcp \
  --header "Authorization: Bearer apprank_mcp_..."
```

Revoke or rotate, effective on the next call:

```sh
npx wrangler d1 execute apprank --remote -c wrangler.local.jsonc --command \
  "UPDATE mcp_credential SET revoked_at = unixepoch() * 1000 WHERE name = 'charles-laptop'"
```

Rotation is a revoke plus a fresh issue under the same `--user`. `last_used_at` and `call_count` on each row are there so a credential you have forgotten about is findable, and every tool call is recorded in `mcp_tool_call` with the principal, the tool, its parameters, the row count and the duration.

Fourteen tools, all read-only and all intent-shaped — there is deliberately no `run_sql` or any other passthrough:

| Tool | Answers |
| --- | --- |
| `whoami` | What this credential is allowed to do. Needs no scope |
| `list_tracked_apps` | The apps and storefronts this credential can read |
| `get_keyword_report` | The whole keyword-performance report for one app and storefront |
| `get_rank_history` | Rank over a date range for one keyword |
| `get_current_rankings` | Latest rank across every tracked pair, with staleness |
| `get_competitors` | Who holds a keyword's top ten, and how it turned over |
| `get_chart_movement` | Top-chart climbers, fallers, entries and exits |
| `get_keyword_popularity` | Apple Ads search volume over time, absence included |
| `get_metadata_changes` | Releases and localization gaps, as rank-chart anchors |
| `find_keyword_opportunities` | Keywords worth acting on, by lane and thresholds |
| `get_search_results` | The full ordered result page for one observation |
| `get_reviews` | Recent reviews, filtered by storefront and rating |
| `get_ratings_history` | Rating count and average over time |
| `get_collection_health` | Whether today's numbers can be trusted |

Two behaviours matter more than the list:

**Every response describes its own holes.** Answers carry observation counts, actual date coverage, gap ranges and the error periods behind them. Apple's throttle returns HTTP 403 with an empty result array, so a rate-limited week looks exactly like a ranking collapse unless the answer says otherwise — and it does, in prose, in the body. Coverage is measured against each pair's own crawl cadence, so a keyword on a stretched seven-day rung is not reported as missing six days out of seven.

**Aggregates by default.** Series come back summarised — min, max, mean, median, inflection points and an evenly-sampled curve — with `detail` to opt into raw observations. Every tool caps its rows and tells you when it truncated.

Two limits are enforced per credential and independently of anything user-facing: a burst limit of 30 calls a minute, and a daily budget of 2,000 tool calls. A runaway agent exhausts its own allowance rather than the database's.

## Data model in one paragraph

User intent (`tracked_app`, `tracked_keyword`) is separate from what the collector observes. The crawl unit is `crawl_pair` — the reference-counted union of distinct (keyword, storefront, locale) triples — so two users tracking the same keyword produce one fetch, not two. A keyword is always tracked against a **(storefront, locale)** pair because Apple cross-localizes: Canada indexes `en-CA` and `fr-CA`, Belgium `en-GB`, `nl` and `fr`, Switzerland four locales. Which storefronts matter follows the app's content language (`app_language`), not market size. `app_localization` records "this app has no localization for this storefront's indexed locale" as a first-class state, because that gap is itself an ASO finding — an extra localization buys an extra keyword field.

## R2 archive layout

```
rankings/v1/{yyyy-mm}/{storefront}/{date}.ndjson   permanent, the rebuild source
staging/rankings/{date}/{pairId}.json              pre-compaction (7-day lifecycle)
verbatim/{date}/…                                  failures + 1-in-10 sample (21-day lifecycle)
asc/{appId}/{report}/{granularity}/{date}-….tsv.gz   App Store Connect, as downloaded
ads/popularity/{week}/{storefront}/{genre}.json    Apple Ads, as fetched
charts/… lookups/… reviews/…                       as fetched
```

D1 holds a hot window; the archive holds everything. `scripts/rebuild-d1` reconstructs the observation tables from R2 alone, which is what makes pruning, retention and schema changes performance choices rather than lossy ones.

## Status

Working: the collector (keyword ranks, metadata, ratings, reviews, charts, App Store Connect and Apple Ads ingestion), the JSON API, and the dashboard SPA (keyword grid, rank history, competitors, reviews, data health).

Read the Apple-blocks-Cloudflare section above before deploying: the keyword crawl, metadata lookups, reviews and charts only work from a runner or your own machine. Deploy the Workers and you get a dashboard, App Store Connect and Apple Ads — and 429s on everything else until the GitHub workflow is wired up.

Keyword difficulty is computed daily from observations already held — the rating mass of the incumbents on the result page, how much that page turns over, and how full it is — with every input stored beside the score so the formula can be revised and the history recomputed. Hovering the score shows what produced it; an asterisk marks a score built from fewer than five known incumbents.

Not built yet: the Tier-2 global market sweep (which will calibrate difficulty against market-wide distributions rather than the current absolute scale), iPad as a separate device dimension, hourly granularity, and Google Play.
