# AppRank

Self-hosted App Store Optimization tracking that runs on Cloudflare's free tier. Keyword ranks, Apple Ads search popularity, metadata changes, ratings and reviews — for your own apps, on your own infrastructure, with the raw responses archived so nothing is ever locked in a vendor's database.

You describe what to track in one file:

```json
{
  "charles": {
    "apps": [
      {
        "appId": 123456789,
        "language": "fr",
        "storefronts": ["fr", "ca", "be"],
        "keywords": ["jeu de lettres", "mots croisés"]
      }
    ]
  }
}
```

```sh
pnpm track --apply
```

That is the whole configuration surface. Storefronts, locales and keywords are rows in a database, so adding one is an `INSERT` — never a migration, never a redeploy.

## Before you deploy

**Apple blocks Cloudflare's egress.** Every Worker shares an IP pool that Apple's iTunes endpoints have already rate-limited, so the deployed collector gets HTTP 429 on _every_ keyword search — at one request per minute. The fetching therefore runs from GitHub Actions, executing the same collector code against the same D1 and R2 with only the source address different. Cloudflare still runs App Store Connect and Apple Ads, which are credentialed and work fine from a Worker.

Deploy the Workers without wiring up the workflow and you get a dashboard and 429s. [Details](docs/deploy.md#apple-blocks-cloudflare-so-collection-runs-from-github-actions).

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

Full walkthrough, including the GitHub Actions secrets: [docs/deploy.md](docs/deploy.md).

## What you get

- **A keyword-performance dashboard** — rank history on a calendar axis, the competitors holding each result page, difficulty scored from what that page actually shows, and metadata releases drawn as anchors against rank moves.
- **An honest one.** Every observation carries provenance, and the chart keeps four states apart: ranked, observed but outside the top 200, never collected, and collected and failed. Apple's throttle returns 403 with an empty result array, and that is recorded as an error rather than stored as "not ranking".
- **A JSON API** behind HTTP Basic, gating the whole origin.
- **An MCP endpoint** (opt-in) so Claude Code can query the same data — fourteen read-only tools, no SQL passthrough.
- **An R2 archive as the source of truth.** D1 is a rebuildable materialised view; `scripts/rebuild-d1` reconstructs it from the archive alone.

## Costs

Free tier, and the binding constraint is D1 row-writes (100k/day), not fetches. One full crawl pass over the tracked set is roughly 5,000. When demand outgrows the budget the collector stretches intervals across a `1 / 2 / 3 / 7`-day ladder rather than dropping pairs — flex frequency, never coverage, because a dropped pair loses its history for good.

## Docs

|  |  |
| --- | --- |
| [Deploying](docs/deploy.md) | Cloudflare resources, tracked set, GitHub Actions |
| [Credentials](docs/credentials.md) | Every secret, rotation, generating the Apple keys |
| [Access control](docs/access.md) | Basic auth, accounts, why 404 and not 403 |
| [MCP](docs/mcp.md) | Issuing tokens, the fourteen tools |
| [Architecture](docs/architecture.md) | Work loop, cadence, data model, R2 layout |

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

MIT
