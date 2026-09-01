---
paths:
  - "packages/core/src/schema/**"
  - "packages/core/migrations/**"
---

# Schema and migrations

User intent (`tracked_app`, `tracked_keyword`) is separate from what is
observed. The crawl unit is `crawl_pair`, the reference-counted union of
distinct `(keyword, storefront, locale)` triples, so two users tracking the same
keyword produce one fetch. A keyword is always tracked against a **(storefront,
locale)** pair because Apple cross-localizes (Canada indexes `en-CA` and
`fr-CA`; Belgium `en-GB`, `nl`, `fr`; Switzerland four locales). Which
storefronts matter follows the app's content language (`app_language`), not
market size. `app_localization` records "no localization for this storefront's
indexed locale" as a first-class state, because that gap is itself an ASO
finding. `ranking` stores the full ordered list of up to 200 track IDs as JSON
plus provenance; `rank_entry` indexes only the top 10 and any tracked app,
because a row per position would be 18× the write budget.

## Traps

- D1 rejects `BEGIN TRANSACTION` and `CREATE TEMP TABLE` with `SQLITE_AUTH`;
  Miniflare's D1 **does** enforce foreign keys, so seed parents first.
- `@cloudflare/workers-types` v5 dropped versioned entrypoints. Types come from
  `wrangler types` (generated `worker-configuration.d.ts`, gitignored). Because
  it is generated and not committed, **each app's `typecheck` regenerates it
  first** (`wrangler types && tsc`), because a clean checkout has no Workers
  globals and no bindings, so `tsc` answers
  `TS2304: Cannot find name 'D1Database'` roughly two hundred times. Generation
  needs no auth and no network, and it reads the committed `wrangler.jsonc`, so
  CI types match the deployed config rather than a local override; run
  `wrangler types -c wrangler.local.jsonc` when you want the local `APP_URL` in
  your editor. Cloudflare's other pattern, committing the file and gating it
  with `wrangler types --check`, trades a generated artefact in review diffs for
  the same guarantee, and was not taken.
- **There is one migration, and it is a dump, not a generate.** `0000_init.sql`
  was produced by `wrangler d1 export apprank --remote --no-data`, which
  serialises the live database rather than reconstructing it from `schema.ts`.
  That is the only way it carries `cr_unique_storefront_wide`, the partial
  unique index drizzle cannot express: `drizzle-kit export` emits fourteen
  indexes where production has fifteen. If the baseline ever needs rebuilding,
  rebuild it the same way and verify by applying it to an empty database and
  diffing that database's own export against production's. The nine incremental
  migrations it replaced were flattened before the repository went public. Among
  them was a create-then-drop pair for a session-based auth library that was
  tried and abandoned, because it took the web Worker from 84 KiB to 1,939 KiB
  to serve a handful of accounts that never change. Do not reach for one again
  unless self-service signup becomes a real requirement.
