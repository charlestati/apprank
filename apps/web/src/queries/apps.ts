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

/**
 * The pairs behind an operator's own tracks: joined after
 * `FROM tracked_keyword tk`, it yields `cp` for each storefront and locale that
 * operator chose. A keyword alone is not enough to join on. `crawl_pair` is the
 * union of what everyone tracks, so two operators sharing a keyword in
 * different storefronts would each see the other's markets.
 */
export const TRACKED_PAIRS = `JOIN tracked_keyword_storefront tks ON tks.tracked_keyword_id = tk.id
     JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id
       AND cp.storefront_code = tks.storefront_code
       AND cp.locale_code = tks.locale_code
       AND cp.ref_count > 0`;

/** One storefront an app is tracked in, for the report's picker. */
interface StorefrontRow {
	code: string;
	name: string;
	keywords: number;
}

function storefrontsSql(appFilter: string, groupBy: string) {
	return `SELECT tk.app_id, cp.storefront_code AS code, s.name, COUNT(DISTINCT cp.keyword_id) AS keywords
     FROM tracked_keyword tk
     ${TRACKED_PAIRS}
     JOIN storefront s ON s.code = cp.storefront_code
     WHERE tk.user_id = ?1 ${appFilter}
     GROUP BY ${groupBy}
     ORDER BY s.weight DESC, s.code`;
}

/** The storefronts an app is actually tracked in, for the report's picker. */
export async function appStorefronts(
	db: D1Database,
	userId: string,
	appId: number
): Promise<StorefrontRow[]> {
	const rows = await db
		.prepare(storefrontsSql("AND tk.app_id = ?2", "cp.storefront_code"))
		.bind(userId, appId)
		.all<StorefrontRow & { app_id: number }>();
	return rows.results.map(({ code, keywords, name }) => ({
		code,
		keywords,
		name,
	}));
}

/**
 * Every tracked app's storefronts in one query. Asking per app costs a query
 * each, and Workers Free allows 50 per invocation, so an operator with a few
 * dozen apps would have broken the caller outright.
 */
export async function storefrontsByApp(
	db: D1Database,
	userId: string
): Promise<Map<number, StorefrontRow[]>> {
	const rows = await db
		.prepare(storefrontsSql("", "tk.app_id, cp.storefront_code"))
		.bind(userId)
		.all<StorefrontRow & { app_id: number }>();
	const byApp = new Map<number, StorefrontRow[]>();
	for (const { app_id, code, keywords, name } of rows.results) {
		byApp.set(app_id, [...(byApp.get(app_id) ?? []), { code, keywords, name }]);
	}
	return byApp;
}

/**
 * The newest valid observation of each of an operator's pairs for one app.
 * Binds ?1 = app id, ?2 = user id, and leaves `mine` and `latest` in scope.
 *
 * Bounded deliberately, and driven from the caller's own pairs so that the
 * bound bounds anything. Reads here scale with the size of the ranking table,
 * which grows by one row per pair per day. Grouping the whole table by pair
 * and filtering the date afterwards walked every operator's history: 36,500
 * index rows for 100 pairs a year in, on every dashboard load. Starting from
 * the caller's pairs makes it one index range per pair, at most 90 rows each.
 * The cadence ladder tops out at 7 days, so a pair with nothing inside this
 * window has genuinely stopped being collected, and showing no rank for it is
 * the correct answer.
 */
const LATEST_FOR_APP = `mine AS (
       SELECT tk.app_id, k.id AS keyword_id, k.text AS keyword, cp.id AS pair_id,
              cp.storefront_code, cp.locale_code, cp.interval_hours
       FROM tracked_keyword tk
       JOIN keyword k ON k.id = tk.keyword_id
       ${TRACKED_PAIRS}
       WHERE tk.app_id = ?1 AND tk.user_id = ?2
     ),
     latest AS (
       SELECT m.pair_id, MAX(r.observed_date) AS d
       FROM mine m
       JOIN ranking r ON r.pair_id = m.pair_id AND r.valid = 1
         AND r.observed_date >= date('now', '-90 day')
       GROUP BY m.pair_id
     )`;

/**
 * Latest rank of the tracked app per (keyword, storefront), plus latest
 * popularity. One query powers the main dashboard grid.
 */
export function appKeywords(db: D1Database, userId: string, appId: number) {
	return db
		.prepare(
			`WITH ${LATEST_FOR_APP}
     SELECT m.keyword_id, m.keyword, m.pair_id,
            m.storefront_code, m.locale_code, l.d AS observed_date,
            re.position AS rank,
            (SELECT p.popularity_1_100 FROM popularity p
             WHERE p.keyword_id = m.keyword_id AND p.storefront_code = m.storefront_code
             ORDER BY p.week_start DESC LIMIT 1) AS popularity
     FROM mine m
     LEFT JOIN latest l ON l.pair_id = m.pair_id
     LEFT JOIN ranking r ON r.pair_id = m.pair_id AND r.observed_date = l.d AND r.valid = 1
     LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.app_id = m.app_id
     ORDER BY m.keyword, m.storefront_code`
		)
		.bind(appId, userId)
		.all();
}

/**
 * The same latest ranks as `appKeywords`, ranked first, for the MCP tool: one
 * storefront or all, capped, and asking one row past the cap so the answer can
 * say it was truncated.
 */
export function currentRankings(
	db: D1Database,
	params: {
		userId: string;
		appId: number;
		storefront: string | null;
		limit: number;
	}
) {
	return db
		.prepare(
			`WITH ${LATEST_FOR_APP}
       SELECT m.keyword, m.pair_id, m.storefront_code, m.locale_code,
              m.interval_hours, l.d AS observed_date, re.position
       FROM mine m
       LEFT JOIN latest l ON l.pair_id = m.pair_id
       LEFT JOIN ranking r ON r.pair_id = m.pair_id AND r.observed_date = l.d AND r.valid = 1
       LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.app_id = m.app_id
       WHERE (?3 IS NULL OR m.storefront_code = ?3)
       ORDER BY re.position IS NULL, re.position, m.keyword
       LIMIT ?4`
		)
		.bind(params.appId, params.userId, params.storefront, params.limit + 1)
		.all<{
			keyword: string;
			pair_id: number;
			storefront_code: string;
			locale_code: string;
			interval_hours: number;
			observed_date: string | null;
			position: number | null;
		}>();
}

/**
 * The cap is the query's, not the caller's: a review list is unbounded in
 * principle and every transport wants the same ceiling. One row past it is
 * allowed so that a capped caller can tell a full page from a truncated one.
 */
const REVIEW_LIMIT = 100;

export function appReviews(
	db: D1Database,
	appId: number,
	options: {
		storefront?: string | undefined;
		minRating?: number | undefined;
		maxRating?: number | undefined;
		limit?: number | undefined;
	} = {}
) {
	const capped = Math.min(
		Math.max(options.limit ?? REVIEW_LIMIT, 1),
		REVIEW_LIMIT + 1
	);
	// The rating filter runs before the LIMIT, not after: filtering the newest
	// hundred in the caller answered "no one-star reviews" whenever the last
	// hundred were all five stars.
	return db
		.prepare(
			`SELECT id, storefront_code, rating, title, body, author, app_version, reviewed_at
     FROM review
     WHERE app_id = ?1
       AND (?2 IS NULL OR storefront_code = ?2)
       AND (?3 IS NULL OR COALESCE(rating, 0) >= ?3)
       AND (?4 IS NULL OR COALESCE(rating, 0) <= ?4)
     ORDER BY reviewed_at DESC LIMIT ?5`
		)
		.bind(
			appId,
			options.storefront || null,
			options.minRating ?? null,
			options.maxRating ?? null,
			capped
		)
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
