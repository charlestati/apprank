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

## Apple blocks Cloudflare, so collection runs from GitHub Actions

The one thing to know before deploying. Apple rate-limits the public iTunes
endpoints per IP, and every Cloudflare Worker egresses from a shared pool that
is already spent: the deployed collector gets HTTP 429 on **every** keyword
search, while the identical request from an ordinary connection succeeds. That
is not a volume problem — it happens at one request per minute.

So the fetching runs somewhere else, and `.github/workflows/collect.yml` is that
somewhere. It starts `wrangler dev` on a runner with `remote: true` bindings,
which means the **same collector code** executes against the same D1 and R2 —
only the source address differs. Observations carry the same normaliser, the
same provenance and the same idempotent keys as the scheduler's own.

Cloudflare still runs App Store Connect and Apple Ads, which are credentialed,
reached over different infrastructure, and work fine from a Worker. The
deployment sets `COLLECTION_MODE=credentialed` so it stops attempting the
fetches it cannot complete — those 429s were not free, each one fed the daily
tally that halves the learned crawl rate.

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
