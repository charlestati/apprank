# AppRank: working notes for agents

Self-hosted App Store Optimization tracking on Cloudflare's free tier. It
collects App Store keyword ranks, Apple Ads search popularity, app metadata
changes, ratings and reviews, then presents them as a keyword-performance
report. The repository is public, so nothing personal belongs in it.

This file holds what applies everywhere. Anything that matters only in one part
of the tree lives in `.claude/rules/`, which loads when you open a file it
covers:

| Rule           | Loads when you touch                                        | Covers                                                       |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `collector.md` | `apps/collector/**`                                         | The work loop, pacing, cadence, tracking a new app           |
| `apple.md`     | `packages/core/src/apple/**`, `apps/collector/src/tasks/**` | What each Apple API does and refuses to do                   |
| `web.md`       | `apps/web/src/**`                                           | The MCP transport, access control, read budget               |
| `dashboard.md` | `apps/web/client/**`                                        | What the report is for, and what the chart must not collapse |
| `schema.md`    | `packages/core/src/schema/**`, `migrations/**`              | The data model, the single baseline migration                |
| `testing.md`   | `**/test/**`                                                | Workers-pool quirks                                          |

`README.md` is the pitch and quick start. `docs/` holds the operator guides:
`deploy`, `credentials`, `access`, `mcp`, `limits`, `architecture`.

## The five invariants

Everything in the design follows from these. Check a change against them before
writing it.

1. **History cannot be backfilled.** A day not collected is gone forever. The
   collector ships and runs before any feature work; never break collection to
   land UI.
2. **R2 is the source of truth; D1 is a rebuildable materialised view.**
   Pruning, retention and schema changes must stay performance choices, never
   lossy ones. `scripts/rebuild-d1` reconstructs the observation tables from the
   archive alone and is a first-class deliverable.
3. **Visible gaps beat silent garbage.** Every observation carries provenance
   (HTTP status, response time, result count, collector version, archive key).
   Apple's rate limit returns **HTTP 403 with an empty results array**. That is
   throttling, and it must never be stored as "the app is not ranking". Failures
   go to `fetch_error`; charts render gaps as gaps.
4. **Politeness is correctness.** All Workers egress shares Cloudflare IPs and
   Apple rate-limits per IP, so the crawler discovers its own sustainable rate
   and backs off hard. Never raise the fetch rate to make something finish
   faster. When demand exceeds the budget, stretch intervals: **flex frequency,
   never coverage**, because dropping a pair destroys its history permanently.
5. **Reference data is rows, not code.** Adding a storefront, locale, genre or
   keyword is an `INSERT`. If a change would require a migration or redeploy to
   track one more keyword, it is the wrong change.

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

`wrangler.jsonc` is committed with placeholder ids. Every script prefers
`wrangler.local.jsonc` (gitignored) when present. That is where real
`database_id` and `APP_URL` values live. Personal seeds live in
`packages/core/seeds/local/` (also gitignored).

## Conventions

- **pnpm only** (v11, workspace protocol). `pnpm-workspace.yaml` sets
  `minimumReleaseAge: 10080`, so packages must be a week old, so pick versions
  accordingly or the install fails with `ERR_PNPM_NO_MATCHING_VERSION`.
- **`fetch_error.error_class` is a closed vocabulary, never a message.** The
  data-health page groups on it, so a raw upstream body there becomes its own
  one-row "class" and buries the counts. Put the body in `message` (wide enough
  to diagnose) and pick a class: `throttled`, `rate_limited`, `http_error`,
  `invalid_body`, `upstream_error`, `task_threw`, `app_not_in_storefront`,
  `pull_abandoned`.
- **Comments explain constraints**, not mechanics: why a limit exists, what
  Apple does, why a branch is unreachable. No "this line does X" narration.
- **The API returns raw column names** for legacy endpoints and camelCase for
  the newer report endpoint; do not "harmonise" one into the other without
  updating both the client types and the tests.
- **Route handlers hold no SQL.** Every query lives in `apps/web/src/queries/*`
  as a plain `(db, params)` function and the handler parses, guards ownership,
  and calls it. That is what lets a second transport reuse a query instead of
  copying it, and it keeps one place to change when a column moves.
- **The dashboard follows the Appfigures keyword-performance layout** (sidebar,
  filter bar, three summary tiles, multi-series inverted rank chart, dense
  grouped-header table) styled with **Atlassian Design System tokens**, defined
  as CSS variables in `apps/web/client/src/theme.css`.

## Traps that apply anywhere

- **`agents` pulls `core-js-pure`, whose build script must be answered.** The
  chain is `agents` → `mimetext` → `@babel/runtime-corejs3`. pnpm refuses to
  install with an unanswered build script, and every command including
  `pnpm generate` then fails with `ERR_PNPM_IGNORED_BUILDS`. It is denied in
  `pnpm-workspace.yaml`, not approved: nothing imports it and its postinstall
  only prints an Open Collective funding notice.
- **`minimumReleaseAge: 10080` outranks "latest".** Anything published inside
  the last week fails it, `agents@0.22.0` and `zod@4.5.x` among them at the time
  of writing. Pinned: `agents@0.21.0`, `zod@4.4.3`,
  `@modelcontextprotocol/{server,client}@2.0.0`,
  `@modelcontextprotocol/sdk@1.30.0` (the peer `agents` names). Check publish
  dates before bumping any of them.
- `config` cannot be a package.json script name: `pnpm config` is a built-in.
- macOS is case-insensitive; renaming `Foo.tsx` → `foo.tsx` leaves the old path
  in the git index and breaks Linux CI. `git config core.ignorecase false` and
  re-add.
- The ultracite vitest preset applies rules inside its own override block, which
  beats top-level `rules` in `oxlint.config.ts`. Test-specific relaxations must
  therefore be justified `/* oxlint-disable … -- reason */` headers in the test
  files.

- **A backtick inside a SQL comment terminates the template literal it lives
  in**, and `*/` inside a JSDoc block closes it early. Name tables and cron
  expressions in prose inside those comments, not in backticks.
