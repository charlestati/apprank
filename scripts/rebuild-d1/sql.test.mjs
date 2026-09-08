import assert from "node:assert/strict";
import { test } from "node:test";

import {
	appPlaceholders,
	buildSql,
	rankEntryInserts,
	rankEntryRows,
	rankingInsert,
	sqlEscape,
} from "./sql.mjs";

const ids = (n, from = 100) => Array.from({ length: n }, (_, i) => from + i);
const tableOf = (line) => line.split(" INTO ")[1].split(" ")[0];

const observation = (over = {}) => ({
	collectorVersion: "1.2.3",
	date: "2026-09-08",
	fetchedAt: 1_788_857_499_123,
	httpStatus: 200,
	pairId: 649,
	responseMs: 2700,
	resultCount: 50,
	resultIds: ids(50),
	...over,
});

test("indexes the top ten and nothing deeper when nothing is tracked", () => {
	const rows = rankEntryRows(observation(), new Set());
	assert.equal(rows.length, 10);
	assert.deepEqual(
		rows.map((r) => r.position),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
	);
});

test("also indexes a tracked app found deep in the page, at its real position", () => {
	const o = observation();
	o.resultIds[36] = 6_444_546_871;
	const rows = rankEntryRows(o, new Set([6_444_546_871]));
	assert.equal(rows.length, 11);
	assert.deepEqual(rows.at(-1), { appId: 6_444_546_871, position: 37 });
});

test("does not index a tracked app twice when it is already in the top ten", () => {
	const o = observation();
	const rows = rankEntryRows(o, new Set([o.resultIds[0]]));
	assert.equal(rows.length, 10);
});

test("a short page indexes only what it holds", () => {
	const rows = rankEntryRows(
		observation({ resultIds: ids(2), resultCount: 2 }),
		new Set()
	);
	assert.equal(rows.length, 2);
});

test("rank_entry rows resolve the ranking id by natural key, never by a guessed id", () => {
	const [first] = rankEntryInserts(observation(), new Set());
	assert.match(
		first,
		/VALUES \(\(SELECT id FROM ranking WHERE pair_id = 649 AND observed_date = '2026-09-08'\), 1, 100\);$/u
	);
	assert.match(first, /^INSERT OR IGNORE INTO rank_entry/u);
});

test("the ranking insert keeps provenance and never overwrites a live row", () => {
	const sql = rankingInsert(observation());
	assert.match(sql, /'1\.2\.3'/u);
	assert.match(sql, /2700/u);
	assert.match(sql, /ON CONFLICT\(pair_id, observed_date\) DO NOTHING;$/u);
});

test("a missing response time becomes NULL, not undefined", () => {
	const sql = rankingInsert(observation({ responseMs: undefined }));
	assert.match(sql, /200, NULL, 50,/u);
});

test("one app placeholder per app across observations, spanning its seen dates", () => {
	const a = observation({ fetchedAt: 100, pairId: 1 });
	const b = observation({ fetchedAt: 300, pairId: 2, resultIds: ids(50, 105) });
	const rows = appPlaceholders([a, b], new Set());
	// a indexes 100..109, b indexes 105..114: 15 distinct apps.
	assert.equal(rows.length, 15);
	assert.ok(
		rows.includes(
			"INSERT OR IGNORE INTO app (id, first_seen_at, last_seen_at) VALUES (105, 100, 300);"
		)
	);
	assert.ok(
		rows.includes(
			"INSERT OR IGNORE INTO app (id, first_seen_at, last_seen_at) VALUES (100, 100, 100);"
		)
	);
});

test("emits rankings, then apps, then rank_entry, so every reference resolves", () => {
	const lines = buildSql(
		[observation(), observation({ pairId: 650 })],
		new Set()
	);
	const kinds = lines.map(tableOf);
	assert.deepEqual([...new Set(kinds)], ["ranking", "app", "rank_entry"]);
	assert.equal(kinds.filter((k) => k === "ranking").length, 2);
	assert.equal(kinds.filter((k) => k === "rank_entry").length, 20);
});

test("escapes quotes and passes NULL through", () => {
	assert.equal(sqlEscape("it's"), "'it''s'");
	assert.equal(sqlEscape(null), "NULL");
	assert.equal(sqlEscape(), "NULL");
});
