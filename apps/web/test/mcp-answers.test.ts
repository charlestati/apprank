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
	trackEveryActivePair,
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

describe("get_keyword_popularity, one answer per week", () => {
	it("collapses a genre's absence and the term's own measurement into one point", async () => {
		// Two rows for one week: the genre pull's "outside this genre's top 500"
		// and the by-name pass's storefront-wide measurement. Returned side by
		// side they read as absent and measured at once.
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 6013, '2026-08-02', 0, NULL, 0)`
			),
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 0, '2026-08-02', 1, 40, 0)`
			),
			// A week only a genre measured keeps that genre's rank.
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, rank_in_genre, fetched_at)
         VALUES (1, 'fr', 6013, '2026-08-09', 1, 55, 12, 0)`
			),
			// A week holding nothing but an absence is still an answer.
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 6013, '2026-08-16', 0, NULL, 0)`
			),
		]);
		const { data } = await call("get_keyword_popularity", {
			appId: APP_ID,
			from: "2026-08-01",
			keyword: KEYWORD_A,
			storefront: "fr",
			to: "2026-08-31",
		});
		const [series] = data.keywords as {
			points: {
				weekStart: string;
				present: boolean;
				popularity1_100: number | null;
				rankInGenre: number | null;
			}[];
		}[];
		expect(series?.points).toMatchObject([
			{ popularity1_100: 40, present: true, weekStart: "2026-08-02" },
			{
				popularity1_100: 55,
				present: true,
				rankInGenre: 12,
				weekStart: "2026-08-09",
			},
			{ popularity1_100: null, present: false, weekStart: "2026-08-16" },
		]);
		expect(series?.points).toHaveLength(3);
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

	it("compares whole boards, and applies the limit to the answer only", async () => {
		// Ten deep, asked for three rows. Cutting the boards to the limit first
		// reported the slip from #3 to #5 as leaving the chart and the climb
		// from #9 to #1 as entering it.
		const before = [1, 2, 303, 4, 5, 6, 7, 8, 909, 10].map((n) => 880_000 + n);
		const after = [909, 1, 2, 4, 303, 5, 6, 7, 8, 10].map((n) => 880_000 + n);
		await seedChart(isoDay(7), before);
		await seedChart(isoDay(0), after);
		const { data } = await call("get_chart_movement", {
			chart: "free",
			from: isoDay(7),
			limit: 3,
			storefront: "fr",
			to: isoDay(0),
		});
		const moves = data.moves as {
			appId: number;
			status: string;
			from: number | null;
			to: number | null;
		}[];
		expect(moves).toHaveLength(3);
		// Biggest mover first, with both of its real positions.
		expect(moves[0]).toMatchObject({
			appId: 880_909,
			from: 9,
			status: "climbed",
			to: 1,
		});
		expect(moves.map((m) => m.status)).not.toContain("entered");
		expect(moves.map((m) => m.status)).not.toContain("exited");
		expect((data.provenance as { truncated: boolean }).truncated).toBeTruthy();
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
		expect(coverage.map((c) => c.pairId).toSorted()).toStrictEqual([1, 2, 3]);
		// One observation in a thirty-day window on a daily pair, and none on the
		// other two: all three are short of their cadence, and the count says so.
		expect(coverage.every((c) => c.degraded)).toBeTruthy();
		expect((data.provenance as { degradedPairs: number }).degradedPairs).toBe(
			3
		);
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

	it("warns that coverage is thin, and says which kind of silence it is", async () => {
		const { data } = await call("get_keyword_report", {
			appId: APP_ID,
			storefront: "fr",
		});
		// The fixture has never been through a popularity pull, so the note has to
		// say that rather than claim Apple answered and had nothing.
		expect((data.provenance as { note: string }).note).toContain(
			"have not been through a popularity pull yet"
		);
	});
});

describe("get_keyword_report, the window it was asked for", () => {
	beforeEach(async () => {
		for (const [id, daysAgo, position] of [
			[1, 12, 30],
			[2, 11, 20],
			[3, 10, 10],
			[4, 0, 4],
		] as const) {
			await seedRanking({
				date: isoDay(daysAgo),
				entries: [[position, APP_ID]],
				id,
				pairId: 1,
			});
		}
	});

	it("starts on the requested day, not a day or two before it", async () => {
		// Turning the start into a day count and back went through two roundings
		// against the current instant, so the two days before `from` leaked in
		// and moved best, worst and the change.
		const { data } = await call("get_keyword_report", {
			appId: APP_ID,
			detail: "rows",
			from: isoDay(10),
			storefront: "fr",
			to: isoDay(0),
		});
		const row = (
			data.rows as {
				keyword: string;
				worst: number | null;
				points: { date: string }[];
			}[]
		).find((r) => r.keyword === KEYWORD_A);
		expect(row?.points.map((p) => p.date)).toStrictEqual([
			isoDay(10),
			isoDay(0),
		]);
		expect(row?.worst).toBe(10);
	});

	it("serves a window that ended long ago instead of returning it empty", async () => {
		await seedRanking({
			date: isoDay(500),
			entries: [[7, APP_ID]],
			id: 9,
			pairId: 1,
		});
		const { data, isError } = await call("get_keyword_report", {
			appId: APP_ID,
			from: isoDay(510),
			storefront: "fr",
			to: isoDay(490),
		});
		expect(isError).toBeFalsy();
		expect(data.dates).toStrictEqual({ first: isoDay(500), last: isoDay(500) });
	});

	it("refuses a window wider than it reads, rather than answering a narrower one", async () => {
		const tooWide = await call("get_keyword_report", {
			appId: APP_ID,
			from: isoDay(450),
			storefront: "fr",
			to: isoDay(0),
		});
		expect(tooWide.isError).toBeTruthy();
		expect(String(tooWide.data.error)).toContain("at most 400");

		const backwards = await call("get_keyword_report", {
			appId: APP_ID,
			from: isoDay(1),
			storefront: "fr",
			to: isoDay(5),
		});
		expect(backwards.isError).toBeTruthy();
		expect(String(backwards.data.error)).toContain("before it starts");
	});

	it("marks a keyword nobody observed, and keeps it out of every lane filter", async () => {
		const { data } = await call("get_keyword_report", {
			appId: APP_ID,
			storefront: "fr",
		});
		const unobserved = (data.rows as Record<string, unknown>[]).find(
			(r) => r.keyword !== KEYWORD_A
		);
		expect(unobserved).toMatchObject({
			lastObserved: null,
			observations: 0,
			position: null,
			reasonKey: "noObservation",
			verdict: "unknown",
		});
		expect(
			(data.provenance as { unobservedKeywords: number }).unobservedKeywords
		).toBe(1);

		// Its verdict slot says "unknown", and it has no rank: neither the lane
		// for ranked-without-volume nor the one for not-ranking may claim it.
		for (const lane of ["dormant", "unknown"]) {
			const filtered = await call("find_keyword_opportunities", {
				appId: APP_ID,
				lane,
				storefront: "fr",
			});
			const names = (filtered.data.keywords as { keyword: string }[]).map(
				(k) => `${lane}: ${k.keyword}`
			);
			expect(names).not.toContain(`${lane}: ${String(unobserved?.keyword)}`);
		}
	});
});

describe("a tool that fails for a reason of ours", () => {
	it("answers one stable sentence, not the driver's message", async () => {
		// A driver error names tables and statements. It used to be returned to
		// the model verbatim, after "The tool failed: ".
		const failing = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) => {
						if (sql.includes("FROM review")) {
							throw new Error("D1_ERROR: no such table: review: SQLITE_ERROR");
						}
						return target.prepare(sql);
					};
				}
				const value: unknown = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { data, isError } = await toolPayload(
			await fetchMcp(
				mcpRequest(callTool("get_reviews", { appId: APP_ID }), token),
				{ ...env, DB: failing, MCP_ENABLED: "true" } as never
			)
		);
		expect(isError).toBeTruthy();
		expect(data).toStrictEqual({ error: "The tool failed." });
		const logged = await env.DB.prepare(
			"SELECT outcome FROM mcp_tool_call ORDER BY id DESC LIMIT 1"
		).first<{ outcome: string }>();
		expect(logged?.outcome).toBe("error");
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

describe("get_rank_history without an appId", () => {
	beforeEach(async () => {
		for (const [id, offset, mine] of [
			[1, 1, 5],
			[2, 0, 3],
		] as const) {
			await seedRanking({
				date: isoDay(offset),
				entries: [
					[1, RIVAL_ID],
					[mine, APP_ID],
				],
				id,
				pairId: 1,
			});
		}
	});

	it("reads the tracked app's own rank, not every app on the page", async () => {
		const { data } = await call("get_rank_history", {
			detail: "daily",
			from: isoDay(5),
			pairId: 1,
		});
		expect(data.points).toStrictEqual([
			{ date: isoDay(1), position: 5 },
			{ date: isoDay(0), position: 3 },
		]);
	});

	it("asks which app when the caller tracks the keyword for two", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES (?1, ?2, 0)"
			).bind(USER_ID, RIVAL_ID),
			env.DB.prepare(
				"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 1, 0)"
			).bind(USER_ID, RIVAL_ID),
		]);
		await trackEveryActivePair(USER_ID);
		const ambiguous = await call("get_rank_history", { pairId: 1 });
		expect(ambiguous.isError).toBeTruthy();
		expect(JSON.stringify(ambiguous.data)).toContain("appId");

		const named = await call("get_rank_history", {
			appId: RIVAL_ID,
			detail: "daily",
			from: isoDay(5),
			pairId: 1,
		});
		expect(named.data.points).toStrictEqual([
			{ date: isoDay(1), position: 1 },
			{ date: isoDay(0), position: 1 },
		]);
	});
});

describe("windows and filters the tools echo", () => {
	it("ends get_keyword_report at the requested to date", async () => {
		await seedRanking({
			date: isoDay(1),
			entries: [[5, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [[2, APP_ID]],
			id: 2,
			pairId: 1,
		});
		const { data } = await call("get_keyword_report", {
			appId: APP_ID,
			from: isoDay(10),
			storefront: "fr",
			to: isoDay(1),
		});
		const rows = data.rows as { keyword: string; position: number | null }[];
		expect(rows.find((r) => r.keyword === KEYWORD_A)?.position).toBe(5);
		expect(data.dates).toStrictEqual({ first: isoDay(1), last: isoDay(1) });
	});

	it("filters reviews by rating before the cap, so old ones are reachable", async () => {
		// The newest hundred are all five stars; the one-star reviews sit behind them.
		await env.DB.prepare(
			`INSERT INTO review (id, app_id, storefront_code, rating, reviewed_at, fetched_at)
       WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 102)
       SELECT 'r' || i, ?1, 'fr', CASE WHEN i < 100 THEN 5 ELSE 1 END, 10000 - i, 0 FROM n`
		)
			.bind(APP_ID)
			.run();
		const { data } = await call("get_reviews", {
			appId: APP_ID,
			limit: 2,
			maxRating: 1,
		});
		const reviews = data.reviews as { rating: number }[];
		expect(reviews.map((r) => r.rating)).toStrictEqual([1, 1]);
		expect(data.provenance).toMatchObject({ truncated: true });

		const all = await call("get_reviews", { appId: APP_ID, maxRating: 1 });
		expect(all.data.reviews).toHaveLength(3);
		expect(all.data.provenance).toMatchObject({ truncated: false });
	});
});
