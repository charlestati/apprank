// Turning tracked numbers into the decisions an ASO cycle actually needs.
//
// The thresholds below are the ones the practice uses, and they are stated
// here rather than buried in a chart so they can be argued with:
//
//   - Popularity ≥5 is the floor for measurable search volume; ≥30 is a head
//     term. A good rank on a ≤5 term is close to worthless, which is the
//     classic small-app trap: winning only where nobody searches.
//   - Results below roughly position 10 get effectively no taps, and 20 is the
//     outer edge of visibility. A #59 on a real term can be worth more work
//     than a #10 on a dead one, but only if the climb is achievable.
//   - A rank set in the last 48 hours is unproven: Apple reshuffles, and
//     concluding from it is how people talk themselves into bad releases.

import type { KeywordRow } from "./report";

export const POPULARITY_MEASURABLE = 5;
export const POPULARITY_HEAD = 30;
export const TAP_ZONE = 10;
export const VISIBLE_ZONE = 20;
/** Above this, the incumbents are entrenched enough that metadata alone loses. */
export const DIFFICULTY_BLOCKED = 80;
const UNPROVEN_DAYS = 2;

export type PopularityStatus = "measured" | "absent" | "unqueried";

export type Opportunity =
	| "winning"
	| "close"
	| "blocked"
	| "vanity"
	| "dormant"
	| "unknown";

/**
 * Stable identifier for the explanation, so a client can render it in its own
 * language. `reason` stays as the canonical English prose for the CSV export
 * and any API consumer that is not the dashboard.
 */
export type ReasonKey =
	| "winning"
	| "vanity"
	| "unknownTapZone"
	| "unknownReachable"
	| "blocked"
	| "close"
	| "dormantUnranked"
	| "dormantDeep";

export interface KeywordVerdict {
	opportunity: Opportunity;
	reasonKey: ReasonKey;
	/** Why, in one line, for the operator who has to act on it. */
	reason: string;
	/** The rank moved within the last 48h and has not settled. */
	unproven: boolean;
}

/**
 * A rank inside the tap zone means nothing on its own. Its worth is entirely
 * a question of whether anyone searches the term, so all three answers
 * (measured volume, measured absence of volume, no measurement) land here.
 */
function tapZoneVerdict(
	popularity: number | null
): Omit<KeywordVerdict, "unproven"> {
	if (popularity === null) {
		return {
			opportunity: "unknown",
			reason:
				"Top 10, but Apple publishes no search volume for this term, so a win and a vanity rank look identical here.",
			reasonKey: "unknownTapZone",
		};
	}
	return popularity >= POPULARITY_MEASURABLE
		? {
				opportunity: "winning",
				reason: `Top ${TAP_ZONE} on a term with real volume, so defend it.`,
				reasonKey: "winning",
			}
		: {
				opportunity: "vanity",
				reason:
					"Ranked where almost nobody searches; the slot may be worth reclaiming.",
				reasonKey: "vanity",
			};
}

function dormantVerdict(rank: number | null): Omit<KeywordVerdict, "unproven"> {
	return {
		opportunity: "dormant",
		reason:
			rank === null
				? "Not ranking at all: either the metadata does not cover it or the term is out of reach."
				: "Too far down to earn taps, with no evidence the climb is short.",
		reasonKey: rank === null ? "dormantUnranked" : "dormantDeep",
	};
}

/** Striking distance: close enough that a release could plausibly move it. */
const REACHABLE_RANK = 60;

/**
 * Everything below the tap zone. Split out from `classify` because the lanes
 * differ only in which evidence they require, and reading them side by side is
 * how you check that none of them quietly assumes a volume we do not have.
 */
function deepRankVerdict(
	rank: number | null,
	popularity: number | null,
	difficulty: number | null
): Omit<KeywordVerdict, "unproven"> {
	const winnable = difficulty === null || difficulty < DIFFICULTY_BLOCKED;
	const reachable = rank !== null && rank <= REACHABLE_RANK;

	if (popularity === null) {
		// No measurement: the only honest options are "worth a look" and "not
		// ranking".
		return reachable
			? {
					opportunity: "unknown",
					reason:
						"Close enough to push, but Apple publishes no volume for this term, so the payoff is unmeasured.",
					reasonKey: "unknownReachable",
				}
			: dormantVerdict(rank);
	}

	if (popularity >= POPULARITY_HEAD && !winnable) {
		return {
			opportunity: "blocked",
			reason:
				"Real volume, but the top of the page is entrenched, so metadata alone will not win it.",
			reasonKey: "blocked",
		};
	}

	if (reachable && popularity >= POPULARITY_MEASURABLE && winnable) {
		return {
			opportunity: "close",
			reason: `Within reach of the visible zone (top ${VISIBLE_ZONE}) on a term that has volume.`,
			reasonKey: "close",
		};
	}

	return dormantVerdict(rank);
}

export function classify(row: KeywordRow): KeywordVerdict {
	// Never coerce a missing measurement to zero. Apple lists only the top ~500
	// terms per country × top-level genre, so a real term routinely has no
	// published volume, and treating that as "nobody searches this" invents the
	// one fact every lane below depends on.
	const popularity =
		row.popularityStatus === "measured" ? (row.popularity ?? 0) : null;
	const difficulty = row.difficulty?.score ?? null;
	const rank = row.position;
	const unproven =
		row.change !== null &&
		row.changeDaysAgo !== null &&
		row.changeDaysAgo <= UNPROVEN_DAYS;

	if (rank !== null && rank <= TAP_ZONE) {
		return { ...tapZoneVerdict(popularity), unproven };
	}
	return { ...deepRankVerdict(rank, popularity, difficulty), unproven };
}

/**
 * Brand terms behave differently from generic ones: you should already be #1,
 * and brand demand is a ceiling on what generic ASO can add. Mixing them into
 * one average flatters the numbers.
 */
export function isBrandTerm(keyword: string, appName: string | null): boolean {
	const tokens = (appName ?? "")
		.toLowerCase()
		// Split off the marketing tail: "Codex - Le jeu de lettres" → "codex".
		.split(/[\s\-–—:|,]+/u)
		.filter((t) => t.length >= 3);
	if (tokens.length === 0) {
		return false;
	}
	const brand = tokens[0] as string;
	return keyword.toLowerCase().includes(brand);
}

export interface OpportunitySummary {
	winning: number;
	close: number;
	blocked: number;
	vanity: number;
	dormant: number;
	/** Ranked, but with no published volume to judge the rank against. */
	unknown: number;
	/** Ranked inside the zone that earns taps at all. */
	inTapZone: number;
	brandKeywords: number;
	genericKeywords: number;
	/** Generic keywords only: the honest read on ASO progress. */
	genericInTapZone: number;
	/**
	 * How many keywords Apple published no volume for. When this is most of the
	 * set, which is the normal case for a niche app since Apple lists only the
	 * top ~500 terms per country × genre, the lane counts are a thin read and
	 * the page should say so rather than imply the rest are worthless.
	 */
	unmeasuredKeywords: number;
}

export function summarise(
	rows: (KeywordRow & { verdict: KeywordVerdict; brand: boolean })[]
): OpportunitySummary {
	const count = (o: Opportunity) =>
		rows.filter((r) => r.verdict.opportunity === o).length;
	const inTapZone = (list: typeof rows) =>
		list.filter((r) => r.position !== null && r.position <= TAP_ZONE).length;
	const generic = rows.filter((r) => !r.brand);

	return {
		blocked: count("blocked"),
		brandKeywords: rows.length - generic.length,
		close: count("close"),
		dormant: count("dormant"),
		genericInTapZone: inTapZone(generic),
		genericKeywords: generic.length,
		inTapZone: inTapZone(rows),
		unknown: count("unknown"),
		unmeasuredKeywords: rows.filter((r) => r.popularityStatus !== "measured")
			.length,
		vanity: count("vanity"),
		winning: count("winning"),
	};
}
