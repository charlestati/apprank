/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import worker from "../src/index";
import {
	APP_ID,
	KEYWORD_A,
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

/** A ranking whose stored result_ids run deeper than the indexed top ten. */
async function seedDeepResults() {
	await env.DB.prepare(
		`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
     VALUES (1, 1, ?1, 0, 200, 3, ?2, 'test', 1)`
	)
		.bind(isoDay(0), JSON.stringify([RIVAL_ID, APP_ID, 999_999]))
		.run();
	await env.DB.prepare(
		"INSERT INTO rank_entry (ranking_id, position, app_id) VALUES (1, 1, ?1)"
	)
		.bind(RIVAL_ID)
		.run();
	await env.DB.prepare(
		`INSERT INTO app_metadata_version (app_id, captured_at, source, icon_url, content_hash)
     VALUES (?1, 100, 'itunes-search', 'https://example.test/rival.png', 'h1')`
	)
		.bind(RIVAL_ID)
		.run();
}

describe("GET /pairs/:pairId/results", () => {
	it("returns the whole result page in order, naming the apps it knows", async () => {
		await seedDeepResults();
		const res = await worker.fetch(apiRequest("/pairs/1/results"), env);
		const body = (await res.json()) as {
			date: string;
			resultCount: number;
			results: {
				position: number;
				appId: number;
				name: string | null;
				iconUrl: string | null;
			}[];
		};

		expect(body.date).toBe(isoDay(0));
		expect(body.resultCount).toBe(3);
		expect(body.results).toHaveLength(3);
		expect(body.results[0]).toMatchObject({
			appId: RIVAL_ID,
			iconUrl: "https://example.test/rival.png",
			name: "Rival App",
			position: 1,
		});
		// An app we have never met keeps its slot and reports a null name rather
		// than being dropped from the page.
		expect(body.results[2]).toMatchObject({ appId: 999_999, name: null });
	});

	it("can be asked for a specific day", async () => {
		await seedRanking({ date: isoDay(3), id: 1, pairId: 1 });
		await seedRanking({ date: isoDay(0), id: 2, pairId: 1 });
		const res = await worker.fetch(
			apiRequest(`/pairs/1/results?date=${isoDay(3)}`),
			env
		);
		const body = (await res.json()) as { date: string };
		expect(body.date).toBe(isoDay(3));
	});

	it("is empty for a pair with no valid observation", async () => {
		const res = await worker.fetch(apiRequest("/pairs/1/results"), env);
		await expect(res.json()).resolves.toStrictEqual({
			date: null,
			resultCount: 0,
			results: [],
		});
	});
});

describe("GET /apps/:appId/report.csv", () => {
	it("serves a downloadable CSV with a row per keyword", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[4, APP_ID]],
			id: 1,
			pairId: 1,
			resultCount: 180,
		});

		const res = await worker.fetch(
			apiRequest(`/apps/${APP_ID}/report.csv?storefront=fr&days=30`),
			env
		);
		expect(res.headers.get("Content-Type")).toContain("text/csv");
		expect(res.headers.get("Content-Disposition")).toContain("attachment");

		const body = await res.text();
		const lines = body.trim().split("\n");
		expect(lines[0]).toBe(
			"keyword,storefront,position,change,change_days_ago,best,worst,popularity,difficulty,difficulty_sample_size,results_total,top_results"
		);
		const ranked = lines.find((l) => l.startsWith(KEYWORD_A));
		expect(ranked).toContain(",fr,4,");
		// Every tracked keyword is present, ranked or not.
		expect(lines).toHaveLength(3);
	});

	it("quotes values that contain a comma", async () => {
		await env.DB.prepare(
			"UPDATE keyword SET text = 'mots, croisés' WHERE id = 1"
		).run();
		const res = await worker.fetch(
			apiRequest(`/apps/${APP_ID}/report.csv?storefront=fr`),
			env
		);
		await expect(res.text()).resolves.toContain('"mots, croisés"');
	});
});
