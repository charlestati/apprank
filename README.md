# AppRank

Self-hosted App Store Optimization tracking that runs on Cloudflare's free tier,
for your own apps on your own infrastructure.

| What it collects                             | From                 | How often                               |
| -------------------------------------------- | -------------------- | --------------------------------------- |
| Keyword rank, the full top 200               | iTunes Search        | every 1 to 7 days per keyword           |
| Search popularity                            | Apple Ads            | weekly, the only official volume figure |
| Title, subtitle, version, price, screenshots | iTunes Lookup        | daily, versioned on change              |
| Ratings and reviews                          | iTunes RSS           | daily                                   |
| Top free, paid and grossing charts           | marketingtools + RSS | daily                                   |
| Engagement, usage and commerce reports       | App Store Connect    | daily, first-party                      |
| Keyword difficulty                           | derived, not fetched | daily, from the pages already held      |

You describe what to track in one file:

```json
{
	"admin": {
		"apps": [
			{
				"appId": 123456789,
				"language": "en",
				"storefronts": ["us", "gb", "ca"],
				"keywords": ["habit tracker", "daily planner"]
			}
		]
	}
}
```

```sh
pnpm track --apply
```

That is the whole configuration surface. Storefronts, locales and keywords are
rows in a database, so adding one is an `INSERT`. Never a migration, never a
redeploy.

## The collector runs in two places

Both halves are required, and they are split by which APIs each can reach.

| Where                        | Collects                                          | Why there                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker, on a cron | App Store Connect, Apple Ads                      | Credentialed, and reached over infrastructure Apple serves fine from a Worker                                                                                                 |
| GitHub Actions, daily        | Keyword ranks, metadata, ratings, reviews, charts | Apple rate-limits the public iTunes endpoints per IP, and every Worker egresses from a pool Apple has already rejected: HTTP 429 on _every_ search, at one request per minute |

The runner executes the **same collector code** against the same D1 and R2, so
observations carry the same normaliser, provenance and idempotent keys wherever
they were fetched. Only the source address differs.

So wire up the workflow: deploying the Workers alone gives you a dashboard with
no rank data in it.
[How both halves are set up](docs/deploy.md#collection-runs-in-two-places).

## Quick start

```sh
pnpm install

npx wrangler d1 create apprank
npx wrangler r2 bucket create apprank-archive

cp apps/collector/wrangler.jsonc apps/collector/wrangler.local.jsonc
cp apps/web/wrangler.jsonc apps/web/wrangler.local.jsonc
# …paste your database_id into both

pnpm migrate:remote && pnpm seed:remote

cp tracked.example.json tracked.local.json
# …edit it, then:
pnpm track            # diff only, writes nothing
pnpm track --apply

pnpm deploy
```

Full walkthrough, including the GitHub Actions secrets:
[docs/deploy.md](docs/deploy.md).

## What you get

- **A keyword-performance dashboard**: rank history on a calendar axis, the
  competitors holding each result page, difficulty scored from what that page
  actually shows, and metadata releases drawn as anchors against rank moves.
- **An honest one.** Every observation carries provenance, and the chart keeps
  four states apart: ranked, observed but outside the top 200, never collected,
  and collected and failed. Apple's throttle returns 403 with an empty result
  array, and that is recorded as an error rather than stored as "not ranking".
- **A JSON API** behind HTTP Basic, gating the whole origin.
- **An MCP endpoint** (opt-in) so Claude Code can query the same data. Fourteen
  read-only tools, no SQL passthrough.
- **An R2 archive as the source of truth.** D1 is a rebuildable materialised
  view; `scripts/rebuild-d1` reconstructs it from the archive alone.

## Costs

The unit is the **crawl pair**: one (keyword, storefront, locale) triple, so 20
keywords in 5 storefronts is 100 pairs.

One daily GitHub Actions run fits roughly **100 pair crawls** in its 45-minute
window, measured at the rate the collector learned it can fetch without being
throttled. Past that the cadence ladder re-spaces pairs across 1, 2, 3 and 7-day
rungs so the load still fits. Adding keywords costs frequency on the least
informative pairs, never coverage, because a dropped pair loses its history for
good.

Cloudflare's free tier is not what runs out: at ~21 row-writes per cold crawl,
D1's 100k/day binds around 4,700 crawls. [The numbers](docs/limits.md).

## Docs

|                                      |                                                        |
| ------------------------------------ | ------------------------------------------------------ |
| [Deploying](docs/deploy.md)          | Cloudflare resources, tracked set, GitHub Actions      |
| [Credentials](docs/credentials.md)   | Every secret, rotation, generating the Apple keys      |
| [Access control](docs/access.md)     | Basic auth, accounts, why 404 and not 403              |
| [MCP](docs/mcp.md)                   | Issuing tokens, the fourteen tools                     |
| [Limits](docs/limits.md)             | How many keywords and storefronts fit in the free tier |
| [Architecture](docs/architecture.md) | Work loop, cadence, data model, R2 layout              |

## Development

```sh
pnpm lint          # ultracite (oxlint + oxfmt)
pnpm typecheck
pnpm test          # vitest in the Workers runtime
pnpm coverage      # 80% statements/lines/functions, 70% branches
pnpm generate      # drizzle-kit, after a schema change
```

Node 24+, pnpm 11+. `CLAUDE.md` is the working context for coding agents.

## License

[Apache 2.0](LICENSE)
