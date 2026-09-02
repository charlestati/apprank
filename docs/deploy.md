# Deploying

Requirements: Node 24+, pnpm 11+, a Cloudflare account, `wrangler login`.

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

pnpm deploy
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

## Collection runs in two places

This is the architecture, not a workaround, and both halves are required.

The **Cloudflare Worker** collects what it can reach: App Store Connect and
Apple Ads, both credentialed and served to a Worker without complaint. It sets
`COLLECTION_MODE=credentialed` so it queues only those.

**`.github/workflows/collect.yml`** collects the public iTunes endpoints:
keyword ranks, metadata lookups, ratings, reviews and charts. Apple rate-limits
those per IP, and every Cloudflare Worker egresses from a shared pool that is
already spent, so a Worker gets HTTP 429 on **every** keyword search while the
identical request from an ordinary connection succeeds. That is not a volume
problem. It happens at one request per minute.

The runner is not a second implementation. It runs the **same collector source**
under `wrangler dev`, with `remote: true` on the D1 and R2 bindings, so
observations carry the same normaliser, provenance and idempotent keys as the
Worker's own.

Two processes, not one runtime in two places: the collector executes on the
runner, and only the data bindings reach Cloudflare. The Durable Object is local
to each, so the runner builds its own work queue, while the learned rate and the
pause it obeys live in `collector_state` in the shared D1.

Leaving the Worker in `all` mode is not free: every 429 it collects feeds the
daily tally that halves the learned crawl rate, so a Worker attempting the
public endpoints degrades the signal that decides how often each pair is
checked.

`scripts/local-refresh` runs the same cycle from your own machine, which is
useful for backfilling a day or verifying a credential.

## GitHub Actions secrets

Settings → Secrets and variables → Actions:

| Secret                  | Notes                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Needs **Workers Scripts: Edit** as well as D1 and R2. Remote bindings provision a proxy Worker, so a token scoped to storage alone fails with "the remote session could not be authenticated" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar                                                                                                                                                                  |
| `D1_DATABASE_ID`        | The `database_id` from your `wrangler.local.jsonc`                                                                                                                                            |
| `ADMIN_TOKEN`           | The same value as the collector's                                                                                                                                                             |
