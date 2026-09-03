/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { clearReferenceCache } from "../src/mcp/reference";
import {
	APP_ID,
	KEYWORD_A,
	RIVAL_ID,
	USER_ID,
	isoDay,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedRanking,
	seedTrackedApp,
} from "./fixtures";
import {
	callTool,
	fetchMcp,
	issueCredential,
	mcpRequest,
	toolPayload,
} from "./mcp-fixtures";

function walled() {
	return {
		...env,
		ALLOW_UNAUTHENTICATED: "true",
		MCP_ENABLED: "true",
	} as never;
}

let token = "";

beforeEach(async () => {
	await resetDb();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM mcp_tool_call"),
		env.DB.prepare("DELETE FROM mcp_credential"),
		env.DB.prepare("DELETE FROM chart_ranking"),
	]);
	clearReferenceCache();
	await seedCatalog();
	await seedTrackedApp();
	await seedKeywords();
	({ token } = await issueCredential({ userId: USER_ID }));
});

/** Midnight UTC on a day offset, the grain captured_at is compared at. */
function day(offset: number): number {
	return Date.parse(`${isoDay(offset)}T00:00:00Z`);
}

async function call(name: string, args: Record<string, unknown> = {}) {
	return toolPayload(
		await fetchMcp(mcpRequest(callTool(name, args), token), walled())
	);
}

describe("get_keyword_popularity", () => {
	it("keeps measured, absent and never-queried apart", async () => {
		await env.DB.batch([
			// Keyword 1: Apple published a volume.
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 6014, '2026-08-02', 1, 65, 0)`
			),
			// Keyword 2: we asked, Apple had nothing. Not the same as zero demand.
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (2, 'fr', 6014, '2026-08-02', 0, NULL, 0)`
			),
		]);
		const { data } = await call("get_keyword_popularity", {
			appId: APP_ID,
			from: "2026-08-01",
			storefront: "fr",
			to: "2026-08-31",
		});
		const keywords = data.keywords as {
			keyword: string;
			everMeasured: boolean;
			points: { present: boolean; popularity1_100: number | null }[];
		}[];
		const measured = keywords.find((k) => k.keyword === KEYWORD_A);
		expect(measured?.everMeasured).toBeTruthy();
		expect(measured?.points[0]).toMatchObject({
			popularity1_100: 65,
			present: true,
		});
		const absent = keywords.find((k) => k.keyword !== KEYWORD_A);
		expect(absent?.everMeasured).toBeFalsy();
		// Absent must never surface as a number, least of all zero.
		expect(absent?.points[0]?.popularity1_100).toBeNull();
		expect(
			(data.provenance as { unmeasuredKeywords: number }).unmeasuredKeywords
		).toBeGreaterThan(0);
	});
});

async function seedChart(date: string, ids: number[]) {
	await env.DB.prepare(
		`INSERT INTO chart_ranking (storefront_code, genre_id, chart, observed_date, result_ids, http_status, source)
     VALUES ('fr', NULL, 'free', ?1, ?2, 200, 'itunes-rss')`
	)
		.bind(date, JSON.stringify(ids))
		.run();
}

describe("get_chart_movement", () => {
	it("reports climbs, falls, entries and exits", async () => {
		await seedChart(isoDay(7), [RIVAL_ID, APP_ID]);
		await seedChart(isoDay(0), [APP_ID, 999_001]);
		const { data } = await call("get_chart_movement", {
			chart: "free",
			from: isoDay(7),
			storefront: "fr",
			to: isoDay(0),
		});
		const moves = data.moves as {
			appId: number;
			status: string;
			delta: number | null;
		}[];
		expect(moves.find((m) => m.appId === APP_ID)).toMatchObject({
			delta: 1,
			status: "climbed",
		});
		expect(moves.find((m) => m.appId === RIVAL_ID)?.status).toBe("exited");
		expect(moves.find((m) => m.appId === 999_001)?.status).toBe("entered");
		expect((data.provenance as { note: string }).note).toContain("itunes-rss");
	});

	it("says so rather than inventing movement from one observation", async () => {
		await seedChart(isoDay(0), [APP_ID]);
		const { data } = await call("get_chart_movement", {
			chart: "free",
			storefront: "fr",
		});
		expect(data.moves).toStrictEqual([]);
		expect((data.provenance as { note: string }).note).toContain(
			"Fewer than two observations"
		);
	});
});

describe("get_metadata_changes", () => {
	it("names which fields changed, and treats the first sighting as such", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO app_metadata_version (app_id, captured_at, content_hash, source, title, version, price)
         VALUES (?1, ?2, 'h1', 'itunes-lookup', 'Tracked App', '1.0', 0)`
			).bind(APP_ID, day(20)),
			env.DB.prepare(
				`INSERT INTO app_metadata_version (app_id, captured_at, content_hash, source, title, version, price)
         VALUES (?1, ?2, 'h2', 'itunes-lookup', 'Tracked App Pro', '1.1', 0)`
			).bind(APP_ID, day(5)),
		]);
		const { data } = await call("get_metadata_changes", {
			appId: APP_ID,
			from: isoDay(30),
			to: isoDay(0),
		});
		const changes = data.changes as { changed: string[]; version: string }[];
		expect(changes[0]?.changed).toStrictEqual(["firstSeen"]);
		expect(changes[1]?.changed.toSorted()).toStrictEqual(["title", "version"]);
	});
});

describe("find_keyword_opportunities", () => {
	beforeEach(async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[3, APP_ID]],
			id: 500,
			pairId: 1,
		});
		await env.DB.prepare(
			`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
       VALUES (1, 'fr', 6014, '2026-08-02', 1, 60, 0)`
		).run();
	});

	it("returns the verdict, its reason and the thresholds behind it", async () => {
		const { data } = await call("find_keyword_opportunities", {
			appId: APP_ID,
			storefront: "fr",
		});
		const keywords = data.keywords as {
			keyword: string;
			verdict: string;
			reason: string;
		}[];
		expect(keywords[0]).toMatchObject({
			keyword: KEYWORD_A,
			verdict: "winning",
		});
		expect(keywords[0]?.reason).toBeTruthy();
		expect(data.thresholds).toMatchObject({ difficultyBlocked: 80 });
	});

	it("filters by lane and by published volume", async () => {
		const wrongLane = await call("find_keyword_opportunities", {
			appId: APP_ID,
			lane: "blocked",
			storefront: "fr",
		});
		expect(wrongLane.data.keywords).toStrictEqual([]);

		// A keyword Apple published no volume for is excluded once a floor is set:
		// absent is not a small number, so it cannot satisfy a minimum.
		const withFloor = await call("find_keyword_opportunities", {
			appId: APP_ID,
			minPopularity: 90,
			storefront: "fr",
		});
		expect(withFloor.data.keywords).toStrictEqual([]);
	});
});

describe("get_reviews and get_ratings_history", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO review (id, app_id, storefront_code, rating, title, body, reviewed_at, fetched_at)
         VALUES ('r1', ?1, 'fr', 5, 'Great', 'Body', 1000, 0)`
			).bind(APP_ID),
			env.DB.prepare(
				`INSERT INTO review (id, app_id, storefront_code, rating, title, body, reviewed_at, fetched_at)
         VALUES ('r2', ?1, 'fr', 1, 'Bad', 'Body', 2000, 0)`
			).bind(APP_ID),
			env.DB.prepare(
				`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
         VALUES (?1, 'fr', ?2, 100, 4.5)`
			).bind(APP_ID, isoDay(10)),
			env.DB.prepare(
				`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
         VALUES (?1, 'fr', ?2, 140, 4.6)`
			).bind(APP_ID, isoDay(0)),
		]);
	});

	it("filters reviews by rating", async () => {
		const all = await call("get_reviews", { appId: APP_ID });
		expect(all.data.reviews as unknown[]).toHaveLength(2);
		const bad = await call("get_reviews", { appId: APP_ID, maxRating: 2 });
		expect(
			(bad.data.reviews as { id: string }[]).map((r) => r.id)
		).toStrictEqual(["r2"]);
	});

	it("summarises rating growth per storefront, and lists snapshots on request", async () => {
		const summary = await call("get_ratings_history", { appId: APP_ID });
		expect((summary.data.storefronts as unknown[])[0]).toMatchObject({
			countChange: 40,
			latestCount: 140,
			storefront: "fr",
		});
		const daily = await call("get_ratings_history", {
			appId: APP_ID,
			detail: "daily",
		});
		expect(daily.data.snapshots as unknown[]).toHaveLength(2);
	});
});

describe("get_search_results", () => {
	it("keeps unknown apps in place rather than dropping them", async () => {
		await env.DB.prepare(
			`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
       VALUES (600, 1, ?1, 0, 200, 3, ?2, 'test', 1)`
		)
			.bind(isoDay(0), JSON.stringify([RIVAL_ID, 999_999, APP_ID]))
			.run();
		const { data } = await call("get_search_results", { pairId: 1 });
		const results = data.results as {
			position: number;
			appId: number;
			name: string | null;
		}[];
		expect(results.map((r) => r.appId)).toStrictEqual([
			RIVAL_ID,
			999_999,
			APP_ID,
		]);
		// Dropping the unknown app would silently shift the tracked app to #2.
		expect(results[1]?.name).toBeNull();
		expect(results[2]?.position).toBe(3);
	});

	it("answers empty rather than failing when nothing was observed", async () => {
		const { data, isError } = await call("get_search_results", { pairId: 1 });
		expect(isError).toBeFalsy();
		expect(data.results).toStrictEqual([]);
	});
});

describe("get_collection_health", () => {
	it("describes shared collector state without an app", async () => {
		const { data } = await call("get_collection_health");
		expect(data.collector).toMatchObject({ tier1Pairs: 3 });
		expect(data.coverage).toBeUndefined();
	});

	it("adds per-pair coverage for one of the caller's apps", async () => {
		await seedRanking({ date: isoDay(0), id: 700, pairId: 1 });
		const { data } = await call("get_collection_health", { appId: APP_ID });
		const coverage = data.coverage as { pairId: number; degraded: boolean }[];
		expect(coverage.length).toBeGreaterThan(0);
		expect(
			(data.provenance as { degradedPairs: number }).degradedPairs
		).toBeGreaterThanOrEqual(0);
	});
});

describe("get_keyword_report", () => {
	it("omits per-day points until detail asks for rows", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[4, APP_ID]],
			id: 800,
			pairId: 1,
		});
		const summary = await call("get_keyword_report", {
			appId: APP_ID,
			storefront: "fr",
		});
		const rows = summary.data.rows as Record<string, unknown>[];
		expect(rows[0]?.points).toBeUndefined();
		expect(rows[0]).toMatchObject({ keyword: KEYWORD_A, position: 4 });

		const detailed = await call("get_keyword_report", {
			appId: APP_ID,
			detail: "rows",
			storefront: "fr",
		});
		expect(
			(detailed.data.rows as Record<string, unknown>[])[0]?.points
		).toBeDefined();
	});

	it("warns when most keywords have no published volume", async () => {
		const { data } = await call("get_keyword_report", {
			appId: APP_ID,
			storefront: "fr",
		});
		expect((data.provenance as { note: string }).note).toContain(
			"Absent volume is not zero volume"
		);
	});
});

describe("get_competitors", () => {
	it("summarises incumbents and marks entries and exits", async () => {
		await seedRanking({
			date: isoDay(5),
			entries: [[1, RIVAL_ID]],
			id: 900,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [[1, APP_ID]],
			id: 901,
			pairId: 1,
		});
		const { data } = await call("get_competitors", {
			from: isoDay(5),
			pairId: 1,
			to: isoDay(0),
		});
		const incumbents = data.incumbents as {
			appId: number;
			entered: boolean;
			exited: boolean;
		}[];
		expect(incumbents.find((i) => i.appId === RIVAL_ID)?.exited).toBeTruthy();
		expect(incumbents.find((i) => i.appId === APP_ID)?.entered).toBeTruthy();
		expect(data.churn).toBe(2);
	});
});

describe("keyword resolution", () => {
	it("accepts a keyword and storefront instead of a pair id", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[7, APP_ID]],
			id: 1000,
			pairId: 1,
		});
		const { data } = await call("get_rank_history", {
			keyword: KEYWORD_A,
			storefront: "fr",
		});
		expect(data.pairId).toBe(1);
		expect((data.summary as { latest: number }).latest).toBe(7);
	});

	it("refuses a keyword the caller does not track", async () => {
		const { data, isError } = await call("get_rank_history", {
			keyword: "not tracked at all",
			storefront: "fr",
		});
		expect(isError).toBeTruthy();
		expect(String(data.error)).toContain("do not track");
	});

	it("insists on one identifier or the other", async () => {
		const { isError } = await call("get_rank_history", {});
		expect(isError).toBeTruthy();
	});
});
