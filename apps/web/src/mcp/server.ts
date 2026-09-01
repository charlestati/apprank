// The MCP endpoint.
//
// Transport is streamable HTTP via `createMcpHandler`, the stateless entry.
// `McpAgent` would work too but is the legacy path, and it requires a Durable
// Object binding this Worker does not have and does not need: nothing about
// answering a read query is stateful, and a DO would add state that
// `scripts/rebuild-d1` could not reconstruct.
//
// The gate below runs *before* the handler is built. That ordering is the
// security property: tool code is unreachable without a resolved principal,
// so a tool registered by mistake is still not callable by a stranger.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod";

import type { Env } from "../env";
import { authenticateMcp, parseToken } from "./auth";
import type { AuthFailure, Principal } from "./auth";
import { audited } from "./logging";
import type { ToolContext } from "./logging";
import { referenceData } from "./reference";
import type { ReferenceData } from "./reference";
import {
	CAPS,
	findKeywordOpportunities,
	getChartMovement,
	getCollectionHealth,
	getCompetitors,
	getCurrentRankings,
	getKeywordPopularity,
	getKeywordReport,
	getMetadataChanges,
	getRankHistory,
	getRatingsHistory,
	getReviews,
	getSearchResults,
	listTrackedApps,
	whoami,
} from "./tools";

export const MCP_ROUTE = "/mcp";

/**
 * The transport is opt-in. Both callers in `index.ts`, the Basic-auth
 * exemption and the route itself, ask this same question, because an
 * exemption that outlived its route would leave `/mcp` reachable without any
 * gate at all.
 */
export function mcpEnabled(env: Env): boolean {
	return env.MCP_ENABLED === "true";
}

const SERVER_INFO = { name: "apprank", version: "1.0.0" };

/** ISO calendar day, the grain every observation is stored at. */
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/u, "Use an ISO calendar date, e.g. 2026-08-01.");

function storefrontSchema(reference: ReferenceData) {
	// Reference data is rows: with none seeded there is no enum to offer, and a
	// hard failure here would make the whole tool list unusable.
	return reference.storefronts.length > 0
		? z.enum(reference.storefronts as [string, ...string[]])
		: z.string();
}

function genreSchema(reference: ReferenceData) {
	return reference.genreIds.length > 0
		? z
				.number()
				.int()
				.refine((v) => reference.genreIds.includes(v), {
					message: "Not a genre this deployment tracks.",
				})
		: z.number().int();
}

function limitSchema(cap: number, what: string) {
	return z
		.number()
		.int()
		.min(1)
		.max(cap)
		.optional()
		.describe(
			`Maximum ${what} to return. Hard capped at ${cap}; the response says whether it truncated.`
		);
}

const detailSchema = z
	.enum(["summary", "daily"])
	.optional()
	.describe(
		"summary (default) returns aggregates and inflection points; daily returns every observation, still capped. Prefer summary: a year of daily ranks across many keywords will not fit in context."
	);

/**
 * Build the server for one request.
 *
 * `createMcpHandler` calls this per HTTP request by design, so registration
 * and
 * schema conversion are on the request path rather than at startup. Keep the
 * bodies out of here. They live in `tools.ts` and are only referenced.
 */
function buildServer(
	env: Env,
	ctx: ToolContext,
	reference: ReferenceData
): McpServer {
	const server = new McpServer(SERVER_INFO);
	const storefront = storefrontSchema(reference);

	server.registerTool(
		"whoami",
		{
			description:
				"Identify the credential making this call: which operator it belongs to, which scopes it carries, when it expires, and how much of today's call budget is left. Call this first when a tool is refused, to see what this credential is actually allowed to read. For the apps themselves, use list_tracked_apps.",
			inputSchema: z.object({}),
			title: "Who am I",
		},
		(args) => audited("whoami", null, whoami)(args, ctx)
	);

	server.registerTool(
		"list_tracked_apps",
		{
			description:
				"List the apps this credential tracks, with the storefronts each is tracked in and how many keywords per storefront. Every other app-scoped tool needs an appId from here.",
			inputSchema: z.object({}),
			title: "List tracked apps",
		},
		(args) =>
			audited("list_tracked_apps", "read:rankings", listTrackedApps)(args, ctx)
	);

	server.registerTool(
		"get_keyword_report",
		{
			description:
				"The keyword-performance report for one app in one storefront: summary statistics, opportunity lane counts (winning / within reach / blocked / vanity), metadata-change dates, and a row per tracked keyword with its rank, movement, popularity, difficulty and verdict. This is the broadest single view; start here for 'how is my ASO doing'.",
			inputSchema: z.object({
				appId: z.number().int().describe("From list_tracked_apps."),
				detail: z
					.enum(["summary", "rows"])
					.optional()
					.describe(
						"summary (default) omits per-day rank points and top-result lists; rows includes them and is much larger."
					),
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 30 days ago."),
				limit: limitSchema(CAPS.reports, "keyword rows"),
				storefront: storefront.describe("Two-letter storefront code, e.g. fr."),
				to: isoDate.optional().describe("Window end. Defaults to today."),
			}),
			title: "Keyword performance report",
		},
		(args) =>
			audited("get_keyword_report", "read:rankings", (a, c) =>
				getKeywordReport(a as never, c, env)
			)(args, ctx)
	);

	server.registerTool(
		"get_rank_history",
		{
			description:
				"Rank history for one keyword in one storefront over a date range. Identify the series either by pairId, or by keyword plus storefront. Returns min/max/mean/median, inflection points and an evenly-sampled series by default; detail:'daily' returns every observation. The response always reports its own coverage: gaps and error periods are named so a throttled week is not mistaken for a ranking collapse.",
			inputSchema: z.object({
				appId: z
					.number()
					.int()
					.optional()
					.describe(
						"Narrow to one app's position. Omit for the tracked app's own rank."
					),
				detail: detailSchema,
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 90 days ago."),
				keyword: z
					.string()
					.max(120)
					.optional()
					.describe(
						"Keyword text. Requires storefront. Alternative to pairId."
					),
				limit: limitSchema(CAPS.history, "observations"),
				pairId: z
					.number()
					.int()
					.optional()
					.describe("Crawl pair id, from get_current_rankings."),
				storefront: storefront.optional(),
				to: isoDate.optional(),
			}),
			title: "Rank history",
		},
		(args) =>
			audited("get_rank_history", "read:rankings", getRankHistory)(args, ctx)
	);

	server.registerTool(
		"get_current_rankings",
		{
			description:
				"Latest known rank of one app across every keyword and storefront it is tracked in, with each pair's crawl cadence and how many days old the observation is. Use this to get pairIds, and to see at a glance what is ranking now. A null position means observed but outside Apple's top 200, not a failed fetch.",
			inputSchema: z.object({
				appId: z.number().int(),
				limit: limitSchema(CAPS.keywords, "keyword rows"),
				storefront: storefront
					.optional()
					.describe("Omit for every storefront."),
			}),
			title: "Current rankings",
		},
		(args) =>
			audited(
				"get_current_rankings",
				"read:rankings",
				getCurrentRankings
			)(args, ctx)
	);

	server.registerTool(
		"get_competitors",
		{
			description:
				"Which apps hold the top ten for a keyword, and how that changed over a window. Summary gives each incumbent's days in the top ten, best and median position, and whether it entered or left during the window; detail:'daily' gives the full position timeline. Use this to see whether a keyword's leaderboard is entrenched or turning over.",
			inputSchema: z.object({
				detail: detailSchema,
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 30 days ago."),
				keyword: z.string().max(120).optional(),
				limit: limitSchema(CAPS.competitors, "rows"),
				pairId: z.number().int().optional(),
				storefront: storefront.optional(),
				to: isoDate.optional(),
			}),
			title: "Competitor movement on a keyword",
		},
		(args) =>
			audited("get_competitors", "read:rankings", getCompetitors)(args, ctx)
	);

	server.registerTool(
		"get_chart_movement",
		{
			description:
				"Top-chart movement for a storefront and optional genre over a window: who climbed, who fell, who entered and who dropped out, biggest movers first. This is market-level movement, independent of your tracked keywords. Omit genreId for the storefront-wide chart.",
			inputSchema: z.object({
				chart: z
					.enum(["free", "paid", "grossing"])
					.describe(
						"grossing comes only from the legacy RSS feed; the response names which endpoint served it."
					),
				from: isoDate.optional(),
				genreId: genreSchema(reference)
					.optional()
					.describe("iTunes genre id. Omit for the whole storefront."),
				limit: limitSchema(CAPS.chartMoves, "apps"),
				storefront,
				to: isoDate.optional(),
			}),
			title: "Top chart movement",
		},
		(args) =>
			audited("get_chart_movement", "read:charts", getChartMovement)(args, ctx)
	);

	server.registerTool(
		"get_keyword_popularity",
		{
			description:
				"Apple Ads search popularity over time for the keywords tracked against one app. Weekly, published about a week late, and covering only roughly the top 500 terms per storefront and top-level genre, so most long-tail keywords have no published volume. A point with present:false means Apple published nothing, which is absence of data and never a measurement of zero demand.",
			inputSchema: z.object({
				appId: z.number().int(),
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 180 days ago."),
				keyword: z
					.string()
					.max(120)
					.optional()
					.describe("Narrow to one keyword."),
				limit: limitSchema(CAPS.popularity, "keyword series"),
				storefront,
				to: isoDate.optional(),
			}),
			title: "Keyword popularity history",
		},
		(args) =>
			audited(
				"get_keyword_popularity",
				"read:popularity",
				getKeywordPopularity
			)(args, ctx)
	);

	server.registerTool(
		"get_metadata_changes",
		{
			description:
				"Metadata change events for one app: when the title, subtitle, version, price, in-app purchases, description, release notes, screenshots or icon changed, plus which indexed locales have no localization at all. These are the release anchors a rank move should be read against: a rank change without a metadata change nearby usually is not yours.",
			inputSchema: z.object({
				appId: z.number().int(),
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 180 days ago."),
				limit: limitSchema(CAPS.metadata, "change events"),
				to: isoDate.optional(),
			}),
			title: "Metadata changes",
		},
		(args) =>
			audited(
				"get_metadata_changes",
				"read:metadata",
				getMetadataChanges
			)(args, ctx)
	);

	server.registerTool(
		"find_keyword_opportunities",
		{
			description:
				"Surface the keywords worth acting on for one app: filter by opportunity lane (winning, close, blocked, vanity, dormant, unknown), minimum published popularity and maximum difficulty. Returns the reason behind each verdict and the thresholds that produced it, so the judgement can be argued with. Brand keywords are excluded by default because you should already rank first on your own name.",
			inputSchema: z.object({
				appId: z.number().int(),
				includeBrand: z
					.boolean()
					.optional()
					.describe(
						"Include keywords matching the app's own name. Default false."
					),
				lane: z
					.enum(["winning", "close", "blocked", "vanity", "dormant", "unknown"])
					.optional()
					.describe(
						"close = within reach of the visible zone on a term with volume; blocked = real volume but entrenched incumbents; vanity = ranked where nobody searches; unknown = ranked but Apple publishes no volume."
					),
				limit: limitSchema(CAPS.opportunities, "keywords"),
				maxDifficulty: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe(
						"0-100. Above 80 metadata alone will not move the incumbents."
					),
				minPopularity: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe(
						"1-100 Apple Ads scale. 5 is the floor for measurable volume, 30 is a head term. Keywords with no published volume are excluded when this is set."
					),
				storefront,
			}),
			title: "Find keyword opportunities",
		},
		(args) =>
			audited("find_keyword_opportunities", "read:rankings", (a, c) =>
				findKeywordOpportunities(a as never, c, env)
			)(args, ctx)
	);

	server.registerTool(
		"get_search_results",
		{
			description:
				"The full ordered result page Apple returned for one keyword on one date: every app in position order, named where we have met it before. Use this to see who actually occupies a keyword's page rather than just the top ten.",
			inputSchema: z.object({
				date: isoDate
					.optional()
					.describe("Defaults to the most recent valid observation."),
				limit: limitSchema(CAPS.results, "result positions"),
				pairId: z.number().int(),
			}),
			title: "Search result page",
		},
		(args) =>
			audited(
				"get_search_results",
				"read:rankings",
				getSearchResults
			)(args, ctx)
	);

	server.registerTool(
		"get_reviews",
		{
			description:
				"Recent App Store reviews for one app, optionally filtered by storefront and star rating. This is a recency sample from Apple's public feed, never the full review history.",
			inputSchema: z.object({
				appId: z.number().int(),
				limit: limitSchema(CAPS.reviews, "reviews"),
				maxRating: z.number().int().min(1).max(5).optional(),
				minRating: z.number().int().min(1).max(5).optional(),
				storefront: storefront.optional(),
			}),
			title: "Reviews",
		},
		(args) => audited("get_reviews", "read:reviews", getReviews)(args, ctx)
	);

	server.registerTool(
		"get_ratings_history",
		{
			description:
				"Rating count and average over time for one app, per storefront. Summary gives the change in rating count across the window and the latest average; detail:'daily' gives every snapshot. A flat average with a rising count is normal, because Apple's average is lifetime rather than per day.",
			inputSchema: z.object({
				appId: z.number().int(),
				detail: detailSchema,
				from: isoDate
					.optional()
					.describe("Window start. Defaults to 90 days ago."),
				limit: limitSchema(CAPS.ratings, "snapshots"),
				storefront: storefront.optional(),
				to: isoDate.optional(),
			}),
			title: "Ratings history",
		},
		(args) =>
			audited(
				"get_ratings_history",
				"read:ratings",
				getRatingsHistory
			)(args, ctx)
	);

	server.registerTool(
		"get_collection_health",
		{
			description:
				"Whether today's numbers can be trusted. Without appId: collector pacing, the cadence plan, loop liveness, the last daily run, overdue pairs and error classes for the last 24 hours. With appId: per-pair coverage for that app's keywords over a window: observed versus expected observations, gap ranges, and the error periods behind them. Call this before drawing a conclusion from a rank movement.",
			inputSchema: z.object({
				appId: z
					.number()
					.int()
					.optional()
					.describe("Adds per-pair coverage for this app's tracked keywords."),
				from: isoDate
					.optional()
					.describe("Coverage window start. Defaults to 30 days ago."),
				to: isoDate.optional(),
			}),
			title: "Collection health and coverage",
		},
		(args) =>
			audited(
				"get_collection_health",
				"read:health",
				getCollectionHealth
			)(args, ctx)
	);

	return server;
}

const FAILURE_STATUS: Record<AuthFailure, number> = {
	expired: 401,
	malformed: 401,
	missing: 401,
	rate_limited: 429,
	revoked: 401,
	unknown: 401,
};

const FAILURE_MESSAGE: Record<AuthFailure, string> = {
	expired: "credential expired",
	malformed: "malformed credential",
	missing: "missing credential",
	rate_limited: "daily call budget exhausted for this credential",
	revoked: "credential revoked",
	unknown: "unknown credential",
};

function unauthorized(reason: AuthFailure): Response {
	return Response.json(
		{ error: FAILURE_MESSAGE[reason] },
		{
			headers:
				FAILURE_STATUS[reason] === 401
					? { "WWW-Authenticate": 'Bearer realm="AppRank MCP"' }
					: {},
			status: FAILURE_STATUS[reason],
		}
	);
}

/**
 * Authenticate, then serve.
 *
 * The handler is constructed per request because the tool bodies close over
 * the resolved principal. That is deliberate: passing the principal through
 * ambient context would make "which operator is this?" a lookup that could
 * return nothing, and every tool would have to handle that case. Closing over
 * it makes the absence unrepresentable.
 */
export async function handleMcp(
	request: Request,
	env: Env,
	// Structural, not `ExecutionContext`: the audit write is the only thing this
	// needs, and Hono's context type and the Workers global disagree on the
	// generic parameter.
	executionCtx: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<Response> {
	const header = request.headers.get("Authorization");

	// Burst brake first, keyed on the credential id alone. It is the public half
	// of the token, so this costs nothing and reveals nothing. Refusing
	// here means a hot retry loop never reaches D1, and cannot spend the write
	// allowance on being told no.
	const identified = parseToken(header);
	if (identified && env.MCP_RATE_LIMIT) {
		const { success } = await env.MCP_RATE_LIMIT.limit({
			key: identified.id,
		});
		if (!success) {
			return unauthorized("rate_limited");
		}
	}

	const outcome = await authenticateMcp(env.DB, header);
	if (!outcome.ok) {
		return unauthorized(outcome.reason);
	}

	const principal: Principal = outcome.principal;
	const ctx: ToolContext = {
		db: env.DB,
		principal,
		waitUntil: (promise) => executionCtx.waitUntil(promise),
	};
	const reference = await referenceData(env.DB);

	const handler = createMcpHandler(() => buildServer(env, ctx, reference), {
		route: MCP_ROUTE,
	});
	return handler.fetch(request);
}
