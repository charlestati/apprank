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
