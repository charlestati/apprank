/* oxlint-disable vitest/require-top-level-describe -- the seeding hook is a
   file-wide precondition for every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import {
	computeDifficulty,
	difficultyBand,
	FORMULA_VERSION,
} from "../src/lib/difficulty";
import { recomputeDifficulty } from "../src/tasks/difficulty";

const TRACKED = 424_242;

function input(over: Partial<Parameters<typeof computeDifficulty>[0]> = {}) {
	return {
		distinctTopTenApps: 10,
		resultCount: 200,
		topThreeRatings: [1000, 800, 600],
		topTenRatings: [1000, 800, 600, 400, 300, 200, 150, 120, 100, 80],
		...over,
	};
}

describe(computeDifficulty, () => {
	it("scores an open keyword low and an entrenched one high", () => {
		const open = computeDifficulty(
			input({
				distinctTopTenApps: 30,
				resultCount: 20,
				topThreeRatings: [5, 3, 1],
				topTenRatings: [5, 3, 1, 1, 0, 0, 0, 0, 0, 0],
			})
		);
		const closed = computeDifficulty(
			input({
				topThreeRatings: [900_000, 500_000, 400_000],
				topTenRatings: Array.from({ length: 10 }, () => 500_000),
			})
		);
		expect(open.score).toBeLessThan(25);
		expect(closed.score).toBeGreaterThan(75);
	});

	it("weighs the top three above the rest of the page", () => {
		const strongLeaders = computeDifficulty(
			input({
				topThreeRatings: [500_000, 400_000, 300_000],
				topTenRatings: [500_000, 400_000, 300_000, 10, 10, 10, 10, 10, 10, 10],
			})
		);
		const strongTail = computeDifficulty(
			input({
				topThreeRatings: [10, 10, 10],
				topTenRatings: [10, 10, 10, 500_000, 400_000, 300_000, 10, 10, 10, 10],
			})
		);
		expect(strongLeaders.score).toBeGreaterThan(strongTail.score);
	});

	it("treats a board that keeps turning over as more reachable", () => {
		const stable = computeDifficulty(input({ distinctTopTenApps: 10 }));
		const churning = computeDifficulty(input({ distinctTopTenApps: 40 }));
		expect(stable.score).toBeGreaterThan(churning.score);
		expect(stable.stability).toBe(1);
		expect(churning.stability).toBeCloseTo(0.25, 5);
	});

	it("nudges the score with how full the result page is", () => {
		const full = computeDifficulty(input({ resultCount: 200 }));
		const sparse = computeDifficulty(input({ resultCount: 10 }));
		expect(full.score).toBeGreaterThan(sparse.score);
		expect(full.saturation).toBe(1);
		expect(sparse.saturation).toBeCloseTo(0.05, 5);
	});

	it("keeps every input beside the score so the formula can be revised", () => {
		const d = computeDifficulty(input());
		expect(d.formulaVersion).toBe(FORMULA_VERSION);
		expect(d.sampleSize).toBe(10);
		expect(d.entrenchment).toBeGreaterThan(0);
		expect(d.incumbentStrength).toBeGreaterThan(0);
	});

	it("reports the sample size when the page is only partly known", () => {
		const d = computeDifficulty(
			input({ topThreeRatings: [500], topTenRatings: [500, 300] })
		);
		expect(d.sampleSize).toBe(2);
	});

	it("stays inside 0–100 for absurd inputs", () => {
		const huge = computeDifficulty(
			input({
				distinctTopTenApps: 0,
				resultCount: 10_000,
				topThreeRatings: [50_000_000],
				topTenRatings: [50_000_000],
			})
		);
		expect(huge.score).toBeLessThanOrEqual(100);
		expect(huge.score).toBeGreaterThanOrEqual(0);

		const empty = computeDifficulty(
			input({ resultCount: 0, topThreeRatings: [], topTenRatings: [] })
		);
		expect(empty.score).toBe(0);
	});
});

describe(difficultyBand, () => {
	it("names each band", () => {
		expect(difficultyBand(95)).toBe("very hard");
		expect(difficultyBand(65)).toBe("hard");
		expect(difficultyBand(45)).toBe("moderate");
		expect(difficultyBand(25)).toBe("reachable");
		expect(difficultyBand(5)).toBe("open");
	});
});

async function seed() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM keyword_difficulty"),
		env.DB.prepare("DELETE FROM rank_entry"),
		env.DB.prepare("DELETE FROM ranking"),
		env.DB.prepare("DELETE FROM app_metadata_version"),
		env.DB.prepare("DELETE FROM crawl_pair"),
		env.DB.prepare("DELETE FROM tracked_keyword"),
		env.DB.prepare("DELETE FROM keyword"),
		env.DB.prepare("DELETE FROM app"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
		),
		env.DB.prepare(
			"INSERT INTO keyword (id, text, normalized, language) VALUES (1, 'kw', 'kw', 'fr')"
		),
		env.DB.prepare(
			`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at)
       VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, 0)`
		),
	]);
}

/** An app with a known rating count, plus its slot on a result page. */
async function seedApp(appId: number, ratingCount: number) {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, ?2, 0, 0)"
		).bind(appId, `App ${appId}`),
		env.DB.prepare(
			`INSERT INTO app_metadata_version (app_id, captured_at, source, rating_count, content_hash)
       VALUES (?1, ?2, 'itunes-search', ?3, ?4)`
		).bind(appId, Date.now(), ratingCount, `hash-${appId}-${ratingCount}`),
	]);
}

async function seedRanking(
	id: number,
	date: string,
	entries: [number, number][],
	resultCount = 200
) {
	await env.DB.prepare(
		`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
     VALUES (?1, 1, ?2, 0, 200, ?3, '[]', 'test', 1)`
	)
		.bind(id, date, resultCount)
		.run();
	for (const [position, appId] of entries) {
		await env.DB.prepare(
			"INSERT INTO rank_entry (ranking_id, position, app_id) VALUES (?1, ?2, ?3)"
		)
			.bind(id, position, appId)
			.run();
	}
}

function isoDay(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
	await seed();
});

describe(recomputeDifficulty, () => {
	it("scores the latest observation from the rating counts on the page", async () => {
		for (const [i, ratings] of [900_000, 400_000, 200_000, 500].entries()) {
			await seedApp(100 + i, ratings);
		}
		await seedRanking(1, isoDay(1), [
			[1, 100],
			[2, 101],
			[3, 102],
			[4, 103],
		]);

		const run = await recomputeDifficulty(env);
		expect(run.scored).toBe(1);

		const row = await env.DB.prepare(
			"SELECT * FROM keyword_difficulty WHERE pair_id = 1"
		).first<Record<string, number | string>>();
		expect(row?.observed_date).toBe(isoDay(1));
		expect(row?.score).toBeGreaterThan(50);
		expect(row?.sample_size).toBe(4);
		expect(row?.formula_version).toBe(FORMULA_VERSION);
	});

	it("skips a page it holds no rating counts for rather than inventing one", async () => {
		// The apps exist, but no metadata version was ever captured.
		await env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (900, 'Unknown', 0, 0)"
		).run();
		await seedRanking(1, isoDay(1), [[1, 900]]);

		const run = await recomputeDifficulty(env);
		expect(run.scored).toBe(0);
		expect(run.skipped).toBe(1);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM keyword_difficulty"
		).first<{ n: number }>();
		expect(rows?.n).toBe(0);
	});

	it("counts turnover across the recent window, not just the latest day", async () => {
		await seedApp(100, 50_000);
		await seedApp(101, 40_000);
		await seedApp(102, 30_000);
		// Three different apps have held the top slot over three days.
		await seedRanking(1, isoDay(3), [[1, 100]]);
		await seedRanking(2, isoDay(2), [[1, 101]]);
		await seedRanking(3, isoDay(1), [[1, 102]]);

		await recomputeDifficulty(env);
		const row = await env.DB.prepare(
			"SELECT stability FROM keyword_difficulty WHERE pair_id = 1"
		).first<{ stability: number }>();
		// 3 distinct apps for 10 slots reads as wide open.
		expect(row?.stability).toBe(1);
	});

	it("re-running replaces the score rather than duplicating it", async () => {
		await seedApp(100, 10_000);
		await seedRanking(1, isoDay(1), [[1, 100]]);
		await recomputeDifficulty(env);
		await recomputeDifficulty(env);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM keyword_difficulty WHERE pair_id = 1"
		).first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it("ignores invalid observations", async () => {
		await seedApp(100, 10_000);
		await seedRanking(1, isoDay(1), [[1, 100]]);
		await env.DB.prepare("UPDATE ranking SET valid = 0").run();
		const run = await recomputeDifficulty(env);
		expect(run.scored).toBe(0);
	});

	it("does nothing when nothing has been observed", async () => {
		const run = await recomputeDifficulty(env);
		expect(run).toStrictEqual({ scored: 0, skipped: 0 });
	});

	it("keeps a tracked app's own rating count out of nowhere", async () => {
		// The tracked app sits on its own result page; its ratings count like any
		// other incumbent's, which is correct — it is part of the competition.
		await seedApp(TRACKED, 70);
		await seedApp(100, 900_000);
		await seedRanking(1, isoDay(1), [
			[1, 100],
			[2, TRACKED],
		]);
		await recomputeDifficulty(env);
		const row = await env.DB.prepare(
			"SELECT sample_size FROM keyword_difficulty WHERE pair_id = 1"
		).first<{ sample_size: number }>();
		expect(row?.sample_size).toBe(2);
	});
});
