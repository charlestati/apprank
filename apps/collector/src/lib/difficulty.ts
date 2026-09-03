// Keyword difficulty, v1.
//
// The question the score answers: **how hard would it be to break into the top
// of this keyword?** Everything it uses is observed, not inferred: the rating
// counts of the apps currently holding the result page, how much that page
// turns over, and how full it is. There is no panel data and no model of
// anybody's installs behind it.
//
// Every input is persisted next to the score, so the formula can be revised
// and the entire history recomputed from the archive. Bump FORMULA_VERSION
// whenever the weights or the shape change, so old and new scores are never
// silently compared.

export const FORMULA_VERSION = "v1";

/** Rating count treated as "as entrenched as it gets" on the log scale. */
const RATING_CEILING = 1_000_000;

/** Apple returns at most this many results, so it is the saturation scale. */
const MAX_RESULTS = 200;

export interface DifficultyInput {
	/** Rating counts of the apps in the top 3, where known. */
	topThreeRatings: number[];
	/** Rating counts of the apps in the top 10, where known. */
	topTenRatings: number[];
	/** Distinct apps that have held a top-10 slot over the recent window. */
	distinctTopTenApps: number;
	/** How many results Apple returned for the keyword. */
	resultCount: number;
}

export interface DifficultyScore {
	score: number;
	entrenchment: number;
	incumbentStrength: number;
	stability: number;
	saturation: number;
	sampleSize: number;
	formulaVersion: string;
}

/**
 * Ratings compress hugely: the gap between 100 and 1,000 reviews matters far
 * more than the gap between 100,000 and 101,000, so the scale is logarithmic.
 */
function ratingMass(ratings: number[]): number {
	if (ratings.length === 0) {
		return 0;
	}
	const sorted = [...ratings].toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
			: (sorted[mid] as number);
	return Math.min(
		1,
		Math.log10(1 + Math.max(0, median)) / Math.log10(1 + RATING_CEILING)
	);
}

/**
 * A board that shows the same ten apps every day is closed; one that keeps
 * churning has room in it. 10 distinct apps over the window = perfectly
 * stable; 20 = each slot has turned over once.
 */
function stabilityOf(distinctTopTenApps: number): number {
	if (distinctTopTenApps <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(1, 10 / distinctTopTenApps));
}

/**
 * Weights, and why:
 *
 * - **entrenchment (0.45)**: the top three are what you actually have to
 *   displace to win the visible part of the page. It dominates on purpose.
 * - **incumbent strength (0.30)**: the depth behind them. A page of
 *   established apps is harder than one strong app and nine weak ones.
 * - **stability (0.15)**: a board that never moves offers no opening, however
 *   modest its ratings.
 * - **saturation (0.10)**: a full 200-result page means more competitors, but
 *   most are irrelevant, so it is only a nudge.
 */
export function computeDifficulty(input: DifficultyInput): DifficultyScore {
	// No rating counts means no evidence. Scoring the page anyway would let the
	// stability and saturation terms invent a difficulty out of nothing.
	if (input.topTenRatings.length === 0) {
		return {
			entrenchment: 0,
			formulaVersion: FORMULA_VERSION,
			incumbentStrength: 0,
			sampleSize: 0,
			saturation: 0,
			score: 0,
			stability: 0,
		};
	}

	const entrenchment = ratingMass(input.topThreeRatings);
	const incumbentStrength = ratingMass(input.topTenRatings);
	const stability = stabilityOf(input.distinctTopTenApps);
	const saturation = Math.min(1, Math.max(0, input.resultCount) / MAX_RESULTS);

	const score = Math.round(
		100 *
			(0.45 * entrenchment +
				0.3 * incumbentStrength +
				0.15 * stability +
				0.1 * saturation)
	);

	return {
		entrenchment,
		formulaVersion: FORMULA_VERSION,
		incumbentStrength,
		sampleSize: input.topTenRatings.length,
		saturation,
		score: Math.max(0, Math.min(100, score)),
		stability,
	};
}

/** Plain-language band, for a tooltip beside the number. */
export function difficultyBand(score: number): string {
	if (score >= 80) {
		return "very hard";
	}
	if (score >= 60) {
		return "hard";
	}
	if (score >= 40) {
		return "moderate";
	}
	if (score >= 20) {
		return "reachable";
	}
	return "open";
}
