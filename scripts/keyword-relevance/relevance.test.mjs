import assert from "node:assert/strict";
import { test } from "node:test";

import { cosine, nearest, scoreCandidates, split } from "./relevance.mjs";

const tracked = [
	{ term: "météo locale", vector: [1, 0, 0] },
	{ term: "calendrier", vector: [0, 1, 0] },
];

test("cosine ignores magnitude, which embeddings do not normalise", () => {
	assert.equal(cosine([1, 0], [5, 0]), 1);
	assert.equal(cosine([1, 0], [0, 3]), 0);
});

test("cosine survives a zero vector rather than dividing by zero", () => {
	assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("scores against the nearest tracked term, not their average", () => {
	// A tracked set spans several subjects. Their centroid means none of them,
	// and would rank a term vaguely like everything above one exactly like
	// something.
	const { nearest: match, score } = nearest([0.9, 0.1, 0], tracked);
	assert.equal(match, "météo locale");
	assert.ok(score > 0.9);
});

test("keeps the candidate's own term beside the one it resembles", () => {
	// The nearest result is spread over the candidate, so naming its field
	// `term` would overwrite the term being scored.
	const [row] = scoreCandidates(
		[{ id: 1, term: "météo locale gratuite", vector: [1, 0, 0] }],
		tracked
	);
	assert.equal(row.term, "météo locale gratuite");
	assert.equal(row.nearest, "météo locale");
	assert.equal(row.vector, undefined);
});

test("reports worst first, because the decisions are at the bottom", () => {
	const scored = scoreCandidates(
		[
			{ id: 1, term: "close", vector: [1, 0, 0] },
			{ id: 2, term: "far", vector: [0, 0, 1] },
		],
		tracked
	);
	assert.deepEqual(
		scored.map((s) => s.term),
		["far", "close"]
	);
});

test("splits at the threshold the caller chose", () => {
	const scored = [{ score: 0.5 }, { score: 0.7 }];
	const { drop, keep } = split(scored, 0.6);
	assert.equal(drop.length, 1);
	assert.equal(keep.length, 1);
});
