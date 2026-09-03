import assert from "node:assert/strict";
import { test } from "node:test";

import { comparePair, measure, noiseFloor } from "./churn.mjs";

const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

test("scores a page that did not move", () => {
	const page = ids(20);
	const { moves, drops } = comparePair(page, page);
	assert.equal(drops.length, 0);
	assert.equal(moves.length, 20);
	assert.ok(moves.every((m) => m.delta === 0));
});

test("measures the distance an app travelled", () => {
	const { moves } = comparePair([1, 2, 3], [3, 2, 1]);
	assert.deepEqual(
		moves.map((m) => m.delta),
		[2, 0, 2]
	);
});

test("counts an app that left the page as a drop, not a move", () => {
	const { moves, drops } = comparePair([1, 2, 3], [1, 9, 3]);
	assert.deepEqual(drops, [2]);
	assert.equal(moves.length, 2);
});

test("never calls an app dropped when the second page was too short to hold it", () => {
	// The trap this script exists to avoid. `result_ids` caps at 200 and a page
	// routinely returns fewer, so an app at 180 yesterday that is absent from a
	// 100-app page today has not necessarily moved. Counting it would
	// manufacture the churn being measured.
	const before = ids(200);
	const after = ids(100);
	const { drops, depthLimit } = comparePair(before, after);
	assert.equal(depthLimit, 100);
	assert.deepEqual(drops, []);
});

test("compares consecutive days and skips a gap in the cadence ladder", () => {
	// A pair on the seven-day rung is not seven days' worth of churn.
	const observations = [
		{ date: "2026-09-01", ids: [1, 2, 3], pairId: 1 },
		{ date: "2026-09-02", ids: [1, 3, 2], pairId: 1 },
		{ date: "2026-09-09", ids: [9, 8, 7], pairId: 1 },
	];
	const result = measure(observations);
	assert.equal(result.comparisons, 1);
	assert.equal(result.pairs, 1);
	// Only the 01→02 move counted; the week-long gap contributed no drops.
	assert.equal(result.rows[0].samples, 3);
	assert.equal(result.rows[0].dropRate, 0);
});

test("bands by the position on the earlier day", () => {
	const before = ids(60);
	// Everything below rank 50 leaves; the shallow bands are untouched.
	const after = [...ids(50), ...ids(10, 900)];
	const result = measure([
		{ date: "2026-09-01", ids: before, pairId: 1 },
		{ date: "2026-09-02", ids: after, pairId: 1 },
	]);
	const byBand = Object.fromEntries(result.rows.map((r) => [r.band, r]));
	assert.equal(byBand["1-10"].dropRate, 0);
	assert.equal(byBand["26-50"].dropRate, 0);
	assert.equal(byBand["51-100"].samples, 10);
	assert.equal(byBand["51-100"].dropRate, 1);
});

test("reports the shallowest band that crosses the limit", () => {
	const rows = [
		{ band: "1-10", dropRate: 0 },
		{ band: "11-25", dropRate: 0.02 },
		{ band: "26-50", dropRate: 0.2 },
		{ band: "51-100", dropRate: 0.4 },
	];
	assert.equal(noiseFloor(rows, 0.1), 26);
});

test("returns no floor when the page held together at every depth", () => {
	// Distinguishable from "the floor is at the first band": null means the
	// cutoff is below the data, and reporting 1 would be a different claim.
	const rows = [
		{ band: "1-10", dropRate: 0 },
		{ band: "11-25", dropRate: 0.01 },
	];
	assert.equal(noiseFloor(rows, 0.1), null);
});

test("ignores a band nothing was ever observed in", () => {
	const rows = [
		{ band: "1-10", dropRate: null, samples: 0 },
		{ band: "11-25", dropRate: 0.5, samples: 4 },
	];
	assert.equal(noiseFloor(rows, 0.1), 11);
});
