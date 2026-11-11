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
	deletePreference,
	isPreferenceKey,
	listPreferences,
	putPreference,
} from "./queries/preferences";
import {
	pairCompetitors,
	pairFetchErrors,
	pairHistory,
	pairResultPage,
	sinceDate,
	trackedAppsForPair,
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
	// An empty value is absent, not zero: `Number("")` is 0, which clamped to a
	// one-day window instead of the default.
	const n = Number(raw?.trim() ? raw : fallback);
	return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
}

// A preference is a chart selection at most: four pair ids as JSON. The cap is
// here so a stored preference cannot become a place to park arbitrary text in
// someone else's database.
const PREFERENCE_MAX = 2000;

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

// The reader's own choices: which app the switcher landed on, the UI language,
// and the keywords on the chart. Every row is keyed by the caller's user id, so
// there is nothing here another account can reach and no ownership check to
// make.
//
// Returned whole rather than one key at a time: the shell needs the app and the
// language before it paints, and a request each would put two round trips in
// front of the first frame.
api.get("/preferences", async (c) => {
	const rows = await listPreferences(c.env.DB, c.get("userId"));
	const out: Record<string, string> = {};
	for (const row of rows.results) {
		out[row.key] = row.value;
	}
	return c.json(out);
});

api.put("/preferences/:key", async (c) => {
	const key = c.req.param("key");
	// The key is as much a place to park text as the value is, and it arrives
	// in the path: only the keys the interface writes are stored.
	if (!isPreferenceKey(key)) {
		return c.json({ error: "unknown preference" }, 400);
	}
	const body = await c.req
		.json<{ value?: unknown }>()
		.catch((): { value?: unknown } => ({}));
	// An absent value clears the preference, which is how a reader goes back to
	// the default rather than pinning whichever default they first happened to
	// see.
	if (typeof body.value !== "string") {
		await deletePreference(c.env.DB, { key, userId: c.get("userId") });
		return c.body(null, 204);
	}
	if (body.value.length > PREFERENCE_MAX) {
		return c.json({ error: "value too long" }, 400);
	}
	const stored = await putPreference(c.env.DB, {
		key,
		userId: c.get("userId"),
		value: body.value,
	});
	if (!stored) {
		return c.json({ error: "too many preferences" }, 400);
	}
	return c.body(null, 204);
});

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
	return c.json(await appStorefronts(c.env.DB, c.get("userId"), appId));
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

/**
 * RFC 4180 quoting, plus formula neutralisation.
 *
 * Keywords and competitor names are text Apple or another developer chose, and
 * a spreadsheet runs a cell that opens with = + - or @ as a formula (tab and
 * CR open one in some of them too). A leading apostrophe makes it a literal.
 * Only text is neutralised: a negative rank change is a number and must stay
 * one.
 */
function csvEscape(value: string | number | null): string {
	if (value === null) {
		return "";
	}
	let text = String(value);
	if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text)) {
		text = `'${text}`;
	}
	return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The storefront reaches a response header through the filename, and a header
 * value with CR or LF in it throws, while a quote ends the filename early. A
 * storefront code is letters, so anything else is dropped rather than escaped.
 */
function filenamePart(raw: string): string {
	return raw.replaceAll(/[^a-z0-9]/giu, "").slice(0, 16) || "report";
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
		// A blank position has two causes, and only these two columns tell them
		// apart: observed and outside the top 200, or not observed at all.
		"observations",
		"last_observed",
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
				row.points.length,
				row.points.at(-1)?.date ?? null,
			]
				.map((v) => csvEscape(v as string | number | null))
				.join(",")
		);
	}

	return new Response(`${lines.join("\n")}\n`, {
		headers: {
			"Content-Disposition": `attachment; filename="apprank-${filenamePart(storefront)}-${report.dates.at(-1) ?? "report"}.csv"`,
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

// Rank history for one pair, for one app: the one named, or else the one app
// the caller tracks the pair's keyword for. Unfiltered, the query returns every
// app Apple listed each day, which a chart reads as the tracked app's rank.
// The failed days come with it so the chart can draw them as failures, not as
// the app dropping out.
api.get("/pairs/:pairId/history", async (c) => {
	const pairId = Number(c.req.param("pairId"));
	if (!(await callerOwnsPair(c, pairId))) {
		return notFound(c);
	}
	const days = bounded(c.req.query("days"), 90, 400);
	const rawAppId = c.req.query("appId");
	let appId = rawAppId === undefined ? null : Number(rawAppId);
	// A junk id is the caller's mistake. Passed on, NaN and 0 both read as "no
	// app named" further down, and the answer was every app's rows at once.
	if (appId !== null && !(Number.isInteger(appId) && appId > 0)) {
		return c.json({ error: "appId must be a positive integer" }, 400);
	}
	if (appId === null) {
		const apps = await trackedAppsForPair(c.env.DB, c.get("userId"), pairId);
		const [only, ...others] = apps;
		if (only === undefined) {
			return notFound(c);
		}
		if (others.length > 0) {
			return c.json(
				{
					error: `pair ${pairId} is tracked for apps ${apps.join(", ")}; pass appId to say whose rank you want`,
				},
				400
			);
		}
		appId = only;
	}
	const from = sinceDate(days);
	const to = sinceDate(0);
	const [rows, fetchErrors] = await Promise.all([
		pairHistory(c.env.DB, pairId, from, appId),
		pairFetchErrors(c.env.DB, pairId, from, to),
	]);
	return c.json({ fetchErrors, points: rows.results, window: { from, to } });
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
	const rows = await appReviews(c.env.DB, appId, {
		storefront: c.req.query("storefront"),
	});
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
	// A body that is not JSON, or is JSON null, is the client's mistake and
	// answers 400; destructuring it unguarded answered 500.
	const body: unknown = await c.req.json().catch(() => null);
	const status =
		typeof body === "object" && body !== null && "status" in body
			? body.status
			: undefined;
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
