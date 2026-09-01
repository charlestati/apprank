// App-scoped reads.
//
// These take a database rather than a request context so that every transport
// runs the same SQL. Ownership is *not* checked here: the caller establishes
// the principal and calls `ownsApp` first. Keeping the two apart means a query
// can be reused by a caller that has already proven ownership without paying
// for the check twice.
//
// Column names are returned raw, as the existing clients expect.

export interface AppRow {
	id: number;
	current_name: string | null;
	developer_name: string | null;
	primary_genre_id: number | null;
}

export function listApps(db: D1Database, userId: string) {
	return db
		.prepare(
			`SELECT a.id, a.current_name, a.developer_name, a.primary_genre_id
     FROM tracked_app ta JOIN app a ON a.id = ta.app_id
     WHERE ta.user_id = ? ORDER BY a.current_name`
		)
		.bind(userId)
		.all<AppRow>();
}

/** The storefronts an app is actually tracked in, for the report's picker. */
export function appStorefronts(db: D1Database, userId: string, appId: number) {
	return db
		.prepare(
			`SELECT cp.storefront_code AS code, s.name, COUNT(DISTINCT cp.keyword_id) AS keywords
     FROM tracked_keyword tk
     JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id AND cp.ref_count > 0
     JOIN storefront s ON s.code = cp.storefront_code
     WHERE tk.app_id = ?1 AND tk.user_id = ?2
     GROUP BY cp.storefront_code
     ORDER BY s.weight DESC, s.code`
		)
		.bind(appId, userId)
		.all<{ code: string; name: string; keywords: number }>();
}

/**
 * Latest rank of the tracked app per (keyword, storefront), plus latest
 * popularity. One query powers the main dashboard grid.
 */
export function appKeywords(db: D1Database, userId: string, appId: number) {
	return db
		.prepare(
			`WITH latest AS (
       SELECT r.pair_id, MAX(r.observed_date) AS d
       FROM ranking r WHERE r.valid = 1
       -- Bounded deliberately. Reads here scale with the size of the ranking
       -- table, which grows by one row per pair per day: 50 rows read today,
       -- but ~45,000 a year from now, on every dashboard load. The cadence
       -- ladder tops out at 7 days, so a pair with nothing inside this window
       -- has genuinely stopped being collected, and showing no rank for it is
       -- the correct answer.
       AND r.observed_date >= date('now', '-90 day')
       GROUP BY r.pair_id
     )
     SELECT k.id AS keyword_id, k.text AS keyword, cp.id AS pair_id,
            cp.storefront_code, cp.locale_code, l.d AS observed_date,
            re.position AS rank,
            (SELECT p.popularity_1_100 FROM popularity p
             WHERE p.keyword_id = k.id AND p.storefront_code = cp.storefront_code
             ORDER BY p.week_start DESC LIMIT 1) AS popularity
     FROM tracked_keyword tk
     JOIN keyword k ON k.id = tk.keyword_id
     JOIN crawl_pair cp ON cp.keyword_id = k.id AND cp.ref_count > 0
     LEFT JOIN latest l ON l.pair_id = cp.id
     LEFT JOIN ranking r ON r.pair_id = cp.id AND r.observed_date = l.d AND r.valid = 1
     LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.app_id = tk.app_id
     WHERE tk.app_id = ? AND tk.user_id = ?
     ORDER BY k.text, cp.storefront_code`
		)
		.bind(appId, userId)
		.all();
}

/**
 * The cap is the query's, not the caller's: a review list is unbounded in
 * principle and every transport wants the same ceiling.
 */
export const REVIEW_LIMIT = 100;

export function appReviews(
	db: D1Database,
	appId: number,
	storefront?: string,
	limit: number = REVIEW_LIMIT
) {
	const capped = Math.min(Math.max(limit, 1), REVIEW_LIMIT);
	return db
		.prepare(
			`SELECT id, storefront_code, rating, title, body, author, app_version, reviewed_at
     FROM review WHERE app_id = ?1 ${storefront ? "AND storefront_code = ?2" : ""}
     ORDER BY reviewed_at DESC LIMIT ${storefront ? "?3" : "?2"}`
		)
		.bind(...(storefront ? [appId, storefront, capped] : [appId, capped]))
		.all();
}

export function appRatings(db: D1Database, appId: number) {
	return db
		.prepare(
			`SELECT storefront_code, observed_date, rating_count, rating_avg
     FROM rating_snapshot WHERE app_id = ? ORDER BY observed_date`
		)
		.bind(appId)
		.all();
}

/** Localization gap panel: which indexed locales lack a localization. */
export function appLocalizations(db: D1Database, appId: number) {
	return db
		.prepare(
			`SELECT al.locale_code, al.status, al.title, al.captured_at
     FROM app_localization al WHERE al.app_id = ?
     GROUP BY al.locale_code HAVING MAX(al.captured_at)`
		)
		.bind(appId)
		.all();
}
