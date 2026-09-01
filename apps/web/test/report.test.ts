/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import worker from "../src/index";
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
} from "./fixtures";

beforeEach(async () => {
	await resetDb();
	await seedCatalog();
	await seedTrackedApp();
	await seedKeywords();
});

/** Millisecond timestamp for a day the fixtures address by offset. */
function capturedAt(offsetDays: number): number {
	return Date.parse(`${isoDay(offsetDays)}T10:00:00Z`);
}

async function getReport(query = "?storefront=fr&days=30") {
	const res = await worker.fetch(
		apiRequest(`/apps/${APP_ID}/report${query}`),
		env
	);
	expect(res.status).toBe(200);
	return res.json() as Promise<{
		storefront: string;
		days: number;
		dates: string[];
		window: { from: string; to: string };
		metadataChanges: {
			date: string;
			version: string | null;
			changed: string[];
		}[];
		stats: {
			trackedKeywords: number;
			rankedKeywords: number;
			averageRank: number | null;
			averageRankChange: number | null;
			best: number | null;
			worst: number | null;
			distribution: Record<string, number>;
			movement: Record<string, number>;
		};
		rows: {
			pairId: number;
			keyword: string;
			position: number | null;
			change: number | null;
			changeDaysAgo: number | null;
			best: number | null;
			worst: number | null;
			popularity: number | null;
			resultCount: number | null;
			topResults: {
				position: number;
				appId: number;
				name: string;
				iconUrl: string | null;
			}[];
			difficulty: { score: number; sampleSize: number } | null;
			points: { date: string; position: number | null }[];
			fetchErrors: { date: string; errorClass: string; count: number }[];
		}[];
	}>;
}

describe("GET /apps/:appId/report", () => {
	it("lists every tracked keyword for the storefront, ranked or not", async () => {
		const report = await getReport();
		expect(report.storefront).toBe("fr");
		expect(report.rows.map((r) => r.keyword).toSorted()).toStrictEqual(
			[KEYWORD_A, KEYWORD_B].toSorted()
		);
		expect(report.stats.trackedKeywords).toBe(2);
		expect(report.stats.rankedKeywords).toBe(0);
	});

	it("excludes pairs from other storefronts", async () => {
		// Pair 2 is the same keyword in the US storefront.
		await seedRanking({
			date: isoDay(0),
			entries: [[3, APP_ID]],
			id: 1,
			pairId: 2,
		});
		const report = await getReport();
		expect(report.rows.every((r) => r.position === null)).toBeTruthy();
	});

	it("reports the latest rank, its change and the days since it moved", async () => {
		await seedRanking({
			date: isoDay(3),
			entries: [[12, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(1),
			entries: [[4, APP_ID]],
			id: 2,
			pairId: 1,
			resultCount: 180,
		});

		const report = await getReport();
		const row = report.rows.find((r) => r.keyword === KEYWORD_A);
		expect(row).toMatchObject({
			best: 4,
			// Positive change = moved towards rank 1.
			change: 8,
			changeDaysAgo: 2,
			position: 4,
			resultCount: 180,
			worst: 12,
		});
	});

	it("reports a drop as a negative change", async () => {
		await seedRanking({
			date: isoDay(2),
			entries: [[5, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [[30, APP_ID]],
			id: 2,
			pairId: 1,
		});
		const report = await getReport();
		const row = report.rows.find((r) => r.keyword === KEYWORD_A);
		expect(row?.change).toBe(-25);
		expect(report.stats.movement.down).toBe(1);
		expect(report.stats.movement.up).toBe(0);
	});

	it("treats a repeated rank as unchanged rather than a move", async () => {
		await seedRanking({
			date: isoDay(2),
			entries: [[9, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [[9, APP_ID]],
			id: 2,
			pairId: 1,
		});
		const report = await getReport();
		const row = report.rows.find((r) => r.keyword === KEYWORD_A);
		expect(row?.change).toBeNull();
		expect(report.stats.movement.unchanged).toBe(1);
	});

	it("keeps observed days as points, including days the app was not ranked", async () => {
		await seedRanking({
			date: isoDay(2),
			entries: [[7, APP_ID]],
			id: 1,
			pairId: 1,
		});
		// Observed, but the tracked app was nowhere in the top 200.
		await seedRanking({
			date: isoDay(1),
			entries: [[1, RIVAL_ID]],
			id: 2,
			pairId: 1,
		});
		const report = await getReport();
		const row = report.rows.find((r) => r.keyword === KEYWORD_A);
		expect(row?.points).toStrictEqual([
			{ date: isoDay(2), position: 7 },
			{ date: isoDay(1), position: null },
		]);
		expect(report.dates).toContain(isoDay(1));
	});

	it("spans the whole requested window, not just the observed days", async () => {
		await seedRanking({
			date: isoDay(1),
			entries: [[4, APP_ID]],
			id: 1,
			pairId: 1,
		});
		const report = await getReport("?storefront=fr&days=30");
		// The axis is the window: a pair on a stretched cadence rung has to draw
		// its six-day gaps six days wide, which needs both ends of the window.
		expect(report.window.from).toBe(isoDay(30));
		expect(report.window.to).toBe(isoDay(0));
		expect(report.dates).toStrictEqual([isoDay(1)]);
	});

	it("reports the days a fetch failed against the pair that failed", async () => {
		await env.DB.prepare(
			`INSERT INTO fetch_error (endpoint, error_class, fetched_at, params, message)
       VALUES ('itunes/search', 'throttled', ?1, ?2, 'HTTP 403, empty results')`
		)
			.bind(Date.parse(`${isoDay(2)}T09:00:00Z`), `${KEYWORD_A}|fr|fr-FR`)
			.run();
		const report = await getReport();
		const rowA = report.rows.find((r) => r.keyword === KEYWORD_A);
		const rowB = report.rows.find((r) => r.keyword === KEYWORD_B);
		expect(rowA?.fetchErrors).toStrictEqual([
			{ count: 1, date: isoDay(2), errorClass: "throttled" },
		]);
		// The key carries the storefront and locale, so the other pair on the same
		// storefront stays clean — a throttle is never charged to a keyword that
		// did not suffer it.
		expect(rowB?.fetchErrors).toStrictEqual([]);
	});

	it("names what each metadata release changed, not just that one happened", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO app_metadata_version
           (app_id, captured_at, content_hash, source, title, version)
         VALUES (?1, ?2, 'h1', 'itunes-lookup', 'Old title', '3.1')`
			).bind(APP_ID, capturedAt(6)),
			env.DB.prepare(
				`INSERT INTO app_metadata_version
           (app_id, captured_at, content_hash, source, title, version)
         VALUES (?1, ?2, 'h2', 'itunes-lookup', 'New title', '3.2')`
			).bind(APP_ID, capturedAt(3)),
		]);
		const report = await getReport();
		// A marker reading only "metadata" cannot be read against a rank move.
		expect(report.metadataChanges.at(-1)).toStrictEqual({
			changed: ["title", "version"],
			date: isoDay(3),
			version: "3.2",
		});
	});

	it("ignores observations marked invalid by the collector's gates", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[2, APP_ID]],
			id: 1,
			pairId: 1,
			valid: 0,
		});
		const report = await getReport();
		expect(report.stats.rankedKeywords).toBe(0);
	});

	it("ignores observations older than the requested window", async () => {
		await seedRanking({
			date: isoDay(20),
			entries: [[3, APP_ID]],
			id: 1,
			pairId: 1,
		});
		const report = await getReport("?storefront=fr&days=7");
		expect(report.days).toBe(7);
		expect(report.stats.rankedKeywords).toBe(0);
	});

	it("summarises the distribution and the average across keywords", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[3, APP_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [[120, APP_ID]],
			id: 2,
			pairId: 3,
		});
		const report = await getReport();
		expect(report.stats.averageRank).toBe(62);
		expect(report.stats.best).toBe(3);
		expect(report.stats.worst).toBe(120);
		expect(report.stats.distribution).toStrictEqual({
			beyond: 1,
			top100: 0,
			top25: 0,
			top5: 1,
		});
	});

	it("sorts ranked keywords first, best rank at the top", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[40, APP_ID]],
			id: 1,
			pairId: 3,
		});
		const report = await getReport();
		expect(report.rows[0]?.keyword).toBe(KEYWORD_B);
		expect(report.rows[1]?.position).toBeNull();
	});

	it("attaches the latest popularity for the storefront", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 7019, '2026-08-09', 1, 40, 0)`
			),
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 7019, '2026-08-16', 1, 62, 0)`
			),
			// Another storefront's number must not leak in.
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (2, 'us', 7019, '2026-08-16', 1, 99, 0)`
			),
		]);
		const report = await getReport();
		const a = report.rows.find((r) => r.keyword === KEYWORD_A);
		const b = report.rows.find((r) => r.keyword === KEYWORD_B);
		expect(a?.popularity).toBe(62);
		expect(b?.popularity).toBeNull();
	});

	it("names the apps holding the top five slots on the latest observation", async () => {
		await seedRanking({
			date: isoDay(1),
			entries: [[1, RIVAL_ID]],
			id: 1,
			pairId: 1,
		});
		await seedRanking({
			date: isoDay(0),
			entries: [
				[1, RIVAL_ID],
				[2, APP_ID],
				[6, RIVAL_ID],
			],
			id: 2,
			pairId: 1,
		});
		const report = await getReport();
		const row = report.rows.find((r) => r.keyword === KEYWORD_A);
		// Position 6 is outside the top five, so it is not listed.
		expect(row?.topResults.map((r) => r.name)).toStrictEqual([
			"Rival App",
			"Tracked App",
		]);
		expect(row?.topResults[0]).toMatchObject({ appId: RIVAL_ID, position: 1 });
	});

	it("defaults to the fr storefront and a 30-day window", async () => {
		const res = await worker.fetch(apiRequest(`/apps/${APP_ID}/report`), env);
		const report = (await res.json()) as { storefront: string; days: number };
		expect(report).toMatchObject({ days: 30, storefront: "fr" });
	});

	it("clamps an absurd window to the 400-day cap", async () => {
		const report = await getReport("?storefront=fr&days=9999");
		expect(report.days).toBe(400);
	});

	it("falls back to the default window on a junk days value", async () => {
		const report = await getReport("?storefront=fr&days=abc");
		expect(report.days).toBe(30);
	});

	it("returns another user's keywords to nobody", async () => {
		await env.DB.prepare(
			"UPDATE tracked_keyword SET user_id = 'someone-else'"
		).run();
		const report = await getReport();
		expect(report.rows).toStrictEqual([]);
		expect(report.stats.averageRank).toBeNull();
	});
});

describe("GET /apps/:appId/storefronts", () => {
	it("lists the storefronts the app is tracked in, with keyword counts", async () => {
		const res = await worker.fetch(
			apiRequest(`/apps/${APP_ID}/storefronts`),
			env
		);
		const rows = (await res.json()) as {
			code: string;
			name: string;
			keywords: number;
		}[];
		expect(rows).toStrictEqual([
			{ code: "fr", keywords: 2, name: "France" },
			{ code: "us", keywords: 1, name: "United States" },
		]);
	});

	it("hides an app nobody tracks behind a 404", async () => {
		const res = await worker.fetch(apiRequest("/apps/999/storefronts"), env);
		expect(res.status).toBe(404);
	});
});
