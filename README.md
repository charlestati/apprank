# AppRank

> Self-hosted App Store Optimization tracking for your apps. Runs free on
> Cloudflare Workers and GitHub Actions.

## Features

- **Daily keyword ranks 📈** - The whole top 200 per keyword and storefront,
  with your own releases pinned to the chart so you can see what moved. Releases
  are detected from your listing; there is nothing to enter.
- **Competitors 🥊** - Who ranks above you, and how many days each one held the
  top ten.
- **Difficulty and search volume 🎯** - Difficulty scored from the live result
  page, volume from Apple Ads wherever Apple publishes it.
- **Ratings, reviews and top charts 📊** - Per storefront, daily.
- **Free 💸** - Cloudflare Workers, D1 and R2 plus a daily GitHub Actions run,
  all on the free tiers.
- **Agent-ready 🤖** - An MCP endpoint for AI agents. Opt-in and experimental.

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
