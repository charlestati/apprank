import { describe, it, expect } from "vitest";

import {
	ADS_CATEGORIES,
	ADS_CATEGORY_BY_GENRE_ID,
	resolveAdsCategory,
} from "../src/lib/ads-genres";
import {
	allocate,
	computeCapacity,
	measureOverheadPerDay,
	planCadence,
	INTERVAL_LADDER_DAYS,
} from "../src/lib/budget";

describe(computeCapacity, () => {
	it("turns the learned rate and window into a daily fetch budget", () => {
		// 4/min for 3 hours = 720 fetches, minus what the app-level pulls cost.
		const c = computeCapacity({
			overheadPerDay: 120,
			ratePerMin: 4,
			windowHours: 3,
		});
		expect(c.totalPerDay).toBe(720);
		expect(c.keywordsPerDay).toBe(600);
	});

	it("never reports negative capacity when overhead exceeds the window", () => {
		const c = computeCapacity({
			overheadPerDay: 500,
			ratePerMin: 1,
			windowHours: 1,
		});
		expect(c.totalPerDay).toBe(60);
		expect(c.keywordsPerDay).toBe(0);
	});
});

describe(measureOverheadPerDay, () => {
	it("counts a lookup and a review feed per app-storefront, plus charts", () => {
		// 12 app-storefronts × 2 = 24, plus 12 storefronts × 2 genres × 3 charts.
		expect(
			measureOverheadPerDay({
				appStorefrontPairs: 12,
				chartGenres: 2,
				storefronts: 12,
			})
		).toBe(96);
	});

	it("is zero before anything is tracked", () => {
		expect(
			measureOverheadPerDay({
				appStorefrontPairs: 0,
				chartGenres: 2,
				storefronts: 0,
			})
		).toBe(0);
	});
});

describe(allocate, () => {
	it("checks everything daily when the budget covers it", () => {
		const a = allocate(300, 600);
		expect(a).toMatchObject({ fastCount: 300, fastDays: 1, slowDays: 1 });
		expect(a.saturated).toBeFalsy();
	});

	it("splits across two rungs so the load fits the budget exactly", () => {
		// 400 pairs, 300 fetches/day ⇒ 0.75 checks per pair per day.
		const a = allocate(400, 300);
		expect(a.fastDays).toBe(1);
		expect(a.slowDays).toBe(2);
		expect(a.fastCount).toBe(200);
		expect(a.loadPerDay).toBeCloseTo(300, 5);
	});

	it("reaches for a slower rung as demand grows", () => {
		// 900 pairs on the same 300/day budget ⇒ one check every three days.
		const a = allocate(900, 300);
		expect(a.slowDays).toBeGreaterThanOrEqual(3);
		expect(a.loadPerDay).toBeLessThanOrEqual(301);
	});

	it("never spaces a pair beyond the floor rung, and says when it is there", () => {
		const slowest = INTERVAL_LADDER_DAYS.at(-1) as number;
		const a = allocate(10_000, 100);
		expect(a.slowDays).toBe(slowest);
		expect(a.fastCount).toBe(0);
		expect(a.saturated).toBeTruthy();
		// Coverage is kept even though the budget is overrun: that is the trade.
		expect(a.loadPerDay).toBeGreaterThan(100);
	});

	it("keeps everything daily when there is nothing else to spend on", () => {
		expect(allocate(1, 600)).toMatchObject({ fastCount: 1, fastDays: 1 });
	});

	it("handles an empty tracked set", () => {
		expect(allocate(0, 600)).toMatchObject({ fastCount: 0, loadPerDay: 0 });
	});

	it("degrades smoothly as pairs are added, one rung at a time", () => {
		const loads = [300, 600, 900, 1800].map((n) => allocate(n, 600));
		for (const a of loads) {
			expect(a.loadPerDay).toBeLessThanOrEqual(601);
		}
		// Slower rungs only appear as demand grows.
		expect(loads[0]?.slowDays).toBe(1);
		expect(loads.at(-1)?.slowDays).toBeGreaterThan(1);
	});
});

describe(planCadence, () => {
	const capacity = computeCapacity({
		overheadPerDay: 0,
		ratePerMin: 4,
		windowHours: 3,
	});

	it("summarises a comfortable budget", () => {
		expect(planCadence(300, capacity).summary).toBe(
			"All 300 pairs checked daily."
		);
	});

	it("summarises a split plan with both rungs", () => {
		const plan = planCadence(900, capacity);
		expect(plan.summary).toMatch(/pairs every 1d, .* every 2d/u);
	});

	it("says when the budget is saturated", () => {
		const plan = planCadence(20_000, capacity);
		expect(plan.saturated).toBeTruthy();
		expect(plan.summary).toContain("floor resolution");
	});

	it("says when nothing is tracked", () => {
		expect(planCadence(0, capacity).summary).toBe("Nothing tracked yet.");
	});
});

describe(resolveAdsCategory, () => {
	it("lifts a sub-genre to the top-level category Apple actually reports", () => {
		// Games/Word carries no popularity of its own; the ranked list is GAMES-wide.
		expect(resolveAdsCategory({ id: 7019, parent_id: 6014 })).toStrictEqual({
			category: "GAMES",
			genreId: 6014,
		});
	});

	it("accepts a top-level genre unchanged", () => {
		expect(resolveAdsCategory({ id: 6017, parent_id: null })).toStrictEqual({
			category: "EDUCATION",
			genreId: 6017,
		});
	});

	it("returns null for a genre with no Apple category, rather than inventing one", () => {
		expect(resolveAdsCategory({ id: 36, parent_id: null })).toBeNull();
	});

	it("lets a collector_state override win, so a new category is a row edit", () => {
		expect(
			resolveAdsCategory({ id: 7019, parent_id: 6014 }, { 6014: "PUZZLES" })
		).toStrictEqual({ category: "PUZZLES", genreId: 6014 });
	});

	it("maps every category Apple accepts", () => {
		const mapped = new Set(Object.values(ADS_CATEGORY_BY_GENRE_ID));
		expect([...ADS_CATEGORIES].every((c) => mapped.has(c))).toBeTruthy();
	});
});
