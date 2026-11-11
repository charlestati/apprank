// Apple Ads search-term popularity.
//
// Weekly, posted about a week late, and covering only roughly the top 500
// terms per storefront × top-level genre. `present = 0` is the collector
// recording that we asked and Apple published nothing, which is not the same
// fact as "nobody searches this", and neither is the same as never having
// pulled popularity for that keyword at all. Every read here keeps the three
// apart.

import { STOREFRONT_WIDE_GENRE_ID } from "@apprank/core/apple/ads";

interface PopularityPoint {
	weekStart: string;
	present: boolean;
	popularity1_100: number | null;
	popularity1_5: number | null;
	rankInGenre: number | null;
}

export interface KeywordPopularity {
	keywordId: number;
	keyword: string;
	storefront: string;
	/** "measured" once, ever, in this window, so the series is worth reading. */
	everMeasured: boolean;
	points: PopularityPoint[];
}

interface PopularityRow {
	keyword_id: number;
	keyword: string;
	week_start: string | null;
	present: number | null;
	genre_id: number | null;
	popularity_1_100: number | null;
	popularity_1_5: number | null;
	rank_in_genre: number | null;
}

/**
 * One answer for a week that holds several rows.
 *
 * The genre pull writes a row per genre it walked, whose absence only means
 * "outside that genre's top 500", and the by-name pass writes one
 * storefront-wide, which is the term's own popularity. Returned side by side
 * they read as a keyword that is both absent and measured in the same week, in
 * whatever order SQLite reached them. The preference is the report's: the
 * storefront-wide row first, a genre's absence last. The rank within a genre
 * only ever lives on a genre row, so it is taken from one when the chosen row
 * has none.
 */
function weekPoint(weekStart: string, held: PopularityRow[]): PopularityPoint {
	const wide = (r: PopularityRow) => r.genre_id === STOREFRONT_WIDE_GENRE_ID;
	const genreAbsence = (r: PopularityRow) => r.present !== 1 && !wide(r);
	const [chosen] = held.toSorted(
		(a, b) =>
			Number(genreAbsence(a)) - Number(genreAbsence(b)) ||
			Number(!wide(a)) - Number(!wide(b))
	) as [PopularityRow];
	const present = chosen.present === 1;
	const ranked = held.find((r) => r.present === 1 && r.rank_in_genre !== null);
	return {
		popularity1_5: present ? chosen.popularity_1_5 : null,
		popularity1_100: present ? chosen.popularity_1_100 : null,
		present,
		rankInGenre: present
			? (chosen.rank_in_genre ?? ranked?.rank_in_genre ?? null)
			: null,
		weekStart,
	};
}

/** Weekly popularity for every keyword an operator tracks against one app. */
export async function popularityHistory(
	db: D1Database,
	userId: string,
	appId: number,
	storefront: string,
	from: string,
	to: string,
	keywordFilter?: string
): Promise<KeywordPopularity[]> {
	const rows = await db
		.prepare(
			`SELECT k.id AS keyword_id, k.text AS keyword, p.week_start, p.present,
              p.genre_id, p.popularity_1_100, p.popularity_1_5, p.rank_in_genre
       FROM tracked_keyword tk
       JOIN keyword k ON k.id = tk.keyword_id
       LEFT JOIN popularity p ON p.keyword_id = k.id
         AND p.storefront_code = ?2
         AND p.week_start >= ?4 AND p.week_start <= ?5
       WHERE tk.app_id = ?1 AND tk.user_id = ?3
         AND (?6 IS NULL OR k.normalized = ?6)
       ORDER BY k.text, p.week_start, p.genre_id`
		)
		.bind(
			appId,
			storefront,
			userId,
			from,
			to,
			keywordFilter?.toLowerCase().trim() ?? null
		)
		.all<PopularityRow>();

	const byKeyword = new Map<number, KeywordPopularity>();
	const weeks = new Map<number, Map<string, PopularityRow[]>>();
	for (const r of rows.results) {
		if (!byKeyword.has(r.keyword_id)) {
			byKeyword.set(r.keyword_id, {
				everMeasured: false,
				keyword: r.keyword,
				keywordId: r.keyword_id,
				points: [],
				storefront,
			});
			weeks.set(r.keyword_id, new Map());
		}
		// A LEFT JOIN with no popularity row in the window yields one null row:
		// that keyword has never been queried, which is its own answer.
		if (r.week_start === null) {
			continue;
		}
		const byWeek = weeks.get(r.keyword_id) as Map<string, PopularityRow[]>;
		byWeek.set(r.week_start, [...(byWeek.get(r.week_start) ?? []), r]);
	}

	for (const [keywordId, entry] of byKeyword) {
		// Weeks were inserted in the query's order, oldest first.
		for (const [weekStart, held] of weeks.get(keywordId) ?? []) {
			const point = weekPoint(weekStart, held);
			entry.everMeasured ||= point.present;
			entry.points.push(point);
		}
	}
	return [...byKeyword.values()];
}
