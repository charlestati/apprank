---
paths:
  - "apps/web/src/**"
---

# The web Worker

## The MCP transport

`/mcp` on the web Worker serves the same data over MCP: stateless streamable
HTTP via `createMcpHandler` from `agents/mcp/server`. Not `McpAgent`, which is
the legacy path and needs a Durable Object this Worker has none of, which would
add state `scripts/rebuild-d1` could not reconstruct.

The transport itself _is_ optional: `MCP_ENABLED` must be `"true"` or `/mcp`
does not exist. `mcpEnabled()` in `mcp/server.ts` is the single predicate, and
both callers in `index.ts` ask it: the route and the Basic-auth exemption. They
have to move together: the exemption exists only to hand an anonymous request to
the bearer gate, so leaving it in place with the route switched off would turn
the one path that skips Basic into a path that skips authentication entirely.
`test/mcp-auth.test.ts` asserts both halves.

Four things hold it together, and none of them is optional once it is on:

- **The gate runs before the handler is built.** `handleMcp` authenticates, then
  constructs the server with the resolved principal closed over. Tool code is
  unreachable without a principal, so a misregistered tool is still not callable
  by a stranger, and no tool has to handle "who is this?" returning nothing.
- **MCP credentials are a separate table and a separate gate.** `mcp_credential`
  holds only the SHA-256 of the secret, unlike `BASIC_AUTH_ACCOUNTS`, which is a
  Worker secret and may hold plaintext; this is an ordinary D1 table that gets
  queried and dumped. The Basic middleware exempts `/mcp` deliberately: falling
  through would let a browser account drive the tools, which is the exact scope
  crossing the two credential types exist to prevent. `ALLOW_UNAUTHENTICATED`
  does **not** open MCP, because a dev flag that publishes an agent endpoint is
  a trap.
- **Ownership is the same function, not a copy.** Tools call the same
  `ownsApp`/`ownsPair` the routes call, and answer with an identical message
  whether a resource is absent or someone else's. The 404-not-403 rule, in tool
  form.
- **Every answer carries its own provenance.** `queries/coverage.ts` reports
  observation counts, gaps and the `fetch_error` windows behind them, in prose
  in the body. Without it Apple's 403-with-empty-results resurfaces at the
  analysis layer and a throttled week reads as a ranking collapse. Coverage is
  measured against each pair's `interval_hours`, never the calendar: a pair on a
  stretched rung is _supposed_ to have gaps, and counting those as missing days
  makes the whole signal useless.

`test/mcp-auth.test.ts` walks every scoped tool in a `SCOPED_TOOLS` list and
fails if one is added without a guard, the way `test/access.test.ts` does for
routes. `test/worker-config.test.ts` asserts `run_worker_first: true`, which is
the only reason `not_found_handling: single-page-application` cannot claim
`/mcp` or `/api`.

## Access control

HTTP Basic against a fixed set of accounts held in the `BASIC_AUTH_ACCOUNTS`
secret, a JSON array of `{ username, password, userId? }`. `userId` is the
durable identity: it is what `tracked_app.user_id` and the ownership checks
compare against, so passwords can rotate freely but changing a `userId`
re-points that person at a different set of apps. It defaults to the username.

Passwords are compared as SHA-256 digests in constant time. **Do not "improve"
this into bcrypt or scrypt**: a KDF would be the most expensive thing in the
request on the free tier's 10ms CPU budget, and these are machine-generated
high-entropy secrets, so there is no offline brute-force to slow down.

The Worker gates **the whole origin**, not just `/api`. A `fetch()` that
receives a 401 does not reliably make a browser show its credential prompt, so
protecting only the API would leave the page loading with every request failing
and no way to sign in. `run_worker_first: true` plus the `ASSETS` binding means
the HTML is behind the same wall, so an unauthenticated visitor never receives
the application at all. Asset requests therefore cost Worker invocations,
roughly one per page load.

It fails closed: no accounts configured means 503, never an implicit operator.
`ALLOW_UNAUTHENTICATED=true` re-opens it for local development only.
`/api/health` stays public so uptime checks work unauthenticated; it names no
app and no keyword.

Ownership is the second, separate check, and it is the one that keeps operators
apart:

- `src/access.ts` asks whether _this_ operator tracks the app or keyword being
  requested. Without it any authenticated user could read another's data by
  walking ids, which are guessable integers. `ownsApp`/`ownsPair` take
  `(db, userId, id)` rather than a request context, so a second transport
  enforces the rule by calling the same function instead of reimplementing it;
  `callerOwnsApp`/`callerOwnsPair` are the HTTP-shaped wrappers.
- A resource the caller does not own answers **404, not 403**, because a 403
  confirms the id exists, which is itself information about someone else's
  account.
- Ownership is on the tracked set, not the observations: `crawl_pair` is
  deliberately the union of what everyone tracks, so `ownsPair` asks whether the
  caller tracks that _keyword_.

When adding a route that takes an `:appId` or `:pairId`, add the `ownsApp` /
`ownsPair` guard. `test/access.test.ts` walks every scoped route and fails if
one is missed.

Basic auth has no sign-out: the browser holds the credentials until it is
closed. That is the trade for having no session tables and no auth dependency. A
session library costs roughly 1.9 MB of Worker bundle to serve a handful of
accounts that never change.

## Traps

- `apps/web` declares `nodejs_compat` because the MCP server's `agents` SDK
  imports `node:async_hooks`; without the flag the deploy fails outright with
  `No such module`. It costs bundle size, not runtime: the web Worker is ~766
  KiB against the collector's 83 KiB, so dropping MCP would let the flag go too.
  The flag also makes `wrangler types` ask for `@types/node`, which is installed
  and listed in that workspace's `tsconfig.json` `types` array; it would
  otherwise never load.
- **The web app's scarce resource is reads, not writes** (5M rows/day free). Its
  three "latest observation per pair" CTEs are bounded to 90 days: unbounded,
  they scan the whole `ranking` table on every dashboard load, and that table
  grows by one row per pair per day, so a year of history means ~45,000 rows
  read per page view and so ~110 views would exhaust the daily tier. Measured,
  not assumed: the obvious correlated-subquery rewrite reads _more_ today (400
  vs 50, being one index seek per pair against a small table) and only overtakes
  once the table passes ~400 rows.
