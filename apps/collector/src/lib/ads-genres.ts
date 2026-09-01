// Apple Ads reports search-term popularity per *top-level* App Store category
// only — the API's own allowed values are the fifteen below, and a sub-genre
// like "Games/Word" is rejected with INVALID_VALUE.
//
// That is a fact about the data, not a limitation of this mapping: Word,
// Puzzle, Board, Trivia and Educational all resolve to GAMES and yield one
// identical ranked list. So popularity is stored against the *parent* genre id
// (Games = 6014), never the sub-genre we happen to track — recording a
// GAMES-wide ranking as "Games/Word popularity" would be exactly the kind of
// precision-we-do-not-have that invariant 3 forbids.
//
// Overridable at runtime via the `ads:category_by_genre` collector_state key,
// so a new Apple category is a row edit rather than a deploy.

export const ADS_CATEGORY_BY_GENRE_ID: Record<number, string> = {
	6000: "BUSINESS",
	6002: "PRODUCTIVITY_UTILITIES", // Utilities
	6003: "TRAVEL",
	6004: "SPORTS",
	6005: "SOCIAL_NETWORKING",
	6007: "PRODUCTIVITY_UTILITIES", // Productivity
	6008: "PHOTO_VIDEO",
	6009: "NEW_PUBLICATION", // News
	6012: "LIFESTYLE",
	6013: "HEALTH_FITNESS",
	6014: "GAMES",
	6015: "FINANCE",
	6016: "ENTERTAINMENT",
	6017: "EDUCATION",
	6023: "FOOD_DRINK",
	6024: "SHOPPING",
};

/** The fifteen values Apple accepts, as returned in its own validation error. */
export const ADS_CATEGORIES = [
	"BUSINESS",
	"EDUCATION",
	"ENTERTAINMENT",
	"FINANCE",
	"FOOD_DRINK",
	"GAMES",
	"HEALTH_FITNESS",
	"LIFESTYLE",
	"NEW_PUBLICATION",
	"PHOTO_VIDEO",
	"PRODUCTIVITY_UTILITIES",
	"SHOPPING",
	"SOCIAL_NETWORKING",
	"SPORTS",
	"TRAVEL",
] as const;

export interface GenreRow {
	id: number;
	parent_id: number | null;
}

/**
 * Resolve a tracked genre to the (top-level id, Apple Ads category) pair the
 * popularity endpoint actually works in. Returns null when the genre maps to
 * no Ads category, so the caller can record why rather than invent a value.
 */
export function resolveAdsCategory(
	genre: GenreRow,
	overrides: Record<number, string> = {}
): { genreId: number; category: string } | null {
	const topLevel = genre.parent_id ?? genre.id;
	const category = overrides[topLevel] ?? ADS_CATEGORY_BY_GENRE_ID[topLevel];
	return category ? { category, genreId: topLevel } : null;
}
