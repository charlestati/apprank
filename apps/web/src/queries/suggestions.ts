// Tier-2 → Tier-1 promotion suggestions. A suggestion belongs to whoever
// tracks the app it concerns, so the user id is part of every statement rather
// than a check performed beside one.

export function listSuggestions(db: D1Database, userId: string) {
	return db
		.prepare(
			"SELECT * FROM suggestion WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
		)
		.bind(userId)
		.all();
}

/** What a `promote_keyword` suggestion carries, as the collector wrote it. */
interface PromoteKeyword {
	term: string;
	language: string;
	storefront: string;
	locale: string;
	appId: number;
}

function promotion(payload: string): PromoteKeyword | null {
	try {
		const p = JSON.parse(payload) as Partial<PromoteKeyword>;
		return typeof p.term === "string" &&
			typeof p.language === "string" &&
			typeof p.storefront === "string" &&
			typeof p.locale === "string" &&
			typeof p.appId === "number"
			? (p as PromoteKeyword)
			: null;
	} catch {
		// A payload we cannot read is not a reason to lose the operator's answer:
		// the status still changes, nothing is promoted, and the row says why.
		return null;
	}
}

/**
 * The rows that start collecting a keyword, in the order the foreign keys need.
 *
 * The same three writes `scripts/track` makes, and deliberately the same shape:
 * a keyword row if the text is new, a crawl pair reactivated rather than
 * recreated when one already exists (history is kept, scheduling stopped, so
 * ref_count carries it back), and the tracking row that says whose it is.
 *
 * `INSERT OR IGNORE` throughout because two operators may accept the same
 * suggestion, and because a pair retired earlier must come back as itself
 * rather than as a second row with no history.
 */
function promotionWrites(
	db: D1Database,
	userId: string,
	p: PromoteKeyword
): D1PreparedStatement[] {
	const normalized = p.term.toLowerCase().normalize("NFC").trim();
	const keywordId =
		"(SELECT id FROM keyword WHERE normalized = ?1 AND language = ?2)";
	return [
		db
			.prepare(
				"INSERT OR IGNORE INTO keyword (text, normalized, language) VALUES (?1, ?1, ?2)"
			)
			.bind(normalized, p.language),
		db
			.prepare(
				`INSERT OR IGNORE INTO crawl_pair (keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at, volatility)
         SELECT ${keywordId}, ?3, ?4, 1, 1, 24, unixepoch() * 1000, 0`
			)
			.bind(normalized, p.language, p.storefront, p.locale),
		db
			.prepare(
				// Only a retired pair is touched. `scripts/track` reads ref_count as
				// active-or-not, and an unconditional set would both spend a write on
				// every acceptance and flatten a count someone else maintains.
				`UPDATE crawl_pair SET ref_count = 1
          WHERE keyword_id = ${keywordId} AND storefront_code = ?3 AND locale_code = ?4
            AND ref_count = 0`
			)
			.bind(normalized, p.language, p.storefront, p.locale),
		db
			.prepare(
				`INSERT OR IGNORE INTO tracked_keyword (user_id, app_id, keyword_id, created_at)
         SELECT ?5, ?3, ${keywordId}, ?4`
			)
			.bind(normalized, p.language, p.appId, Date.now(), userId),
		db
			.prepare(
				// The storefront this answer was for, recorded against this user's
				// track. Without it the database knows the keyword is tracked but not
				// where, and everything reading the tracked set had to guess.
				`INSERT OR IGNORE INTO tracked_keyword_storefront (tracked_keyword_id, storefront_code, locale_code, created_at)
         SELECT tk.id, ?3, ?4, ?5 FROM tracked_keyword tk
          WHERE tk.user_id = ?6 AND tk.app_id = ?7 AND tk.keyword_id = ${keywordId}`
			)
			.bind(
				normalized,
				p.language,
				p.storefront,
				p.locale,
				Date.now(),
				userId,
				p.appId
			),
	];
}

/**
 * Record the operator's answer, and on acceptance actually start collecting.
 *
 * Accepting used to flip a status and nothing else, which would have reported
 * success while changing nothing the moment a suggestion existed. The promotion
 * is the point of the inbox: the crawl budget is fixed, so a keyword enters it
 * only because somebody said yes.
 *
 * Returns how many rows changed on the suggestion itself: 0 means the
 * suggestion is not the caller's or was already answered, and nothing is
 * promoted.
 *
 * The status change and the promotion are one batch, so one transaction. Split,
 * a D1 failure between them left the suggestion accepted with no pair behind
 * it, and a retry then found nothing pending and reported success: the keyword
 * the operator chose was never collected, and never offered again either.
 */
export async function setSuggestionStatus(
	db: D1Database,
	userId: string,
	id: number,
	status: "accepted" | "dismissed"
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT type, payload FROM suggestion WHERE id = ?1 AND user_id = ?2 AND status = 'pending'"
		)
		.bind(id, userId)
		.first<{ type: string; payload: string }>();
	if (!row) {
		return 0;
	}
	const p =
		status === "accepted" && row.type === "promote_keyword"
			? promotion(row.payload)
			: null;
	const [updated] = await db.batch([
		db
			.prepare(
				"UPDATE suggestion SET status = ?1 WHERE id = ?2 AND user_id = ?3 AND status = 'pending'"
			)
			.bind(status, id, userId),
		...(p ? promotionWrites(db, userId, p) : []),
	]);
	return updated?.meta.changes ?? 0;
}
