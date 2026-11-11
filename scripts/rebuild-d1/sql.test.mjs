/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
	STOREFRONT_WIDE_GENRE_ID,
	adsRows,
	appPlaceholders,
	buildAdsSql,
	buildSql,
	byMonth,
	findDrift,
	inRange,
	isIsoDate,
	parseGenreKey,
	parseTermsKey,
	partFile,
	rankEntryInserts,
	rankEntryRows,
	rankingInsert,
	rankingKeyDate,
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

const genreKey = "ads/popularity/2026-08-23/fr/6014-GAMES.json";
const termsKey = "ads/popularity-terms/2026-08-23/fr/0129.json";
const body = {
	result: {
		rows: [
			{
				genre: "GAMES",
				rankInGenre: 58,
				searchPopularity1to100: 64,
				searchPopularity1to5: 4,
				searchTerm: "Radar",
			},
		],
	},
};

test("Apple Ads rebuild: keeps the genre id the rows were stored under", () => {
	assert.deepEqual(parseGenreKey(genreKey), {
		category: "GAMES",
		genreId: 6014,
		storefront: "fr",
		week: "2026-08-23",
	});
});

test("Apple Ads rebuild: refuses the older key that names only the category", () => {
	// PRODUCTIVITY_UTILITIES is the Ads category for two genres, so the
	// dimension is unrecoverable and a rebuild must skip rather than guess.
	assert.equal(parseGenreKey("ads/popularity/2026-08-23/fr/GAMES.json"), null);
});

test("Apple Ads rebuild: reads by-name keys with and without the chunk hash", () => {
	const want = { storefront: "fr", week: "2026-08-23" };
	assert.deepEqual(parseTermsKey(termsKey), want);
	assert.deepEqual(
		parseTermsKey("ads/popularity-terms/2026-08-23/fr/0129-0a1b2c3d.json"),
		want
	);
});

test("Apple Ads rebuild: files a by-name row as storefront-wide, with no rank", () => {
	const [row] = adsRows(body, parseTermsKey(termsKey), 1000);
	assert.equal(row.genreId, STOREFRONT_WIDE_GENRE_ID);
	assert.equal(row.rankInGenre, null);
	assert.equal(row.popularity1to100, 64);
});

test("Apple Ads rebuild: matches keywords on the collector's own normalization", () => {
	const [sql] = buildAdsSql([], adsRows(body, parseTermsKey(termsKey), 1000));
	assert.match(sql, /k\.normalized = 'radar'/u);
	assert.match(
		sql,
		/ON CONFLICT\(keyword_id, storefront_code, genre_id, week_start\) DO NOTHING/u
	);
});

test("Apple Ads rebuild: never overwrites a popularity row the collector wrote", () => {
	const rows = adsRows(body, parseGenreKey(genreKey), 1000);
	const popularity = buildAdsSql(rows, rows).filter(
		(sql) => tableOf(sql) === "popularity"
	);
	assert.equal(popularity.length, 2);
	for (const sql of popularity) {
		assert.match(sql, /DO NOTHING/u);
	}
});

/** One archived week of the genre list, holding a single term. */
const week = (w, rank, pop) =>
	adsRows(
		{
			result: {
				rows: [
					{
						rankInGenre: rank,
						searchPopularity1to100: pop,
						searchTerm: "radar",
					},
				],
			},
		},
		parseGenreKey(`ads/popularity/${w}/fr/6014-GAMES.json`),
		1000
	);

test("Apple Ads rebuild: a month's seed_term row ends on its latest week, as the collector leaves it", () => {
	// seed_term is keyed by month and fed weekly. Listed out of order on
	// purpose: the rebuild must not depend on the order R2 returns keys in.
	const rows = [
		...week("2026-08-16", 40, 70),
		...week("2026-08-02", 90, 30),
		...week("2026-08-09", 60, 50),
	];
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE seed_term (id INTEGER PRIMARY KEY, month TEXT NOT NULL, storefront_code TEXT NOT NULL, genre_id INTEGER NOT NULL, term TEXT NOT NULL, rank_in_genre INTEGER, popularity_1_100 INTEGER);" +
			"CREATE UNIQUE INDEX st_unique ON seed_term (month, storefront_code, genre_id, term);"
	);
	// A row the collector already wrote from an earlier week of the month.
	db.exec(
		"INSERT INTO seed_term (month, storefront_code, genre_id, term, rank_in_genre, popularity_1_100) VALUES ('2026-08', 'fr', 6014, 'radar', 90, 30);"
	);
	for (const sql of buildAdsSql(rows, []).filter(
		(line) => tableOf(line) === "seed_term"
	)) {
		db.exec(sql);
	}
	assert.deepEqual(
		{
			...db
				.prepare("SELECT month, rank_in_genre, popularity_1_100 FROM seed_term")
				.get(),
		},
		{ month: "2026-08", popularity_1_100: 70, rank_in_genre: 40 }
	);
});

test("Apple Ads rebuild: writes no absences, because the archive holds answers and not questions", () => {
	const rows = adsRows(body, parseGenreKey(genreKey), 1000);
	for (const sql of buildAdsSql(rows, rows)) {
		assert.doesNotMatch(sql, /, 0, /u);
	}
});

test("reads the observed date from a compacted key and nothing else", () => {
	assert.equal(
		rankingKeyDate("rankings/v1/2026-09/fr/2026-09-08.ndjson"),
		"2026-09-08"
	);
	assert.equal(rankingKeyDate("staging/rankings/2026-09-08/649.json"), null);
	assert.equal(rankingKeyDate("rankings/v1/2026-09/fr/latest.ndjson"), null);
});

test("a range is inclusive on both ends and open where no bound is given", () => {
	assert.ok(inRange("2026-09-08", "2026-09-08", "2026-09-08"));
	assert.ok(!inRange("2026-09-07", "2026-09-08", null));
	assert.ok(!inRange("2026-09-09", null, "2026-09-08"));
	assert.ok(inRange("2026-09-09", null, null));
	assert.ok(isIsoDate("2026-09-08"));
	assert.ok(!isIsoDate("2026-9-8"));
	assert.ok(!isIsoDate("abc"));
	assert.ok(!isIsoDate(""));
});

test("splits the archive into one part per month, each named after it", () => {
	// One joined string for the whole archive threw at V8's string limit; a
	// month at a time never holds more than a month.
	const months = byMonth([
		"rankings/v1/2026-10/fr/2026-10-01.ndjson",
		"rankings/v1/2026-09/fr/2026-09-30.ndjson",
		"rankings/v1/2026-09/ca/2026-09-30.ndjson",
		"rankings/v1/2026-09/fr/not-a-date.ndjson",
	]);
	assert.deepEqual([...months.keys()], ["2026-09", "2026-10"]);
	assert.equal(months.get("2026-09").length, 2);
	assert.equal(partFile("rebuild.sql", "2026-09"), "rebuild-2026-09.sql");
	assert.equal(partFile("out/rebuild.sql", "ads"), "out/rebuild-ads.sql");
	assert.equal(partFile("./a.b/rebuild", "ads"), "./a.b/rebuild-ads");
});

test("a month's statements apply on their own, and again, without change", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE app (id INTEGER PRIMARY KEY, first_seen_at INTEGER, last_seen_at INTEGER);
		CREATE TABLE ranking (id INTEGER PRIMARY KEY AUTOINCREMENT, pair_id INTEGER, observed_date TEXT,
			fetched_at INTEGER, http_status INTEGER, response_ms INTEGER, result_count INTEGER,
			result_ids TEXT, collector_version TEXT, r2_key TEXT, valid INTEGER,
			UNIQUE (pair_id, observed_date));
		CREATE TABLE rank_entry (ranking_id INTEGER, position INTEGER, app_id INTEGER REFERENCES app(id),
			PRIMARY KEY (ranking_id, position));
	`);
	const september = [observation({ date: "2026-09-08" })];
	const october = [
		observation({ date: "2026-10-01", fetchedAt: 1_790_000_000_000 }),
	];
	for (const part of [september, october, september]) {
		db.exec(buildSql(part, new Set()).join("\n"));
	}
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ranking").get().n, 2);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rank_entry").get().n, 20);
});

test("verify reports drift in both directions, per date", () => {
	const archive = new Map([
		["2026-09-08", new Set([1, 2, 3])],
		["2026-09-09", new Set([1, 2])],
	]);
	const live = new Map([
		["2026-09-08", new Set([1, 2])],
		["2026-09-09", new Set([1, 2, 9])],
	]);
	assert.deepEqual(findDrift(archive, live, "2026-09-20"), [
		{ date: "2026-09-08", missingFromArchive: 0, missingFromD1: 1 },
		{ date: "2026-09-09", missingFromArchive: 1, missingFromD1: 0 },
	]);
});

test("verify finds no drift when the two agree", () => {
	const archive = new Map([["2026-09-08", new Set([1, 2])]]);
	const live = new Map([["2026-09-08", new Set([2, 1])]]);
	assert.deepEqual(findDrift(archive, live, "2026-09-20"), []);
});

test("verify flags a settled date D1 holds and the archive never got", () => {
	// The newest dates are rightly in D1 alone until compaction runs; an old
	// one that never reached the archive cannot be rebuilt.
	const live = new Map([
		["2026-09-01", new Set([1, 2])],
		["2026-09-19", new Set([1, 2])],
	]);
	assert.deepEqual(findDrift(new Map(), live, "2026-09-19"), [
		{ date: "2026-09-01", missingFromArchive: 2, missingFromD1: 0 },
	]);
});
