# Deploying

Requirements: Node 24+, pnpm 11+, `wrangler login`, and accounts on both
Cloudflare and GitHub.

## Cloudflare resources

```sh
pnpm install

npx wrangler d1 create apprank
npx wrangler r2 bucket create apprank-archive
npx wrangler r2 bucket lifecycle add apprank-archive expire-verbatim "verbatim/" --expire-days 21
npx wrangler r2 bucket lifecycle add apprank-archive expire-staging "staging/" --expire-days 7
```

## Point the deployment at them

`wrangler.local.jsonc` is gitignored and wins over the committed placeholder
config in every script.

```sh
cp apps/collector/wrangler.jsonc apps/collector/wrangler.local.jsonc
cp apps/web/wrangler.jsonc apps/web/wrangler.local.jsonc
```

Paste your `database_id` into both, and set `APP_URL` in the web config.

## Schema, reference data, tracked set

```sh
pnpm migrate:remote
pnpm seed:remote      # storefronts, locales, cross-localization, genres

cp tracked.example.json tracked.local.json
#   …edit it: app id, language, storefronts, keywords

pnpm track            # shows what would change, writes nothing
pnpm track --apply
```

`tracked.local.json` is gitignored, so your app ids and keyword lists stay out
of the repository. `pnpm track` is idempotent and diff-first: re-running it
reports "already in sync" and writes nothing. Removing a keyword **retires** its
crawl pairs rather than deleting them, because a deleted day and an uncollected
day are the same loss.

One entry cannot mix languages: `language` stamps every keyword, records
`app_language`, and picks each storefront's locale. To track Spanish terms in
the Spanish store beside your English ones, list the same `appId` twice with
different `language` values.

## Secrets, then deploy

Both are required. Without the first the site answers 503 to everything; without
the second nothing can drive collection, including the workflow.

```sh
(cd apps/web       && npx wrangler secret put BASIC_AUTH_ACCOUNTS -c wrangler.local.jsonc)
(cd apps/collector && npx wrangler secret put ADMIN_TOKEN         -c wrangler.local.jsonc)

pnpm deploy
```

App Store Connect and Apple Ads are optional and have their own setup in
[credentials](credentials.md), which also covers rotation.

## Collection runs in two places

Both halves are required. The Worker takes App Store Connect and Apple Ads,
which Apple serves it without complaint, and sets `COLLECTION_MODE=credentialed`
so it queues only those. The workflow takes the public iTunes endpoints, which
Apple rate-limits per IP: a Worker gets 429 on every keyword search, at one
request per minute, while the same request from an ordinary connection succeeds.

Leaving the Worker in `all` mode is not free. Every 429 feeds the daily tally
that halves the learned crawl rate, so it degrades the signal deciding how often
each pair is checked.

The runner is not a second implementation. `wrangler dev` runs the same
collector source there, with `remote: true` on the D1 and R2 bindings, so
observations are identical whichever half fetched them. The Durable Object stays
local to each process; only the data is shared.

`scripts/local-refresh` runs the same cycle from your own machine, for
backfilling a day or verifying a credential.

## GitHub Actions secrets

Settings → Secrets and variables → Actions:

| Secret                  | Notes                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Needs **Workers Scripts: Edit** as well as D1 and R2. Remote bindings provision a proxy Worker, so a token scoped to storage alone fails with "the remote session could not be authenticated" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar                                                                                                                                                                  |
| `D1_DATABASE_ID`        | The `database_id` from your `wrangler.local.jsonc`                                                                                                                                            |
| `ADMIN_TOKEN`           | The same value as the collector's                                                                                                                                                             |

## Releasing

There is no release train: `main` is what runs. The Actions half deploys itself,
since every run checks out `main`, and the Worker half deploys with
`pnpm deploy`. The one thing to decide is `COLLECTOR_VERSION` in
`apps/collector/src/env.ts`.

That constant is provenance, not marketing. It is stamped on every `ranking` row
and every archived record, and it exists so a rebuild from R2 can tell which
normaliser wrote an observation. Bump it when a change alters what a stored
observation means: the normaliser, the result-list shape, the idempotency grain,
what counts as a throttle. Leave it alone for everything else; a bump on every
commit would make it say nothing.

```sh
#   …edit COLLECTOR_VERSION, commit
git tag -a v0.3.0 -m "Collector 0.3.0"
git push origin main --tags
pnpm deploy
```

Deploy in that order so the runner and the Worker never disagree on the version
for longer than one crawl. Both halves keep collecting through the deploy: a
Worker version change does not lose the Durable Object's queue, and the workflow
picks up the new code on its next run.
