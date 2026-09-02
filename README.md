# AppRank

> Self-hosted App Store Optimization tracking for your apps. Runs free on
> Cloudflare Workers and GitHub Actions.

| What it collects                             | From              | How often                               |
| -------------------------------------------- | ----------------- | --------------------------------------- |
| Keyword rank, the full top 200               | iTunes Search     | Every 1 to 7 days per keyword           |
| Search popularity                            | Apple Ads         | Weekly, the only official volume figure |
| Title, subtitle, version, price, screenshots | iTunes Lookup     | Checked daily, stored when it changes   |
| Ratings and reviews                          | iTunes RSS        | Daily                                   |
| Top free, paid and grossing charts           | iTunes RSS        | Daily                                   |
| Engagement, usage and commerce reports       | App Store Connect | Daily, your own analytics               |
| Keyword difficulty                           | Derived locally   | Daily, computed                         |

You describe what to track in one file:

```json
{
	"steve": {
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

## The collector runs in two places

| Where             | Collects                                          |
| ----------------- | ------------------------------------------------- |
| Cloudflare Worker | App Store Connect, Apple Ads                      |
| GitHub Actions    | Keyword ranks, metadata, ratings, reviews, charts |

Both are required, and they are split by which APIs each can reach.

Set up both. A Worker deployed on its own does not sit quietly with an empty
dashboard, and the [deploy guide](docs/deploy.md#collection-runs-in-two-places)
explains why.

## Quick start

```sh
pnpm install

npx wrangler d1 create apprank
npx wrangler r2 bucket create apprank-archive

cp apps/collector/wrangler.jsonc apps/collector/wrangler.local.jsonc
cp apps/web/wrangler.jsonc apps/web/wrangler.local.jsonc
# …paste your database_id into both, and set APP_URL in the web one

pnpm migrate:remote && pnpm seed:remote

cp tracked.example.json tracked.local.json
# …edit it, then:
pnpm track            # diff only, writes nothing
pnpm track --apply

# Both are required. Without the first the site answers 503; without the
# second nothing can drive collection.
(cd apps/web       && npx wrangler secret put BASIC_AUTH_ACCOUNTS -c wrangler.local.jsonc)
(cd apps/collector && npx wrangler secret put ADMIN_TOKEN         -c wrangler.local.jsonc)

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
- **An R2 archive as the source of truth.** Every response is kept verbatim, so
  D1 is a cache rather than the record. `scripts/rebuild-d1` reconstructs the
  rank observations from the archive alone, which is what makes pruning and
  retention performance choices instead of lossy ones.

## How much you can track

The unit is the **crawl pair**: one keyword in one storefront. 20 keywords
across 5 storefronts is 100 pairs.

One daily Actions run fits about 100 pair crawls. Past that the collector checks
the least informative pairs less often rather than dropping any, because a
dropped pair loses its history for good. Cloudflare's limits are nowhere near
binding at that size. [The numbers](docs/limits.md).

## Docs

| Guide                                | Covers                                            |
| ------------------------------------ | ------------------------------------------------- |
| [Deploying](docs/deploy.md)          | Cloudflare resources, tracked set, GitHub Actions |
| [Credentials](docs/credentials.md)   | Every secret, rotation, generating the Apple keys |
| [Access control](docs/access.md)     | Basic auth, accounts, why 404 and not 403         |
| [MCP](docs/mcp.md)                   | Issuing tokens, scopes, what each tool answers    |
| [Limits](docs/limits.md)             | What actually runs out, and when                  |
| [Architecture](docs/architecture.md) | Work loop, cadence, data model, R2 layout         |

## Development

```sh
pnpm lint          # ultracite (oxlint + oxfmt)
pnpm typecheck
pnpm test          # vitest in the Workers runtime, then the script tests
pnpm coverage      # 80% statements / lines / functions, 70% branches
pnpm generate      # drizzle-kit, after a schema change
pnpm rebuild:d1    # rebuild D1 from the R2 archive
```

`pnpm install` points `core.hooksPath` at `.githooks/`, which lints on commit
and runs the tests on push.

Node 24+, pnpm 11+. `CLAUDE.md` is the working context for coding agents.

## License

[Apache 2.0](LICENSE)
