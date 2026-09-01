# MCP

The same data the dashboard shows is available to Claude Code over MCP, at `/mcp` on the same Worker — streamable HTTP, no separate deployment.

**It is off by default.** Set `MCP_ENABLED` to `"true"` in the web Worker's vars to turn it on; until then `/mcp` 404s and no agent endpoint exists. Publishing one should be a choice, not something that happens because you deployed someone else's repository. Switching it off does not shrink the bundle — the `agents` SDK is imported statically and `nodejs_compat` is required either way.

It is never anonymous. The endpoint has its own credential type, stored in the `mcp_credential` table and checked before any tool code is constructed. A credential is scoped to MCP alone: it will not open the web API, and a browser account will not open MCP.

## Issue a credential

The token is printed once and only its SHA-256 is stored.

```sh
node scripts/mcp-token/issue.mjs --user admin --name laptop
# prints the token, the INSERT to apply, and the claude mcp add line
```

`--user` is the durable `userId`, the same value as in `BASIC_AUTH_ACCOUNTS` and `tracked_app.user_id` — not the username. `--name` is how you tell two credentials apart later. Optional flags: `--days 365`, `--scopes read:all` (or a comma-separated subset: `read:rankings`, `read:popularity`, `read:metadata`, `read:charts`, `read:reviews`, `read:ratings`, `read:health`).

Connect it at user scope — never a committed `.mcp.json`, if your repository is public:

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

Rotation is a revoke plus a fresh issue under the same `--user`. `last_used_at` and `call_count` on each row are there so a credential you have forgotten about is findable, and every tool call is recorded in `mcp_tool_call` with the principal, the tool, its parameters, the row count and the duration.

## Tools

Fourteen, all read-only and all intent-shaped — there is deliberately no `run_sql` or any other passthrough.

| Tool | Answers |
| --- | --- |
| `whoami` | What this credential is allowed to do. Needs no scope |
| `list_tracked_apps` | The apps and storefronts this credential can read |
| `get_keyword_report` | The whole keyword-performance report for one app and storefront |
| `get_rank_history` | Rank over a date range for one keyword |
| `get_current_rankings` | Latest rank across every tracked pair, with staleness |
| `get_competitors` | Who holds a keyword's top ten, and how it turned over |
| `get_chart_movement` | Top-chart climbers, fallers, entries and exits |
| `get_keyword_popularity` | Apple Ads search volume over time, absence included |
| `get_metadata_changes` | Releases and localization gaps, as rank-chart anchors |
| `find_keyword_opportunities` | Keywords worth acting on, by lane and thresholds |
| `get_search_results` | The full ordered result page for one observation |
| `get_reviews` | Recent reviews, filtered by storefront and rating |
| `get_ratings_history` | Rating count and average over time |
| `get_collection_health` | Whether today's numbers can be trusted |

Two behaviours matter more than the list.

**Every response describes its own holes.** Answers carry observation counts, actual date coverage, gap ranges and the error periods behind them. Apple's throttle returns HTTP 403 with an empty result array, so a rate-limited week looks exactly like a ranking collapse unless the answer says otherwise — and it does, in prose, in the body. Coverage is measured against each pair's own crawl cadence, so a keyword on a stretched seven-day rung is not reported as missing six days out of seven.

**Aggregates by default.** Series come back summarised — min, max, mean, median, inflection points and an evenly-sampled curve — with `detail` to opt into raw observations. Every tool caps its rows and tells you when it truncated.

Two limits are enforced per credential and independently of anything user-facing: a burst limit of 30 calls a minute, and a daily budget of 2,000 tool calls. A runaway agent exhausts its own allowance rather than the database's.
