# AppRank — working notes for agents

Self-hosted App Store Optimization tracking on Cloudflare's free tier. It collects App Store keyword ranks, Apple Ads search popularity, app metadata changes, ratings and reviews, then presents them as a keyword-performance report. The repository is public, so nothing personal belongs in it.

`README.md` is the user-facing setup guide. This file is the working context: architecture, conventions, and the traps that already cost time once.

## The five invariants

Everything in the design follows from these. Check a change against them before writing it.

1. **History cannot be backfilled.** A day not collected is gone forever. The collector ships and runs before any feature work; never break collection to land UI.
2. **R2 is the source of truth; D1 is a rebuildable materialised view.** Pruning, retention and schema changes must stay performance choices, never lossy ones. `scripts/rebuild-d1` reconstructs the observation tables from the archive alone and is a first-class deliverable.
3. **Visible gaps beat silent garbage.** Every observation carries provenance (HTTP status, response time, result count, collector version, archive key). Apple's rate limit returns **HTTP 403 with an empty results array** — that is throttling, and it must never be stored as "the app is not ranking". Failures go to `fetch_error`; charts render gaps as gaps.
4. **Politeness is correctness.** All Workers egress shares Cloudflare IPs and Apple rate-limits per IP, so the crawler discovers its own sustainable rate and backs off hard. Never raise the fetch rate to make something finish faster. When demand exceeds the budget, stretch intervals — **flex frequency, never coverage**, because dropping a pair destroys its history permanently.
5. **Reference data is rows, not code.** Adding a storefront, locale, genre or keyword is an `INSERT`. If a change would require a migration or redeploy to track one more keyword, it is the wrong change.

## Layout

| Path | What it holds |
| --- | --- |
| `packages/core/src/schema` | Drizzle schema (source of `packages/core/migrations`) |
| `packages/core/src/apple` | `jwt.ts` (WebCrypto ES256), `ads.ts`, `asc.ts`, `itunes.ts` |
| `packages/core/src/normalize` | iTunes response → normalised observation + validity gates |
| `packages/core/seeds` | `reference.sql` (storefronts/locales/genres), `tier1.example.sql` template |
| `apps/collector` | The crawler: `scheduler.ts` (Durable Object work loop), `tasks/*`, `lib/pacing.ts` |
| `apps/web/src` | Hono JSON API (`index.ts`), shared query layer (`queries/*`), report builder (`report.ts`), Basic-auth gate (`basic-auth.ts`), MCP server (`mcp/*`) |
| `apps/web/client` | Vite React SPA served from Workers Static Assets |
| `scripts/rebuild-d1` | R2 → D1 rebuild and verification |
| `scripts/local-refresh` | Collection driven from a machine Apple will answer, plus its consistency checks |

Two Workers (`apprank-collector`, `apprank-web`), one D1 database (`apprank`), one R2 bucket (`apprank-archive`).

## The MCP transport

`/mcp` on the web Worker serves the same data over MCP: stateless streamable HTTP via `createMcpHandler` from `agents/mcp/server`. Not `McpAgent` — that is the legacy path and needs a Durable Object this Worker has none of, which would add state `scripts/rebuild-d1` could not reconstruct.

Four things hold it together, and none of them is optional:

- **The gate runs before the handler is built.** `handleMcp` authenticates, then constructs the server with the resolved principal closed over. Tool code is unreachable without a principal, so a misregistered tool is still not callable by a stranger, and no tool has to handle "who is this?" returning nothing.
- **MCP credentials are a separate table and a separate gate.** `mcp_credential` holds only the SHA-256 of the secret — unlike `BASIC_AUTH_ACCOUNTS`, which is a Worker secret and may hold plaintext; this is an ordinary D1 table that gets queried and dumped. The Basic middleware exempts `/mcp` deliberately: falling through would let a browser account drive the tools, which is the exact scope crossing the two credential types exist to prevent. `ALLOW_UNAUTHENTICATED` does **not** open MCP, because a dev flag that publishes an agent endpoint is a trap.
- **Ownership is the same function, not a copy.** Tools call the same `ownsApp`/`ownsPair` the routes call, and answer with an identical message whether a resource is absent or someone else's — the 404-not-403 rule, in tool form.
- **Every answer carries its own provenance.** `queries/coverage.ts` reports observation counts, gaps and the `fetch_error` windows behind them, in prose in the body. Without it Apple's 403-with-empty-results resurfaces at the analysis layer and a throttled week reads as a ranking collapse. Coverage is measured against each pair's `interval_hours`, never the calendar: a pair on a stretched rung is _supposed_ to have gaps, and counting those as missing days makes the whole signal useless.

`test/mcp-auth.test.ts` walks every scoped tool in a `SCOPED_TOOLS` list and fails if one is added without a guard, the way `test/access.test.ts` does for routes. `test/worker-config.test.ts` asserts `run_worker_first: true`, which is the only reason `not_found_handling: single-page-application` cannot claim `/mcp` or `/api`.

## How collection works

A single `SchedulerDO` Durable Object owns all collection. Its `alarm()` does **one** bounded unit of work per tick — one queued task step, or one keyword crawl — then reschedules itself at the learned rate. Two crons drive it: `*/10 * * * *` re-arms a lost alarm, `0 3 * * *` queues the daily jobs (compaction, App Store Connect poll, Monday Apple Ads pull, per-app lookups, reviews, charts).

Two things adapt, and they are separate:

- **Rate** (`lib/pacing.ts`) — how fast we may fetch. Two brakes, deliberately separate. The **pause** is per incident: any 403/429 parks the loop with exponential backoff (30m → 1h → 2h → 4h cap). The **rate** is a per-day trend: it starts at 4 fetches/min, halves **once** on the throttle that takes a day past `DAILY_THROTTLE_TOLERANCE` (floor 1/min), and recovers 10% per day that stayed within it (ceiling 6/min). Once per day, not once per throttle: applying it to every subsequent hit turned the rate back into a one-way ratchet (4 → 2 → 1 in three hits), which is the failure the two-brake split exists to prevent. Persisted in `collector_state`, so a redeploy does not restart discovery.

  Recovery is judged on the closed day, **not** on a throttle-free 24h. Requiring a clean 24h made the raise unreachable on a shared egress IP that throttles most days, so the rate became a one-way ratchet down to the floor — and a floored rate silently shrinks the cadence budget. Most of Apple's bucket is consumed by other Workers on the same address, so halving our own share on one stray 429 costs coverage and relieves nothing; that is why the pause, not the rate, absorbs isolated hits.

- **Cadence** (`lib/budget.ts` + `tasks/cadence.ts`) — how often each pair is checked, given that rate and how much work exists. The daily job measures capacity (`rate × window − app-level overhead`), scores every pair (popularity, proximity to the top-10 boundary, volatility, storefront weight, new-pair backfill, metadata burst), and splits them across two adjacent rungs of the ladder `[1, 2, 3, 7]` days so the load fits the budget exactly. Adding apps or keywords therefore costs resolution, never coverage; the plan is stored as `cadence_plan` and shown on the data-health page.

`COLLECTION_MODE` decides which half of that runs where. It defaults to `all`; the deployed collector sets `credentialed` in the gitignored `wrangler.local.jsonc`, so it queues only App Store Connect and Apple Ads — the two APIs Cloudflare's egress can actually reach. Rank crawls, metadata lookups, reviews and charts run from a borrowed IP instead (`scripts/local-refresh`, `.github/workflows/collect.yml`, whose generated config forces `all`). Attempting them from a Worker was never free: each 429 fed `windowErrorCount`, and once that passed tolerance it halved the learned rate — a known-broken path quietly degrading the signal that sets crawl cadence. Manual triggers stay exempt: `crawlNow` fetches whatever it is asked to, which is what makes "is Apple still blocking this IP?" answerable in one request.

Alarms are **at-least-once with automatic retries**, so every write must be idempotent (`ranking` is unique on `(pair_id, observed_date)`; reviews key on Apple's own review id). Never call `deleteAlarm()` inside `alarm()`.

`ensureAlarm()` also pulls in an alarm parked more than a minute out — without that, a stale long park (old deploy) blocks newly due work. That bug cost an evening; do not "simplify" it back. The exception is a park that matches an active `pauseUntil`: that one is deliberate, and dragging it forward woke the loop every watchdog tick for the whole backoff, spending reads and a write each time to rediscover that it was paused.

### The data model in one paragraph

User intent (`tracked_app`, `tracked_keyword`) is separate from what is observed. The crawl unit is `crawl_pair` — the reference-counted union of distinct `(keyword, storefront, locale)` triples — so two users tracking the same keyword produce one fetch. A keyword is always tracked against a **(storefront, locale)** pair because Apple cross-localizes (Canada indexes `en-CA` and `fr-CA`; Belgium `en-GB`, `nl`, `fr`; Switzerland four locales). Which storefronts matter follows the app's content language (`app_language`), not market size. `app_localization` records "no localization for this storefront's indexed locale" as a first-class state, because that gap is itself an ASO finding. `ranking` stores the full ordered list of up to 200 track IDs as JSON plus provenance; `rank_entry` indexes only the top 10 and any tracked app, because a row per position would be 18× the write budget.

## Commands

```sh
pnpm lint          # ultracite (oxlint + oxfmt); must exit 0
pnpm lint:fix      # autofix + format
pnpm typecheck     # wrangler types, then tsc across every workspace
pnpm types         # regenerate worker-configuration.d.ts after a wrangler.jsonc edit
pnpm test          # vitest in the Workers runtime
pnpm coverage      # enforces 80% statements/lines/functions, 70% branches per workspace
pnpm generate      # drizzle-kit generate after editing the schema
pnpm migrate:local # / migrate:remote, seed:local, seed:remote
pnpm deploy        # collector then web
```

`wrangler.jsonc` is committed with placeholder ids. Every script prefers `wrangler.local.jsonc` (gitignored) when present — that is where real `database_id` and `APP_URL` values live. Personal seeds live in `packages/core/seeds/local/` (also gitignored).

## Conventions

- **pnpm only** (v11, workspace protocol). `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` — packages must be a week old, so pick versions accordingly or the install fails with `ERR_PNPM_NO_MATCHING_VERSION`.
- **`fetch_error.error_class` is a closed vocabulary, never a message.** The data-health page groups on it, so a raw upstream body there becomes its own one-row "class" and buries the counts. Put the body in `message` (wide enough to diagnose) and pick a class: `throttled`, `rate_limited`, `http_error`, `invalid_body`, `upstream_error`, `task_threw`, `app_not_in_storefront`, `pull_abandoned`.
- **Comments explain constraints**, not mechanics: why a limit exists, what Apple does, why a branch is unreachable. No "this line does X" narration.
- **The API returns raw column names** for legacy endpoints and camelCase for the newer report endpoint; do not "harmonise" one into the other without updating both the client types and the tests.
- **Route handlers hold no SQL.** Every query lives in `apps/web/src/queries/*` as a plain `(db, params)` function and the handler parses, guards ownership, and calls it. That is what lets a second transport reuse a query instead of copying it, and it keeps one place to change when a column moves.
- **The dashboard follows the Appfigures keyword-performance layout** (sidebar, filter bar, three summary tiles, multi-series inverted rank chart, dense grouped-header table) styled with **Atlassian Design System tokens**, defined as CSS variables in `apps/web/client/src/theme.css`.

## Access control

HTTP Basic against a fixed set of accounts held in the `BASIC_AUTH_ACCOUNTS` secret — a JSON array of `{ username, password, userId? }`. `userId` is the durable identity: it is what `tracked_app.user_id` and the ownership checks compare against, so passwords can rotate freely but changing a `userId` re-points that person at a different set of apps. It defaults to the username.

Passwords are compared as SHA-256 digests in constant time. **Do not "improve" this into bcrypt or scrypt**: a KDF would be the most expensive thing in the request on the free tier's 10ms CPU budget, and these are machine-generated high-entropy secrets, so there is no offline brute-force to slow down.

The Worker gates **the whole origin**, not just `/api`. A `fetch()` that receives a 401 does not reliably make a browser show its credential prompt, so protecting only the API would leave the page loading with every request failing and no way to sign in. `run_worker_first: true` plus the `ASSETS` binding means the HTML is behind the same wall — an unauthenticated visitor never receives the application at all. Asset requests therefore cost Worker invocations, roughly one per page load.

It fails closed: no accounts configured means 503, never an implicit operator. `ALLOW_UNAUTHENTICATED=true` re-opens it for local development only. `/api/health` stays public so uptime checks work unauthenticated; it names no app and no keyword.

Ownership is the second, separate check, and it is the one that keeps operators apart:

- `src/access.ts` asks whether _this_ operator tracks the app or keyword being requested. Without it any authenticated user could read another's data by walking ids, which are guessable integers. `ownsApp`/`ownsPair` take `(db, userId, id)` rather than a request context, so a second transport enforces the rule by calling the same function instead of reimplementing it; `callerOwnsApp`/`callerOwnsPair` are the HTTP-shaped wrappers.
- A resource the caller does not own answers **404, not 403** — a 403 confirms the id exists, which is itself information about someone else's account.
- Ownership is on the tracked set, not the observations: `crawl_pair` is deliberately the union of what everyone tracks, so `ownsPair` asks whether the caller tracks that _keyword_.

When adding a route that takes an `:appId` or `:pairId`, add the `ownsApp` / `ownsPair` guard. `test/access.test.ts` walks every scoped route and fails if one is missed.

Basic auth has no sign-out: the browser holds the credentials until it is closed. That is the trade that bought a 84 KiB Worker instead of a 1.9 MB one (Better Auth was 97% of the bundle) with no session tables and no `nodejs_compat`.

## What the dashboard is for

`src/insights.ts` turns tracked numbers into the decision an ASO cycle needs, and states its thresholds in one place so they can be argued with: popularity ≥5 is the floor for measurable volume and ≥30 is a head term; below roughly rank 10 nothing earns taps; a difficulty ≥80 means the incumbents will not be moved by metadata alone; a rank that moved in the last 48h is unproven because Apple reshuffles.

Those rules produce four lanes — **winning** (defend), **within reach** (aim the next release here), **blocked** (needs more than metadata), **vanity** (ranked where nobody searches; reclaim the slot). Two habits matter more than the numbers:

- **Brand terms are counted separately.** You should already be #1 on your own name, and brand demand is the ceiling on what generic ASO can add. Mixing them into one average flatters the picture, so the headline is generic-keywords-in-top-10.
- **Average rank is a vanity metric** — it is dragged around by dead keywords. The distribution and the lane counts are the real health read.

Metadata changes are drawn on the rank chart as markers, because a rank move is only interpretable against the release that might have caused it. The markers are **numbered pins keyed to a caption**, not repetitions of the word "metadata": three releases in a fortnight are otherwise indistinguishable from each other, and a marker you cannot attribute anchors nothing. The report reuses `queries/metadata.ts` for that diff rather than keeping its own dates-only query.

The chart is reachable without a mouse. The crosshair is the only way to read an exact value off it, so arrow keys walk the same index (Home/End jump, Escape clears) and the readout is mirrored into a polite live region in the same words the tooltip uses. The graphic carries `aria-describedby` to a `<figcaption>` that says what a gap means, and the dense table below it is the numeric alternative the caption points at.

**The rank chart's x axis is the calendar, never the list of observed days.** It was originally one slot per observed date, which drew a seven-day cadence gap at the same width as an overnight step: every slope across a stretched rung was wrong, and the gap the ladder deliberately creates disappeared. `report.window` carries the requested window so the axis can span it; `report.dates` stays the sparse observed set and is not an axis.

The chart separates four states, and collapsing any two of them re-creates the failure invariant 3 exists to prevent: **ranked** (a point on the line), **observed but outside the top 200** (`position: null` — its own rail below the plot, because it is data), **never collected** (a plain gap — the cadence never scheduled that day), and **collected and failed** (`row.fetchErrors`, a hatched mark on the error rail, so a throttled week cannot read as a ranking collapse). Series carry a dash pattern as well as a hue, and the same glyph keys the legend, the table toggle and the line: colour is never the only channel, and the categorical palette is capped at four by default because past that the hues stop surviving a colour-vision check side by side.

## Traps already hit (do not rediscover these)

**Apple**

- The public iTunes Search API rate-limits by IP and Cloudflare's egress is shared, so 429s arrive at volumes far below the documented ~20/min. The body reads `Rate limit has been exceeded for: itunes-apple-com|general|<ip>`. This is expected; the answer is patience, not parallelism.
- Apple Ads popularity is **weekly** (`WEEKLY_SUN_SAT`), posted about a week late, and only covers roughly the top 500 terms per genre/storefront. Absence is "no data", not "low popularity" — hence `popularity.present`.
- Apple's own Node SDK does not run on workerd (`fs` + axios). The hand-rolled clients in `packages/core/src/apple` are deliberate.
- App Store Connect `ONGOING` report requests die if not polled (`stoppedDueToInactivity`), and Apple sometimes publishes a duplicate `processingDate` then skips the next day permanently. Both are detected and recorded; do not treat either as normal.
- **ASC bookkeeping is per app, and that column is load-bearing.** Report requests are created per app, so `asc_report_instance.app_id` is known at write time; it was originally dropped on insert. Without it both anomaly detectors answer for the union of tracked apps — one app's published day satisfies another app's `NOT EXISTS` gap check, and a second app's legitimate report is flagged as the first app's `duplicate_date` — and there is no column for `ownsApp` to check, so first-party analytics has no owner. The archive key carries the app for the same reason: the dimension has to exist in R2 or it cannot be rebuilt into D1.
- **ASC carries no per-search-term report.** Verified against the live report list (156 reports for one app, archived at `asc/{appId}/report-list-{requestId}.json`): 103 `FRAMEWORK_USAGE`, 23 `PERFORMANCE`, 15 `APP_USAGE`, 10 `COMMERCE`, and only 5 `APP_STORE_ENGAGEMENT` — Discovery and Engagement (Standard/Detailed), Web Preview Engagement (Standard/Detailed), Retention Messaging. Search appears as a _source type_, never as a term. So popularity↔traffic calibration is capped at source-type level; do not plan a feature that assumes term-level impressions.
- **Apple Ads popularity is per top-level category, not per sub-genre.** The endpoint's own allowed values are exactly fifteen: `BUSINESS EDUCATION ENTERTAINMENT FINANCE FOOD_DRINK GAMES HEALTH_FITNESS LIFESTYLE NEW_PUBLICATION PHOTO_VIDEO PRODUCTIVITY_UTILITIES SHOPPING SOCIAL_NETWORKING SPORTS TRAVEL`. Word, Puzzle, Board, Trivia and Educational all collapse to `GAMES` and return one identical list, so `lib/ads-genres.ts` lifts each tracked genre to its parent and the queue is deduped — five queries per storefront were four wasted calls. Popularity is stored against the parent genre id (Games = 6014); recording a GAMES-wide ranking under "Games/Word" would claim precision Apple does not provide.
- The Platform API request body is `{ timeRange: { start, end, granularity }, filters: [{ field, operator, value }], sorting, pagination }`. The older Campaign Management `{ granularity, selector: { conditions, orderBy } }` envelope earns `REQUEST_UNRECOGNIZED_PROPERTY`. The response is `{ result: { rows } }`, not `{ data }`.
- The Ads pull is **weekly data, so it is gated on the week already held** (`ads:pulled:{storefront}:{category}` in `collector_state`) and both upserts carry a `WHERE ... IS NOT excluded....` clause. Before that, a repeat pull rewrote 500 seed terms plus every popularity row per unit — and re-pulls were common, because the manual trigger is how a credential gets verified. The manual path passes `force`, so a credential check still makes a real request rather than silently skipping one.
- **D1 writes are the scarcest resource, not fetches.** The free tier allows 100k row-writes a day, and one full crawl pass is roughly 5,000 (per pair: 1 `ranking`, ~11 `rank_entry`, plus app and metadata upserts). Five manual `Collect` dispatches plus a bulk `DELETE` reached 88k in a single day. A conflicting upsert is never free either — D1 charges a row-write even when the `WHERE` skips the update — so the `WHERE` halves the residual while the week gate is what actually removes the cost. Before re-running anything in bulk, check what is already due: `SELECT SUM(next_due_at <= strftime('%s','now')*1000) FROM crawl_pair WHERE ref_count > 0`.
- `job=ads` verifies by default and writes nothing: it fetches, archives to R2, and stops. `?write=1` opts into the full pull. The archive already proves the JWT signed, Apple answered and the shape parsed, which is everything a credential check asks — spending 500 writes per unit to learn it again was the wrong trade.
- Sub-genre rows in `seed_term`/`popularity` are a bug, not history: 4,500 rows once stored the _unfiltered_ storefront list (`capcut`, `chatgpt`, `betclic` at rank 1) under Word, Puzzle, Board and Trivia ids, from pulls made before the genre filter existed. Only the parent genre id (Games = 6014) is ever correct. If sub-genre ids reappear, something is writing `unit.genreId` from the tracked genre rather than the resolved parent.
- Coverage is thin at the long tail, and this is the normal case, not an error: of 25 tracked French keywords only **3** appear in Apple's top-500 GAMES list (`scrabble` 65, `mots mêlés` 60, `mots croisés` 60). The other 22 are stored `present = 0`. Any code that reads popularity must distinguish absent from zero.
- Apple Ads discovery goes through `GET /v1/acls`, not `/v1/ad-accounts`: it is one of only two endpoints that work without the `X-AP-Context` header, and it returns the granted roles beside each account. `/v1/ad-accounts` answers `404 RESOURCE_NOT_FOUND` when the user holds no grant, which is indistinguishable from a wrong URL. An empty `acls` array means valid credentials with no ad-account grant — a user-management problem, not a key problem.
- The `marketingtools` chart API has no top-grossing and no genre filter; the legacy `itunes.apple.com/{cc}/rss/top*applications` feeds are the only source for those and are undocumented, so provenance records which endpoint served each observation.

**Cloudflare / tooling**

- D1 rejects `BEGIN TRANSACTION` and `CREATE TEMP TABLE` with `SQLITE_AUTH`; Miniflare's D1 **does** enforce foreign keys, so seed parents first.
- `@cloudflare/workers-types` v5 dropped versioned entrypoints. Types come from `wrangler types` (generated `worker-configuration.d.ts`, gitignored). Because it is generated and not committed, **each app's `typecheck` regenerates it first** (`wrangler types && tsc`) — a clean checkout has no Workers globals and no bindings, so `tsc` answers `TS2304: Cannot find name 'D1Database'` roughly two hundred times. Every CI run failed that way until the generation was chained in. Generation needs no auth and no network, and it reads the committed `wrangler.jsonc`, so CI types match the deployed config rather than a local override; run `wrangler types -c wrangler.local.jsonc` when you want the local `APP_URL` in your editor. Cloudflare's other pattern — commit the file and gate it with `wrangler types --check` — trades a generated artefact in review diffs for the same guarantee, and was not taken.
- `apps/web` declares `nodejs_compat`, so `wrangler types` asks for `@types/node`; it is installed and listed in that workspace's `tsconfig.json` `types` array, which is explicit and would otherwise never load it.
- Better Auth was built and then removed. It works, but it pulled `node:crypto` (so `nodejs_compat`) and took the Worker bundle from 84 KiB to 1,939 KiB to serve a handful of accounts that never change. Basic auth over a secret replaced it. Reach for Better Auth again only when self-service signup is a real requirement, not before.
- `wrangler dev --remote` no longer works for a Worker that declares a Durable Object: "`wrangler dev --remote` is no longer supported for Durable Objects." That is why the collector has one public route — `POST /admin/run?job=…` behind `ADMIN_TOKEN` (`src/lib/admin.ts`). Without it, verifying an Apple credential costs a day (the ASC cron) or a week (the Monday Ads gate).
- A throttled batch unit is retried in place twice, then rotated to the back of its own queue, and the batch is abandoned for the day once every unit has had its turn (`pull_abandoned`). Before that, `attempt` was incremented and never read: a storefront answering a persistent 403 on the lookup/reviews/charts endpoints starved every unit behind it forever and burned the pacing pause ladder daily. `rating_snapshot`, `review` and `chart_ranking` were empty for a day because of it, with only `throttled` rows to show for it.

Task steps swallow a failed unit into `fetch_error` and return normally, so that one bad unit cannot wedge the queue. Manual fetches also book their throttles through `onAdminThrottle`, which records `lastErrorAt` and nothing else: the admin path already ignores `pauseUntil` because it is a diagnostic, so letting its hits feed the daily tally would let the measurement halve the rate it was measuring. `runNow` therefore judges success by diffing `fetch_error` across the call, not by whether the step threw — a manual trigger that answered `ok: true` on a rejected credential would be worse than no trigger.

- **`agents` pulls `core-js-pure`, whose build script must be answered.** pnpm refuses to install with an unapproved build script and every command — `pnpm generate` included — then fails with `ERR_PNPM_IGNORED_BUILDS`. It is denied in `pnpm-workspace.yaml`, not approved: nothing imports it and its postinstall only prints a funding notice.
- **`minimumReleaseAge: 10080` outranks "latest".** At the time of writing `agents@0.22.0` (4 days) and `zod@4.5.x` (2 days) both fail it. Pinned: `agents@0.21.0`, `zod@4.4.3`, `@modelcontextprotocol/{server,client}@2.0.0`, `@modelcontextprotocol/sdk@1.30.0` (the peer `agents` names). Check publish dates before bumping any of them.
- **An MCP reply is produced lazily as its SSE stream is read.** A test that calls the endpoint and asserts on a `waitUntil` side effect — the audit row — without draining the body first waits for nothing, because the tool has not run yet. `test/mcp-fixtures.ts` reads the body _before_ `waitOnExecutionContext`; do not reorder it.
- `config` cannot be a package.json script name: `pnpm config` is a built-in.
- macOS is case-insensitive; renaming `Foo.tsx` → `foo.tsx` leaves the old path in the git index and breaks Linux CI. `git config core.ignorecase false` and re-add.
- The ultracite vitest preset applies rules inside its own override block, which beats top-level `rules` in `oxlint.config.ts`. Test-specific relaxations must therefore be justified `/* oxlint-disable … -- reason */` headers in the test files.

**Testing**

- `@cloudflare/vitest-pool-workers` 0.20 has **no isolated storage** and **no `fetchMock`**. Reset the database in `beforeEach` (see `apps/web/test/fixtures.ts`) and stub `globalThis.fetch` via `vi.stubGlobal` (see `apps/collector/test/helpers.ts`) — tests share the isolate with the Worker, so a global stub intercepts its outbound calls.
- Inspect Durable Object state with `runInDurableObject` rather than widening the production RPC surface for tests.
- A Durable Object receives the Worker's **deployed** env, not the per-call overrides handed to `worker.fetch(request, { ...env, SECRET: x })`. A job that runs inside `SchedulerDO` therefore cannot be given a synthetic Apple key from a test; assert the failure path instead (see `test/admin.test.ts`).
- Never point synthetic data at the remote database. Seed the local D1, review, then clear it.

## Status

Working and deployed: the collector (keyword ranks, metadata versioning, ratings, reviews, charts, App Store Connect and Apple Ads ingestion), the JSON API, the dashboard, and the MCP endpoint (14 read-only tools at `/mcp`).

Waiting on the operator: the `ASC_*` and `ADS_*` Worker secrets. Until they are set the daily job skips those jobs quietly. Setting `ASC_*` is urgent — the first poll fires a `ONE_TIME_SNAPSHOT` that captures all history App Store Connect still retains.

**Difficulty is ours, and it is documented.** `lib/difficulty.ts` scores 0–100 from what the result page actually shows: the rating mass of the top 3 (0.45), of the top 10 (0.30), how much the board turns over (0.15) and how full the page is (0.10), all on a log scale. Every input is stored beside the score in `keyword_difficulty`, along with `formula_version` and the sample size, so the weights can change and the whole history be recomputed. Pages we hold no rating counts for are skipped, never scored from nothing. Bump `FORMULA_VERSION` on any change to the shape, so old and new scores are never silently compared.

Not built: the Tier-2 global market sweep (seeded from Apple Ads' ranked term lists, written to R2 only, never D1) and the calibrated difficulty score it feeds; brand-vs-generic keyword classification; Google Play. The schema already has `seed_term`, `suggestion` and `rollup_monthly_rank` for this work.

Explicitly out of scope: download/revenue estimation for other people's apps (needs panel data we do not have), team accounts and billing, and anything with an LLM in it.
