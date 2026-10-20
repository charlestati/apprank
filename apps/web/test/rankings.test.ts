/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite here, not a per-suite one. */

/* oxlint-disable vitest/max-expects -- the keyword grid is one denormalised
   row per (keyword, storefront); asserting every column is the point of the
   test. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import {
	APP_ID,
	KEYWORD_A,
	KEYWORD_B,
	RIVAL_ID,
	apiRequest,
	isoDay,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedRanking,
	seedTrackedApp,
	trackEveryActivePair,
	USER_ID,
} from "./fixtures";

interface AppRow {
	id: number;
	current_name: string | null;
	developer_name: string | null;
	primary_genre_id: number | null;
}

interface KeywordRow {
	keyword: string;
	pair_id: number;
	storefront_code: string;
	locale_code: string;
	observed_date: string | null;
	rank: number | null;
	popularity: number | null;
}

interface HistoryRow {
	observed_date: string;
	result_count: number;
	position: number | null;
	app_id: number | null;
}

interface CompetitorRow {
	observed_date: string;
	position: number;
	app_id: number;
	current_name: string | null;
}

beforeEach(resetDb);

describe("GET /api/apps", () => {
	it("returns an empty list when nothing is tracked", async () => {
		await seedCatalog();
		const res = await app.fetch(apiRequest("/apps"), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("returns the apps tracked by the session user", async () => {
		await seedCatalog();
		await seedTrackedApp();
		const res = await app.fetch(apiRequest("/apps"), env);
		await expect(res.json()).resolves.toStrictEqual([
			{
				current_name: "Tracked App",
				developer_name: "Example Developer",
				id: APP_ID,
				primary_genre_id: 6002,
			},
		] satisfies AppRow[]);
	});

	it("hides apps tracked by a different user", async () => {
		await seedCatalog();
		await env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('someone-else', ?1, 0)"
		)
			.bind(APP_ID)
			.run();
		const res = await app.fetch(apiRequest("/apps"), env);
		await expect(res.json()).resolves.toStrictEqual([]);
	});
});

describe("GET /api/apps/:appId/keywords", () => {
	it("hides an app the caller does not track", async () => {
		await seedCatalog();
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/keywords`), env);
		expect(res.status).toBe(404);
	});

	it("returns nothing when a tracked app has no keywords yet", async () => {
		await seedCatalog();
		await seedTrackedApp();
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/keywords`), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("joins the latest valid ranking and the latest popularity per pair", async () => {
		await seedCatalog();
		await seedTrackedApp();
		await seedKeywords();
		// Two days of data on pair 1; only the newest must surface.
		await seedRanking({
			date: isoDay(1),
			entries: [[7, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(),
			entries: [
				[3, APP_ID],
				[1, RIVAL_ID],
			],
			id: 2,
			pairId: 1,
		});
		// Pair 2 was observed but the tracked app is absent from the top 200.
		await seedRanking({
			date: isoDay(),
			entries: [[1, RIVAL_ID]],
			id: 3,
			pairId: 2,
		});
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 6002, '2026-01-05', 55, 0)`
			),
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 6002, '2026-01-12', 61, 0)`
			),
		]);

		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/keywords`), env);
		const rows = (await res.json()) as KeywordRow[];
		expect(rows).toHaveLength(3);
		// Ordered by keyword text, then storefront code.
		expect(rows.map((r) => `${r.keyword}/${r.storefront_code}`)).toStrictEqual([
			`${KEYWORD_B}/fr`,
			`${KEYWORD_A}/fr`,
			`${KEYWORD_A}/us`,
		]);
		expect(rows[1]).toStrictEqual({
			keyword: KEYWORD_A,
			keyword_id: 1,
			locale_code: "fr-FR",
			observed_date: isoDay(),
			pair_id: 1,
			popularity: 61,
			rank: 3,
			storefront_code: "fr",
		});
		// Observed, unranked: a date but a null rank.
		expect(rows[2]?.rank).toBeNull();
		expect(rows[2]?.observed_date).toBe(isoDay());
		// Never observed: no date at all.
		expect(rows[0]?.observed_date).toBeNull();
	});

	it("ignores invalidated rankings", async () => {
		await seedCatalog();
		await seedTrackedApp();
		await seedKeywords();
		await seedRanking({
			date: isoDay(),
			entries: [[4, APP_ID]],
			id: 1,
			pairId: 1,
			valid: 0,
		});
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/keywords`), env);
		const rows = (await res.json()) as KeywordRow[];
		expect(rows.every((r) => r.observed_date === null)).toBeTruthy();
	});
});

interface HistoryBody {
	points: HistoryRow[];
	fetchErrors: { date: string; errorClass: string; count: number }[];
	window: { from: string; to: string };
}

async function history(path: string): Promise<HistoryBody> {
	const res = await app.fetch(apiRequest(path), env);
	expect(res.status).toBe(200);
	return (await res.json()) as HistoryBody;
}

async function seedFetchError(
	params: string,
	day: string,
	errorClass: string | null = "throttled"
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO fetch_error (endpoint, error_class, fetched_at, params, message)
     VALUES ('itunes/search', ?1, ?2, ?3, 'HTTP 403, empty results')`
	)
		.bind(errorClass, Date.parse(`${day}T09:00:00Z`), params)
		.run();
}

describe("GET /api/pairs/:pairId/history", () => {
	it("returns an empty series with the window it covered", async () => {
		await seedCatalog();
		await seedKeywords();
		await expect(history("/pairs/1/history")).resolves.toStrictEqual({
			fetchErrors: [],
			points: [],
			window: { from: isoDay(90), to: isoDay() },
		});
	});

	it("defaults to the caller's tracked app, not every app Apple listed", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({
			date: isoDay(1),
			entries: [
				[2, APP_ID],
				[1, RIVAL_ID],
			],
			id: 1,
			pairId: 1,
			resultCount: 150,
		});
		const { points } = await history("/pairs/1/history");
		expect(points).toStrictEqual([
			{
				app_id: APP_ID,
				observed_date: isoDay(1),
				position: 2,
				result_count: 150,
			},
		]);
	});

	it("refuses to guess when the caller tracks the keyword for several apps", async () => {
		await seedCatalog();
		await seedKeywords();
		await env.DB.prepare(
			"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 1, 0)"
		)
			.bind(USER_ID, RIVAL_ID)
			.run();
		await trackEveryActivePair(USER_ID);
		await seedRanking({
			date: isoDay(1),
			entries: [
				[2, APP_ID],
				[1, RIVAL_ID],
			],
			id: 1,
			pairId: 1,
		});
		const res = await app.fetch(apiRequest("/pairs/1/history"), env);
		expect(res.status).toBe(400);
		const { error } = (await res.json()) as { error: string };
		expect(error).toContain("pass appId");
		const named = await history(`/pairs/1/history?appId=${RIVAL_ID}`);
		expect(named.points.map((p) => p.position)).toStrictEqual([1]);
	});

	it("lists this pair's failed days by class within the window", async () => {
		await seedCatalog();
		await seedKeywords();
		const pairKey = `${KEYWORD_A}|fr|fr-FR`;
		await seedFetchError(pairKey, isoDay(2));
		await seedFetchError(pairKey, isoDay(2));
		await seedFetchError(pairKey, isoDay(2), "http_error");
		await seedFetchError(pairKey, isoDay(1), null);
		// Same keyword, other storefront: pair 2's failure, not pair 1's.
		await seedFetchError(`${KEYWORD_A}|us|en-US`, isoDay(1));
		// Outside a 7-day window.
		await seedFetchError(pairKey, isoDay(20));
		const { fetchErrors } = await history("/pairs/1/history?days=7");
		expect(fetchErrors).toStrictEqual([
			{ count: 1, date: isoDay(2), errorClass: "http_error" },
			{ count: 2, date: isoDay(2), errorClass: "throttled" },
			{ count: 1, date: isoDay(1), errorClass: "unknown" },
		]);
	});

	it("hides a pair the caller does not track", async () => {
		await seedCatalog();
		await seedKeywords();
		await env.DB.prepare(
			"UPDATE tracked_keyword SET user_id = 'someone-else'"
		).run();
		const res = await app.fetch(apiRequest("/pairs/1/history"), env);
		expect(res.status).toBe(404);
	});

	it("narrows to one app with the appId query param", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({
			date: isoDay(2),
			entries: [
				[5, APP_ID],
				[1, RIVAL_ID],
			],
			id: 1,
			pairId: 1,
		});
		// A day with no entry for the tracked app still yields a row (LEFT JOIN).
		await seedRanking({
			date: isoDay(1),
			entries: [[1, RIVAL_ID]],
			id: 2,
			pairId: 1,
		});
		const { points } = await history(`/pairs/1/history?appId=${APP_ID}`);
		expect(points).toStrictEqual([
			{
				app_id: APP_ID,
				observed_date: isoDay(2),
				position: 5,
				result_count: 200,
			},
			{
				app_id: null,
				observed_date: isoDay(1),
				position: null,
				result_count: 200,
			},
		]);
	});

	it("clips the window with the days query param", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({ date: isoDay(10), id: 1, pairId: 1 });
		await seedRanking({ date: isoDay(1), id: 2, pairId: 1 });
		const body = await history("/pairs/1/history?days=3");
		expect(body.points.map((p) => p.observed_date)).toStrictEqual([isoDay(1)]);
		expect(body.window).toStrictEqual({ from: isoDay(3), to: isoDay() });
	});

	it("falls back to the default window on a junk days value", async () => {
		// Number("abc") is NaN, and NaN survives Math.min/Math.max unchanged, so an
		// unguarded clamp reached sinceDate() and threw RangeError, a 500 for what
		// is only a malformed query string.
		await seedCatalog();
		await seedKeywords();
		await seedRanking({ date: isoDay(1), id: 1, pairId: 1 });
		for (const q of ["?days=abc", "?days=", "?days=NaN", "?days=Infinity"]) {
			const res = await app.fetch(apiRequest(`/pairs/1/history${q}`), env);
			expect(res.status).toBe(200);
		}
	});

	it("refuses a negative window instead of dating the future", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({ date: isoDay(1), id: 1, pairId: 1 });
		const { points } = await history("/pairs/1/history?days=-5");
		expect(points).toHaveLength(1);
	});

	it("caps the window at 400 days", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({ date: isoDay(399), id: 1, pairId: 1 });
		await seedRanking({ date: isoDay(500), id: 2, pairId: 1 });
		const { points } = await history("/pairs/1/history?days=9999");
		expect(points.map((p) => p.observed_date)).toStrictEqual([isoDay(399)]);
	});
});

describe("GET /api/pairs/:pairId/competitors", () => {
	it("returns an empty board with no observations", async () => {
		await seedCatalog();
		await seedKeywords();
		const res = await app.fetch(apiRequest("/pairs/1/competitors"), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("returns only top-10 entries, joined to app names, ordered by date then position", async () => {
		await seedCatalog();
		await seedKeywords();
		await env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, 'Third App', 0, 0)"
		)
			.bind(RIVAL_ID + 1)
			.run();
		await seedRanking({
			date: isoDay(1),
			entries: [
				[1, RIVAL_ID],
				[4, APP_ID],
				[11, RIVAL_ID + 1],
			],
			id: 1,
			pairId: 1,
		});
		const res = await app.fetch(apiRequest("/pairs/1/competitors"), env);
		const rows = (await res.json()) as CompetitorRow[];
		expect(rows).toStrictEqual([
			{
				app_id: RIVAL_ID,
				current_name: "Rival App",
				observed_date: isoDay(1),
				position: 1,
			},
			{
				app_id: APP_ID,
				current_name: "Tracked App",
				observed_date: isoDay(1),
				position: 4,
			},
		]);
	});

	it("clips the window with the days query param", async () => {
		await seedCatalog();
		await seedKeywords();
		await seedRanking({
			date: isoDay(60),
			entries: [[1, RIVAL_ID]],
			id: 1,
			pairId: 1,
		});
		const res = await app.fetch(apiRequest("/pairs/1/competitors?days=7"), env);
		await expect(res.json()).resolves.toStrictEqual([]);
		const wide = await app.fetch(
			apiRequest("/pairs/1/competitors?days=999"),
			env
		);
		expect((await wide.json()) as CompetitorRow[]).toHaveLength(1);
	});
});
