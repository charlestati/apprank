// Observation reads: rank history, competitor timelines, and the full result
// page behind a single observation.
//
// Rank semantics throughout: 1 is best, `null` means "observed, but not in the
// top 200". A missing day is a gap, never a flat line.

const DAY_MS = 86_400_000;

/** Days-ago window converted to the 'YYYY-MM-DD' grain observations use. */
export function sinceDate(days: number): string {
	return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

/** Rank history for one pair, optionally narrowed to one app's position. */
export function pairHistory(
	db: D1Database,
	pairId: number,
	since: string,
	appId: number | null
) {
	return db
		.prepare(
			`SELECT r.observed_date, r.result_count, re.position, re.app_id
     FROM ranking r
     LEFT JOIN rank_entry re ON re.ranking_id = r.id ${appId ? "AND re.app_id = ?3" : ""}
     WHERE r.pair_id = ?1 AND r.valid = 1 AND r.observed_date >= ?2
     ORDER BY r.observed_date`
		)
		.bind(...(appId ? [pairId, since, appId] : [pairId, since]))
		.all();
}

/**
 * The apps a caller tracks a pair's keyword for, in that pair's storefront.
 *
 * A pair's history names no app on its own, and without one the history query
 * returns every app Apple listed that day, so "the tracked app's rank" became
 * two hundred competitors at once. Both transports default to the single app
 * this returns; several mean there is no answer to guess.
 */
export async function trackedAppsForPair(
	db: D1Database,
	userId: string,
	pairId: number
): Promise<number[]> {
	const rows = await db
		.prepare(
			`SELECT DISTINCT tk.app_id
       FROM crawl_pair cp
       JOIN tracked_keyword tk ON tk.keyword_id = cp.keyword_id AND tk.user_id = ?2
       JOIN tracked_keyword_storefront tks ON tks.tracked_keyword_id = tk.id
         AND tks.storefront_code = cp.storefront_code
         AND tks.locale_code = cp.locale_code
       WHERE cp.id = ?1
       ORDER BY tk.app_id`
		)
		.bind(pairId, userId)
		.all<{ app_id: number }>();
	return rows.results.map((r) => r.app_id);
}

/** A day the crawl of a pair failed, and what it failed with. */
export interface PairFetchError {
	date: string;
	errorClass: string;
	count: number;
}

/**
 * Failed crawls of one pair per day and class, so a chart can tell Apple's
 * 403-with-empty-results from a day the cadence never scheduled.
 *
 * A failure writes no observation row, so the only link back to the pair is
 * the params column, "keyword|storefront|locale", the key the report joins on.
 */
export async function pairFetchErrors(
	db: D1Database,
	pairId: number,
	since: string,
	until: string
): Promise<PairFetchError[]> {
	const rows = await db
		.prepare(
			`SELECT fe.error_class, DATE(fe.fetched_at / 1000, 'unixepoch') AS d,
            COUNT(*) AS n
     FROM crawl_pair cp
     JOIN keyword k ON k.id = cp.keyword_id
     JOIN fetch_error fe
       ON fe.params = k.text || '|' || cp.storefront_code || '|' || cp.locale_code
     WHERE cp.id = ?1
       AND DATE(fe.fetched_at / 1000, 'unixepoch') >= ?2
       AND DATE(fe.fetched_at / 1000, 'unixepoch') <= ?3
     GROUP BY d, fe.error_class
     ORDER BY d, fe.error_class`
		)
		.bind(pairId, since, until)
		.all<{ error_class: string | null; d: string; n: number }>();
	// A null class predates the closed vocabulary; it is still a failed day.
	return rows.results.map((e) => ({
		count: e.n,
		date: e.d,
		errorClass: e.error_class ?? "unknown",
	}));
}

/** Top-10 competitor timeline for a pair. */
export function pairCompetitors(db: D1Database, pairId: number, since: string) {
	return db
		.prepare(
			`SELECT r.observed_date, re.position, re.app_id, a.current_name
     FROM ranking r
     JOIN rank_entry re ON re.ranking_id = r.id AND re.position <= 10
     LEFT JOIN app a ON a.id = re.app_id
     WHERE r.pair_id = ? AND r.valid = 1 AND r.observed_date >= ?
     ORDER BY r.observed_date, re.position`
		)
		.bind(pairId, since)
		.all();
}

interface ResultPageEntry {
	position: number;
	appId: number;
	name: string | null;
	developer: string | null;
	iconUrl: string | null;
}

export interface ResultPage {
	date: string | null;
	resultCount: number;
	results: ResultPageEntry[];
}

/**
 * Every app Apple returned for one observation, in order. We hold 200 track
 * ids per observation but only name the ones we have met. An unknown id is
 * returned as an id rather than dropped, because dropping it would silently
 * change the positions of everything below it.
 */
export async function pairResultPage(
	db: D1Database,
	pairId: number,
	date?: string
): Promise<ResultPage> {
	const observation = await db
		.prepare(
			`SELECT id, observed_date, result_ids, result_count
     FROM ranking
     WHERE pair_id = ?1 AND valid = 1 ${date ? "AND observed_date = ?2" : ""}
     ORDER BY observed_date DESC LIMIT 1`
		)
		.bind(...(date ? [pairId, date] : [pairId]))
		.first<{
			id: number;
			observed_date: string;
			result_ids: string;
			result_count: number;
		}>();

	if (!observation) {
		return { date: null, resultCount: 0, results: [] };
	}

	const ids = JSON.parse(observation.result_ids) as number[];
	const known = await db
		.prepare(
			`WITH newest_meta AS (
       SELECT app_id, MAX(captured_at) AS captured_at
       FROM app_metadata_version GROUP BY app_id
     )
     SELECT a.id, a.current_name, a.developer_name, amv.icon_url
     FROM app a
     LEFT JOIN newest_meta nm ON nm.app_id = a.id
     LEFT JOIN app_metadata_version amv ON amv.app_id = nm.app_id
       AND amv.captured_at = nm.captured_at`
		)
		.all<{
			id: number;
			current_name: string | null;
			developer_name: string | null;
			icon_url: string | null;
		}>();
	const byId = new Map(known.results.map((a) => [a.id, a]));

	return {
		date: observation.observed_date,
		resultCount: observation.result_count,
		results: ids.map((id, i) => ({
			appId: id,
			developer: byId.get(id)?.developer_name ?? null,
			iconUrl: byId.get(id)?.icon_url ?? null,
			name: byId.get(id)?.current_name ?? null,
			position: i + 1,
		})),
	};
}
