# MCP

The dashboard's data is available to Claude Code over MCP at `/mcp` on the web
Worker. Streamable HTTP, no separate deployment.

**Off by default.** Set `MCP_ENABLED` to `"true"` in the web Worker's vars;
until then `/mcp` 404s. Publishing an agent endpoint should be a choice, not a
side effect of deploying someone else's repository. It buys back no bundle:
`agents` is imported statically, so `nodejs_compat` is required either way.

Never anonymous. Credentials live in their own `mcp_credential` table, checked
before any tool code is constructed, and are scoped to MCP alone: one will not
open the web API, and a browser account will not open MCP.

## Issue a credential

The token is printed once and only its SHA-256 is stored.

```sh
node scripts/mcp-token/issue.mjs --user admin --name laptop
# prints the token, the INSERT to apply, and the claude mcp add line
```

`--user` is the durable `userId` from `BASIC_AUTH_ACCOUNTS`, not the username.
`--name` tells two credentials apart later. Optional: `--days 365`, and
`--scopes` with any of `read:all`, `read:rankings`, `read:popularity`,
`read:metadata`, `read:charts`, `read:reviews`, `read:ratings`, `read:health`.

Connect at user scope, never a committed `.mcp.json`:

```sh
claude mcp add --scope user --transport http apprank \
  https://<your-app-url>/mcp \
  --header "Authorization: Bearer apprank_mcp_..."
```

Revoke or rotate, effective on the next call:

```sh
npx wrangler d1 execute apprank --remote -c wrangler.local.jsonc --command \
  "UPDATE mcp_credential SET revoked_at = unixepoch() * 1000 WHERE name = 'laptop'"
```

Rotation is a revoke plus a fresh issue under the same `--user`. `last_used_at`
and `call_count` make a forgotten credential findable, and every call is logged
to `mcp_tool_call` with the principal, tool, parameters, row count and duration.

## Tools

Fourteen, all read-only and all intent-shaped. There is deliberately no
`run_sql` or any other passthrough.

| Tool                         | Answers                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `whoami`                     | What this credential is allowed to do. Needs no scope           |
| `list_tracked_apps`          | The apps and storefronts this credential can read               |
| `get_keyword_report`         | The whole keyword-performance report for one app and storefront |
| `get_rank_history`           | Rank over a date range for one keyword                          |
| `get_current_rankings`       | Latest rank across every tracked pair, with staleness           |
| `get_competitors`            | Who holds a keyword's top ten, and how it turned over           |
| `get_chart_movement`         | Top-chart climbers, fallers, entries and exits                  |
| `get_keyword_popularity`     | Apple Ads search volume over time, absence included             |
| `get_metadata_changes`       | Releases and localization gaps, as rank-chart anchors           |
| `find_keyword_opportunities` | Keywords worth acting on, by lane and thresholds                |
| `get_search_results`         | The full ordered result page for one observation                |
| `get_reviews`                | Recent reviews, filtered by storefront and rating               |
| `get_ratings_history`        | Rating count and average over time                              |
| `get_collection_health`      | Whether today's numbers can be trusted                          |

Two behaviours matter more than the list.

**Every response describes its own holes**, in prose, in the body: observation
counts, date coverage, gap ranges and the errors behind them. Without that a
throttled week reads as a ranking collapse. Coverage is measured against each
pair's own cadence, so a keyword on a seven-day rung is not reported as missing
six days out of seven.

**Aggregates by default.** Series come back summarised (min, max, mean, median,
inflection points, an evenly-sampled curve), with `detail` for raw observations.
Every tool caps its rows and says when it truncated.

Per credential, 30 calls a minute and 2,000 a day: a runaway agent exhausts its
own allowance rather than the database's.
