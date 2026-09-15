// The SQL a rebuild emits, kept apart from the R2 and wrangler plumbing so it
// can be tested without either.
//
// Everything here is idempotent and gap-filling: a rebuild is applied to a
// database that may already hold part of the range, and it must never
// overwrite a row the collector wrote with better provenance (the collector
// keeps r2_key; the archive line does not).

/** How many leading positions get an index row regardless of tracking. */
export const INDEXED_TOP = 10;

export function sqlEscape(s) {
	return s === null || s === undefined
		? "NULL"
		: `'${String(s).replaceAll("'", "''")}'`;
}

/** One archive line back into a ranking row. Provenance comes with it. */
export function rankingInsert(o) {
	return (
		`INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, response_ms, result_count, result_ids, collector_version, r2_key, valid) VALUES (` +
		`${o.pairId}, ${sqlEscape(o.date)}, ${o.fetchedAt}, ${o.httpStatus}, ${o.responseMs ?? "NULL"}, ${o.resultCount}, ${sqlEscape(JSON.stringify(o.resultIds))}, ${sqlEscape(o.collectorVersion)}, NULL, 1) ` +
		`ON CONFLICT(pair_id, observed_date) DO NOTHING;`
	);
}

/**
 * The positions worth an index row: the same rule the crawler applies, so a
 * rebuilt rank_entry is indistinguishable from one written live. A row per
 * position would be 18x the write budget, which is why the rest stays in
 * result_ids only.
 */
export function rankEntryRows(o, trackedIds) {
	return o.resultIds
		.map((appId, i) => ({ appId, position: i + 1 }))
		.filter((e, i) => i < INDEXED_TOP || trackedIds.has(e.appId));
}

/**
 * rank_entry rows for one observation. The ranking id is assigned by the
 * target database, so it is resolved by the natural key at apply time; that
 * also makes the statements safe to apply to a database whose ranking rows
 * already exist with different ids.
 */
export function rankEntryInserts(o, trackedIds) {
	const rankingId = `(SELECT id FROM ranking WHERE pair_id = ${o.pairId} AND observed_date = ${sqlEscape(o.date)})`;
	return rankEntryRows(o, trackedIds).map(
		(e) =>
			`INSERT OR IGNORE INTO rank_entry (ranking_id, position, app_id) VALUES (${rankingId}, ${e.position}, ${e.appId});`
	);
}

/**
 * rank_entry.app_id references app, and a database being rebuilt from nothing
 * has no app rows. The archive line carries ids only, so these are placeholders
 * with the seen dates and nothing else. The next live crawl that meets the app
 * fills the name and developer in: its upsert updates any row whose fields
 * differ from what Apple returned.
 */
export function appPlaceholders(observations, trackedIds) {
	const seen = new Map();
	for (const o of observations) {
		for (const { appId } of rankEntryRows(o, trackedIds)) {
			const s = seen.get(appId);
			seen.set(appId, {
				first: Math.min(s?.first ?? o.fetchedAt, o.fetchedAt),
				last: Math.max(s?.last ?? o.fetchedAt, o.fetchedAt),
			});
		}
	}
	return [...seen.entries()]
		.toSorted(([a], [b]) => a - b)
		.map(
			([id, { first, last }]) =>
				`INSERT OR IGNORE INTO app (id, first_seen_at, last_seen_at) VALUES (${id}, ${first}, ${last});`
		);
}

/**
 * The whole script, in dependency order: rankings first so the subqueries
 * resolve, apps before the rows that reference them.
 */
export function buildSql(observations, trackedIds) {
	return [
		...observations.map(rankingInsert),
		...appPlaceholders(observations, trackedIds),
		...observations.flatMap((o) => rankEntryInserts(o, trackedIds)),
	];
}

// ---------------------------------------------------------------------------
// Apple Ads popularity.
//
// Two archive shapes, both raw `{ result: { rows: [...] } }` bodies:
//
//   ads/popularity/{week}/{storefront}/{genreId}-{CATEGORY}.json
//       the ranked genre list. Rebuilds `seed_term` and the genre-scoped
//       `popularity` rows.
//   ads/popularity-terms/{week}/{storefront}/{nnnn}.json
//       the by-name pass, with no genre filter. Rebuilds the storefront-wide
//       `popularity` rows, which are the ones the report reads.
//
// Keyword ids are resolved by the natural key at apply time, exactly as the
// collector does, so the SQL is safe against a database whose keyword ids
// differ from any we might have recorded.

/** Genre id for a popularity row that has no genre. Mirrors core/apple/ads. */
export const STOREFRONT_WIDE_GENRE_ID = 0;

/** Apple echoes the term as searched; match on the same normalization. */
export function normalizeTerm(term) {
	return term.toLowerCase().normalize("NFC").trim();
}

/**
 * The dimensions a genre archive key carries. Returns null for the older
 * layout that named the category alone: PRODUCTIVITY_UTILITIES is the Ads
 * category for both Productivity and Utilities, so the genre id cannot be
 * recovered from it and a rebuild must skip the object rather than guess.
 */
export function parseGenreKey(key) {
	const m = key.match(
		/^ads\/popularity\/(?<week>\d{4}-\d{2}-\d{2})\/(?<storefront>[a-z]{2})\/(?<genreId>\d+)-(?<category>[A-Z_]+)\.json$/u
	);
	return m
		? {
				category: m.groups.category,
				genreId: Number(m.groups.genreId),
				storefront: m.groups.storefront,
				week: m.groups.week,
			}
		: null;
}

/**
 * The dimensions a by-name archive key carries. The chunk hash after the count
 * arrived later, so keys written before it have none.
 */
export function parseTermsKey(key) {
	const m = key.match(
		/^ads\/popularity-terms\/(?<week>\d{4}-\d{2}-\d{2})\/(?<storefront>[a-z]{2})\/\d+(?:-[0-9a-f]{8})?\.json$/u
	);
	return m ? { storefront: m.groups.storefront, week: m.groups.week } : null;
}

function popularityInsert(r) {
	return (
		`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, popularity_1_5, rank_in_genre, fetched_at) ` +
		`SELECT k.id, ${sqlEscape(r.storefront)}, ${r.genreId}, ${sqlEscape(r.week)}, 1, ${r.popularity1to100 ?? "NULL"}, ${r.popularity1to5 ?? "NULL"}, ${r.rankInGenre ?? "NULL"}, ${r.fetchedAt} ` +
		`FROM keyword k WHERE k.normalized = ${sqlEscape(normalizeTerm(r.searchTerm))} ` +
		`ON CONFLICT(keyword_id, storefront_code, genre_id, week_start) DO NOTHING;`
	);
}

function seedTermInsert(r) {
	return (
		`INSERT INTO seed_term (month, storefront_code, genre_id, term, rank_in_genre, popularity_1_100) VALUES (` +
		`${sqlEscape(r.week.slice(0, 7))}, ${sqlEscape(r.storefront)}, ${r.genreId}, ${sqlEscape(r.searchTerm)}, ${r.rankInGenre ?? "NULL"}, ${r.popularity1to100 ?? "NULL"}) ` +
		`ON CONFLICT(month, storefront_code, genre_id, term) DO NOTHING;`
	);
}

/**
 * Flatten one archived Apple Ads body into the rows it was derived from.
 *
 * `fetchedAt` is not in the body, and inventing a timestamp would be a claim
 * about when we asked. The caller passes R2's own LastModified, which is when
 * the object landed and therefore the closest true thing available.
 */
export function adsRows(body, dims, fetchedAt) {
	const rows = body?.result?.rows ?? [];
	return rows.map((row) => ({
		fetchedAt,
		genreId: dims.genreId ?? STOREFRONT_WIDE_GENRE_ID,
		popularity1to100: row.searchPopularity1to100,
		popularity1to5: row.searchPopularity1to5,
		// A by-name row has no rank within any genre we stored it under.
		rankInGenre: dims.genreId === undefined ? null : row.rankInGenre,
		searchTerm: row.searchTerm,
		storefront: dims.storefront,
		week: dims.week,
	}));
}

/**
 * Popularity SQL, gap-filling like the rest: `DO NOTHING` everywhere, so a row
 * the collector wrote is never replaced by one derived here.
 *
 * Absences are deliberately not reconstructed. `present = 0` says the collector
 * asked and Apple had nothing, and the archive holds the answers, not the
 * questions: it cannot say which keywords were tracked on a given week, so a
 * rebuilt absence would be a guess wearing the clothes of an observation.
 */
export function buildAdsSql(genreRows, termRows) {
	return [
		...genreRows.map(seedTermInsert),
		...genreRows.map(popularityInsert),
		...termRows.map(popularityInsert),
	];
}
