// Apple Ads search-term popularity.
//
// Weekly, posted about a week late, and covering only roughly the top 500 terms
// per storefront × top-level genre. `present = 0` is the collector recording
// that we asked and Apple published nothing — which is not the same fact as
// "nobody searches this", and neither is the same as never having pulled
// popularity for that keyword at all. Every read here keeps the three apart.

export interface PopularityPoint {
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
	/** "measured" once, ever, in this window — the series is worth reading. */
	everMeasured: boolean;
	points: PopularityPoint[];
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
              p.popularity_1_100, p.popularity_1_5, p.rank_in_genre
       FROM tracked_keyword tk
       JOIN keyword k ON k.id = tk.keyword_id
       LEFT JOIN popularity p ON p.keyword_id = k.id
         AND p.storefront_code = ?2
         AND p.week_start >= ?4 AND p.week_start <= ?5
       WHERE tk.app_id = ?1 AND tk.user_id = ?3
         AND (?6 IS NULL OR k.normalized = ?6)
       ORDER BY k.text, p.week_start`
		)
		.bind(
			appId,
			storefront,
			userId,
			from,
			to,
			keywordFilter?.toLowerCase().trim() ?? null
		)
		.all<{
			keyword_id: number;
			keyword: string;
			week_start: string | null;
			present: number | null;
			popularity_1_100: number | null;
			popularity_1_5: number | null;
			rank_in_genre: number | null;
		}>();

	const byKeyword = new Map<number, KeywordPopularity>();
	for (const r of rows.results) {
		let entry = byKeyword.get(r.keyword_id);
		if (!entry) {
			entry = {
				everMeasured: false,
				keyword: r.keyword,
				keywordId: r.keyword_id,
				points: [],
				storefront,
			};
			byKeyword.set(r.keyword_id, entry);
		}
		// A LEFT JOIN with no popularity row in the window yields one null row:
		// that keyword has never been queried, which is its own answer.
		if (r.week_start === null) {
			continue;
		}
		const present = r.present === 1;
		entry.everMeasured ||= present;
		entry.points.push({
			popularity1_5: present ? r.popularity_1_5 : null,
			popularity1_100: present ? r.popularity_1_100 : null,
			present,
			rankInGenre: present ? r.rank_in_genre : null,
			weekStart: r.week_start,
		});
	}
	return [...byKeyword.values()];
}
