import { Hono } from "hono";

import { callerOwnsApp, callerOwnsPair, notFound } from "./access";
import type { Vars } from "./access";
import { authenticate, challenge, parseAccounts } from "./basic-auth";
import type { Env } from "./env";
import { MCP_ROUTE, handleMcp, mcpEnabled } from "./mcp/server";
import {
	appKeywords,
	appLocalizations,
	appRatings,
	appReviews,
	appStorefronts,
	listApps,
} from "./queries/apps";
import { dataHealth } from "./queries/health";
import {
	pairCompetitors,
	pairHistory,
	pairResultPage,
	sinceDate,
} from "./queries/rankings";
import { listSuggestions, setSuggestionStatus } from "./queries/suggestions";
import { buildReport } from "./report";

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Clamp a query-string number into the range the query can actually serve.
 *
 * The finite check is the point: `Number("abc")` is NaN, and NaN survives both
 * Math.max and Math.min unchanged, so an unguarded clamp returns NaN and the
 * caller happily builds a date from it. `sinceDate(NaN)` throws `RangeError:
 * Invalid time value` and the route answers 500. A junk value in
 * a query string is a client mistake, not a server fault: fall back to the
 * default and serve the page.
 */
function bounded(raw: string | undefined, fallback: number, max: number) {
	const n = Number(raw ?? fallback);
	return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
}

// Liveness probe, deliberately public and deliberately dull: it names no app
// and no keyword, only whether the reference data loaded.
api.get("/health", async (c) => {
	const row = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM storefront WHERE active = 1"
	).first<{ n: number }>();
	return c.json({ activeStorefronts: row?.n ?? 0, ok: true });
});

/** Who the current credentials belong to, for the header. */
api.get("/me", (c) => c.json({ userId: c.get("userId") }));

api.get("/health/data", async (c) =>
	c.json(await dataHealth(c.env.DB, c.get("userId")))
);

api.get("/apps", async (c) => {
	const rows = await listApps(c.env.DB, c.get("userId"));
	return c.json(rows.results);
});

// The storefronts an app is actually tracked in, for the report's picker.
api.get("/apps/:appId/storefronts", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const rows = await appStorefronts(c.env.DB, c.get("userId"), appId);
	return c.json(rows.results);
});

// The keyword-performance report: summary tiles, chart series and table rows
// in one request, so the page paints from a single round trip.
api.get("/apps/:appId/report", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const report = await buildReport(c.env, {
		appId,
		days: bounded(c.req.query("days"), 30, 400),
		storefront: c.req.query("storefront") ?? "fr",
		userId: c.get("userId"),
	});
	return c.json(report);
});

// The full result page behind one observation: every app Apple returned, in
// order.
api.get("/pairs/:pairId/results", async (c) => {
	const pairId = Number(c.req.param("pairId"));
	if (!(await callerOwnsPair(c, pairId))) {
		return notFound(c);
	}
	return c.json(await pairResultPage(c.env.DB, pairId, c.req.query("date")));
});

/** RFC 4180: quote a field only when it contains a delimiter or a quote. */
function csvEscape(value: string | number | null): string {
	if (value === null) {
		return "";
	}
	const text = String(value);
	return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// CSV of the current report, for the spreadsheet the numbers usually end up
// in.
api.get("/apps/:appId/report.csv", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const storefront = c.req.query("storefront") ?? "fr";
	const report = await buildReport(c.env, {
		appId,
		days: bounded(c.req.query("days"), 30, 400),
		storefront,
		userId: c.get("userId"),
	});

	const header = [
		"keyword",
		"storefront",
		"position",
		"change",
		"change_days_ago",
		"best",
		"worst",
		"popularity",
		"difficulty",
		"difficulty_sample_size",
		"results_total",
		"top_results",
	];
	const lines = [header.join(",")];
	for (const row of report.rows) {
		lines.push(
			[
				row.keyword,
				report.storefront,
				row.position,
				row.change,
				row.changeDaysAgo,
				row.best,
				row.worst,
				row.popularity,
				row.difficulty?.score ?? null,
				row.difficulty?.sampleSize ?? null,
				row.resultCount,
				row.topResults.map((r) => r.name).join(" | "),
			]
				.map((v) => csvEscape(v as string | number | null))
				.join(",")
		);
	}

	return new Response(`${lines.join("\n")}\n`, {
		headers: {
			"Content-Disposition": `attachment; filename="apprank-${storefront}-${report.dates.at(-1) ?? "report"}.csv"`,
			"Content-Type": "text/csv; charset=utf-8",
		},
	});
});

// Keyword table: latest rank of the tracked app per (keyword, storefront),
// plus latest popularity. One request powers the main dashboard grid.
api.get("/apps/:appId/keywords", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const rows = await appKeywords(c.env.DB, c.get("userId"), appId);
	return c.json(rows.results);
});

// Rank history for one pair (optionally for one app; default = the tracked
// app's position).
api.get("/pairs/:pairId/history", async (c) => {
	const pairId = Number(c.req.param("pairId"));
	if (!(await callerOwnsPair(c, pairId))) {
		return notFound(c);
	}
	const days = bounded(c.req.query("days"), 90, 400);
	const appId = c.req.query("appId") ? Number(c.req.query("appId")) : null;
	const rows = await pairHistory(c.env.DB, pairId, sinceDate(days), appId);
	return c.json(rows.results);
});

// Top-10 competitor timeline for a pair.
api.get("/pairs/:pairId/competitors", async (c) => {
	const pairId = Number(c.req.param("pairId"));
	if (!(await callerOwnsPair(c, pairId))) {
		return notFound(c);
	}
	const days = bounded(c.req.query("days"), 30, 120);
	const rows = await pairCompetitors(c.env.DB, pairId, sinceDate(days));
	return c.json(rows.results);
});

api.get("/apps/:appId/reviews", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const rows = await appReviews(c.env.DB, appId, c.req.query("storefront"));
	return c.json(rows.results);
});

api.get("/apps/:appId/ratings", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const rows = await appRatings(c.env.DB, appId);
	return c.json(rows.results);
});

// Localization gap panel: which indexed locales lack a localization.
api.get("/apps/:appId/localizations", async (c) => {
	const appId = Number(c.req.param("appId"));
	if (!(await callerOwnsApp(c, appId))) {
		return notFound(c);
	}
	const rows = await appLocalizations(c.env.DB, appId);
	return c.json(rows.results);
});

api.get("/suggestions", async (c) => {
	const rows = await listSuggestions(c.env.DB, c.get("userId"));
	return c.json(rows.results);
});

api.patch("/suggestions/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const { status } = (await c.req.json()) as { status: string };
	if (status !== "accepted" && status !== "dismissed") {
		return c.json({ error: "status must be accepted|dismissed" }, 400);
	}
	const changed = await setSuggestionStatus(
		c.env.DB,
		c.get("userId"),
		id,
		status
	);
	if (changed === 0) {
		return notFound(c);
	}
	// Acceptance side-effects (creating tracking rows) arrive with the Tier-2
	// sweep that generates these suggestions.
	return c.json({ ok: true });
});

/**
 * The Worker gates the whole origin, not just /api.
 *
 * A `fetch()` that gets a 401 does not reliably make a browser show its
 * credential prompt, so protecting only the API would leave the page loading
 * and every request failing with no way to sign in. Gating the HTML too means
 * the browser asks once, then attaches the header to everything, including the
 * API calls the page makes.
 *
 * It also means the app is not merely walled at the data layer: an
 * unauthenticated visitor never receives the application at all.
 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", async (c, next) => {
	const { pathname } = new URL(c.req.url);
	// The probe answers before anything else, so an uptime check keeps working
	// whether or not the accounts are configured yet.
	if (pathname === "/api/health") {
		return next();
	}

	// The MCP endpoint carries its own credential type and its own gate, and it
	// deliberately does not accept Basic. Falling through to the wall here would
	// do the opposite of what it looks like: it would let a browser account drive
	// the MCP tools, which is exactly the scope crossing the two credential types
	// exist to prevent. The bearer gate runs in the route handler below and
	// rejects an anonymous request before any tool code is constructed.
	//
	// Withdrawn when the transport is switched off: with no bearer gate waiting
	// downstream, an exemption would be a hole rather than a handover.
	if (pathname === MCP_ROUTE && mcpEnabled(c.env)) {
		return next();
	}

	const accounts = parseAccounts(c.env.BASIC_AUTH_ACCOUNTS);

	if (accounts.length === 0) {
		// Fail closed. An unconfigured deployment serves nothing, because the
		// alternative, an implicit operator, publishes one person's competitive
		// position to anyone who finds the URL.
		if (c.env.ALLOW_UNAUTHENTICATED === "true") {
			// Local development only. The identity is configurable because ownership
			// is checked against `tracked_app.user_id`, and a hardcoded name silently
			// shows an empty dashboard the moment the operator's id is anything else.
			c.set("userId", c.env.DEV_USER_ID ?? "admin");
			return next();
		}
		return c.json(
			{ error: "auth not configured", hint: "set BASIC_AUTH_ACCOUNTS" },
			503
		);
	}

	const outcome = await authenticate(
		c.req.header("Authorization") ?? null,
		accounts
	);
	if (!outcome.ok) {
		return c.json({ error: "unauthorized" }, 401, challenge());
	}
	c.set("userId", outcome.userId as string);
	return next();
});

// Mounted ahead of the SPA fallback, and reachable only through its own bearer
// gate. `run_worker_first` is true, so the assets binding never sees this path
// first and `not_found_handling` cannot claim it; `test/mcp-auth.test.ts`
// asserts that setting so the guarantee is enforced rather than remembered.
app.all(MCP_ROUTE, async (c) => {
	// Opt-in: a deployment that never asked for an agent endpoint does not get
	// one. This is reached only by an authenticated caller, because the Basic
	// exemption above is withdrawn in the same breath.
	if (!mcpEnabled(c.env)) {
		return c.notFound();
	}

	// `c.executionCtx` throws when the Worker is invoked without one. The audit
	// write is the only thing that wants it, and losing the deferral must never
	// cost the request, so fall back to awaiting the write inline rather than
	// failing the call or, worse, dropping the record.
	const pending: Promise<unknown>[] = [];
	const waitUntil = (promise: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(promise);
		} catch {
			pending.push(promise);
		}
	};
	const res = await handleMcp(c.req.raw, c.env, { waitUntil });
	await Promise.allSettled(pending);
	return res;
});

app.route("/api", api);

// Everything else is the single-page app, served from the assets binding once
// the request is authenticated.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
