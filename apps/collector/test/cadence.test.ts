/* oxlint-disable vitest/require-top-level-describe -- the seeding hook is a
   file-wide precondition for every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import { recomputeCadence } from "../src/tasks/cadence";

const APP_ID = 424_242;

/** The first 03:00 UTC window start strictly after `ms`, as crawl.ts sets it. */
function windowAfter(ms: number): number {
	const next = new Date(ms);
	next.setUTCHours(3, 0, 0, 0);
	if (next.getTime() <= ms) {
		next.setUTCDate(next.getUTCDate() + 1);
	}
	return next.getTime();
}

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM rank_entry"),
		env.DB.prepare("DELETE FROM ranking"),
		env.DB.prepare("DELETE FROM popularity"),
		env.DB.prepare("DELETE FROM collector_state"),
		env.DB.prepare("DELETE FROM crawl_pair"),
		env.DB.prepare("DELETE FROM tracked_keyword"),
		env.DB.prepare("DELETE FROM app_language"),
		env.DB.prepare("DELETE FROM tracked_app"),
		env.DB.prepare("DELETE FROM keyword"),
		env.DB.prepare("DELETE FROM app"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront_locale (storefront_code, locale_code, is_default) VALUES ('fr', 'fr-FR', 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, 'Tracked App', 0, 0)"
		).bind(APP_ID),
		env.DB.prepare(
			"INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?1, 0)"
		).bind(APP_ID),
		env.DB.prepare(
			"INSERT OR IGNORE INTO app_language (app_id, language) VALUES (?1, 'fr')"
		).bind(APP_ID),
	]);
}

/** `count` tracked keywords, each with one fr crawl pair. */
async function seedPairs(count: number) {
	const stmts = [];
	for (let i = 1; i <= count; i += 1) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO keyword (id, text, normalized, language) VALUES (?1, ?2, ?2, 'fr')"
			).bind(i, `keyword ${i}`),
			env.DB.prepare(
				"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES ('admin', ?1, ?2, 0)"
			).bind(APP_ID, i),
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at)
         VALUES (?1, ?1, 'fr', 'fr-FR', 1, 1, 24, 0)`
			).bind(i)
		);
	}
	for (let i = 0; i < stmts.length; i += 60) {
		await env.DB.batch(stmts.slice(i, i + 60));
	}
}

async function setRate(ratePerMin: number) {
	await env.DB.prepare(
		"INSERT OR REPLACE INTO collector_state (key, value, updated_at) VALUES ('pacing', ?1, 0)"
	)
		.bind(
			JSON.stringify({
				lastErrorAt: 0,
				lastRaiseDay: "",
				pauseUntil: 0,
				ratePerMin,
				windowErrorCount: 0,
			})
		)
		.run();
}

function intervals(): Promise<Record<string, number>> {
	return env.DB.prepare(
		"SELECT interval_hours AS h, COUNT(*) AS n FROM crawl_pair GROUP BY interval_hours"
	)
		.all<{ h: number; n: number }>()
		.then((r) =>
			Object.fromEntries(r.results.map((row) => [String(row.h), row.n]))
		);
}

beforeEach(async () => {
	await reset();
});

describe(recomputeCadence, () => {
	it("keeps every pair daily while the budget has room", async () => {
		await seedPairs(20);
		await setRate(4); // 4/min × 3h = 720/day, far more than 20 pairs need
		const plan = await recomputeCadence(env);

		expect(plan.pairs).toBe(20);
		expect(plan.saturated).toBeFalsy();
		await expect(intervals()).resolves.toStrictEqual({ "24": 20 });
	});

	it("stretches the low-priority tail when demand outgrows the rate", async () => {
		await seedPairs(60);
		// 0.2/min × 3h = 36 fetches/day for 60 pairs, minus overhead.
		await setRate(0.2);
		const plan = await recomputeCadence(env);

		expect(plan.fastCount).toBeLessThan(60);
		expect(plan.slowDays).toBeGreaterThan(1);
		const spread = await intervals();
		// Coverage is intact: every pair still has an interval.
		expect(Object.values(spread).reduce((a, b) => a + b, 0)).toBe(60);
		expect(Object.keys(spread).length).toBeGreaterThan(1);
	});

	it("never drops a pair, even when the budget cannot cover the floor", async () => {
		await seedPairs(40);
		await setRate(0.02); // ~3 fetches a day
		const plan = await recomputeCadence(env);

		expect(plan.saturated).toBeTruthy();
		const spread = await intervals();
		expect(spread).toStrictEqual({ "168": 40 });
		const live = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM crawl_pair WHERE ref_count > 0"
		).first<{ n: number }>();
		expect(live?.n).toBe(40);
	});

	it("charges the app-level pulls against the same budget", async () => {
		await seedPairs(10);
		await setRate(0.1); // 18 fetches/day total, and the overhead comes first
		const plan = await recomputeCadence(env);

		// One app × one storefront = 2 fetches, plus 1 storefront × 2 genres × 3
		// chart pulls = 6, so 8 of the 18 are spoken for.
		expect(plan.capacity.overheadPerDay).toBe(8);
		expect(plan.capacity.keywordsPerDay).toBe(10);
	});

	it("pins a pair inside its metadata-change burst to daily", async () => {
		await seedPairs(60);
		await setRate(0.2);
		// Pair 60 would score last without the burst.
		await env.DB.prepare("UPDATE crawl_pair SET burst_until = ?1 WHERE id = 60")
			.bind(Date.now() + 7 * 24 * 3_600_000)
			.run();

		await recomputeCadence(env);
		const row = await env.DB.prepare(
			"SELECT interval_hours FROM crawl_pair WHERE id = 60"
		).first<{ interval_hours: number }>();
		expect(row?.interval_hours).toBe(24);
	});

	it("ranks a volatile, popular, top-10 pair above a flat long-tail one", async () => {
		await seedPairs(40);
		await setRate(0.15);

		// Pair 1: bouncing around the top-10 boundary on a popular term.
		// Pair 2: pinned at 190 on a term nobody searches.
		let rankingId = 1;
		for (const [day, a, b] of [
			[5, 8, 190],
			[4, 14, 190],
			[3, 7, 190],
			[2, 15, 190],
			[1, 9, 190],
		] as const) {
			const date = new Date(Date.now() - day * 86_400_000)
				.toISOString()
				.slice(0, 10);
			for (const [pair, pos] of [
				[1, a],
				[2, b],
			] as const) {
				await env.DB.prepare(
					`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
           VALUES (?1, ?2, ?3, 0, 200, 200, '[]', 'test', 1)`
				)
					.bind(rankingId, pair, date)
					.run();
				await env.DB.prepare(
					"INSERT INTO rank_entry (ranking_id, position, app_id) VALUES (?1, ?2, ?3)"
				)
					.bind(rankingId, pos, APP_ID)
					.run();
				rankingId += 1;
			}
		}
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (1, 'fr', 7019, '2026-08-16', 1, 85, 0)`
			),
			env.DB.prepare(
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, fetched_at)
         VALUES (2, 'fr', 7019, '2026-08-16', 1, 5, 0)`
			),
		]);

		await recomputeCadence(env);
		const rows = await env.DB.prepare(
			"SELECT id, interval_hours, volatility FROM crawl_pair WHERE id IN (1, 2) ORDER BY id"
		).all<{ id: number; interval_hours: number; volatility: number }>();
		const [hot, cold] = rows.results;
		expect(hot?.volatility).toBeGreaterThan(0);
		expect(cold?.volatility).toBe(0);
		expect(hot?.interval_hours).toBeLessThan(cold?.interval_hours ?? 0);
	});

	it("pulls a due date forward when a pair speeds up", async () => {
		await seedPairs(5);
		await setRate(4);
		const lastFetched = Date.now() - 3_600_000;
		await env.DB.prepare(
			"UPDATE crawl_pair SET interval_hours = 168, last_fetched_at = ?1, next_due_at = ?2"
		)
			.bind(lastFetched, lastFetched + 168 * 3_600_000)
			.run();

		await recomputeCadence(env);
		const row = await env.DB.prepare(
			"SELECT interval_hours, next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ interval_hours: number; next_due_at: number }>();
		expect(row?.interval_hours).toBe(24);
		expect(row?.next_due_at).toBe(windowAfter(lastFetched));
	});

	it("aligns a pulled-in due date to the crawl window, not the fetch clock", async () => {
		// The 2026-09-03 shape: crawled at 08:28, so last_fetched + 24h lands five
		// hours after the 03:10 run has already drained and exited, and the pair
		// loses the day. The deadline has to be the window start, as crawl.ts sets
		// it, or every pair alternates between "not yet due" and "overdue".
		await seedPairs(2);
		const fetched = new Date();
		fetched.setUTCHours(8, 28, 0, 0);
		const lastFetched = fetched.getTime();
		const aligned = windowAfter(lastFetched);
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE crawl_pair SET last_fetched_at = ?1, next_due_at = ?2 WHERE id = 1"
			).bind(lastFetched, lastFetched + 24 * 3_600_000),
			env.DB.prepare(
				"UPDATE crawl_pair SET last_fetched_at = ?1, next_due_at = ?2 WHERE id = 2"
			).bind(lastFetched, aligned),
		]);

		await recomputeCadence(env);
		const rows = await env.DB.prepare(
			"SELECT id, next_due_at FROM crawl_pair ORDER BY id"
		).all<{ id: number; next_due_at: number }>();
		expect(rows.results.map((r) => r.next_due_at)).toStrictEqual([
			aligned,
			aligned,
		]);
	});

	it("leaves a never-fetched pair due now", async () => {
		await seedPairs(1);
		await recomputeCadence(env);
		const row = await env.DB.prepare(
			"SELECT next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ next_due_at: number }>();
		expect(row?.next_due_at).toBe(0);
	});

	it("records the plan for the data-health page", async () => {
		await seedPairs(12);
		await setRate(4);
		await recomputeCadence(env);
		const row = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'cadence_plan'"
		).first<{ value: string }>();
		const stored = JSON.parse(row?.value ?? "{}");
		expect(stored.pairs).toBe(12);
		expect(stored.summary).toContain("daily");
		expect(stored.computedAt).toBeGreaterThan(0);
	});

	it("copes with nothing tracked at all", async () => {
		await setRate(4);
		const plan = await recomputeCadence(env);
		expect(plan.pairs).toBe(0);
		expect(plan.summary).toBe("Nothing tracked yet.");
	});
});
