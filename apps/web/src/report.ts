// The keyword-performance report: one query set powering the whole page —
// summary tiles, the multi-series rank chart, and the keyword table.
//
// Rank semantics throughout: 1 is best, `null` means "observed, but not in the
// top 200". A missing day is a gap, never a flat line.

import type { Env } from "./env";
import { classify, isBrandTerm, summarise } from "./insights";
import type {
	KeywordVerdict,
	OpportunitySummary,
	PopularityStatus,
} from "./insights";
import { metadataChanges } from "./queries/metadata";
import { sinceDate } from "./queries/rankings";

export interface ReportQuery {
	appId: number;
	userId: string;
	storefront: string;
	days: number;
}

interface ObservationRow {
	pair_id: number;
	keyword_id: number;
	keyword: string;
	observed_date: string | null;
	position: number | null;
	result_count: number | null;
}

export interface SeriesPoint {
	date: string;
	position: number | null;
}

/**
 * A day the crawl of this pair failed, and what it failed with.
 *
 * Without it the chart cannot tell Apple's 403-with-empty-results from a day
 * the cadence never scheduled, and both look like the app losing the keyword.
 */
export interface SeriesError {
	date: string;
	errorClass: string;
	count: number;
}

export interface TopResult {
	position: number;
	appId: number;
	name: string;
	iconUrl: string | null;
}

export interface Difficulty {
	score: number;
	entrenchment: number;
	incumbentStrength: number;
	stability: number;
	saturation: number;
	sampleSize: number;
	formulaVersion: string;
}

export interface KeywordRow {
	pairId: number;
	keywordId: number;
	keyword: string;
	position: number | null;
	/** Positions ordered oldest → newest, one entry per observed day. */
	points: SeriesPoint[];
	/** Days the fetch failed, so a throttled window is not read as a rank loss. */
	fetchErrors: SeriesError[];
	/** Change against the previous *different* rank, and how long ago that was. */
	change: number | null;
	changeDaysAgo: number | null;
	best: number | null;
	worst: number | null;
	popularity: number | null;
	/**
	 * Whether Apple actually published a volume for this term.
	 *  - "measured"  — `popularity` is a real number
	 *  - "absent"    — we queried; the term is outside Apple's top-500 list
	 *  - "unqueried" — no popularity pull has covered this keyword yet
	 * Absent and unqueried both mean "no volume evidence", never "no volume".
	 */
	popularityStatus: PopularityStatus;
	resultCount: number | null;
	topResults: TopResult[];
	difficulty: Difficulty | null;
	/**
	 * How much more contested the term became over the window. A result count
	 * that climbs fast is winnability going stale.
	 */
	resultCountChange: number | null;
	brand?: boolean;
	verdict?: KeywordVerdict;
}

/**
 * One release, and what it touched.
 *
 * A marker that says only "metadata" cannot be read against a rank move, and
 * three of them in a fortnight are indistinguishable from each other. The
 * changed-field list comes from the same diff `queries/metadata.ts` serves.
 */
export interface MetadataMarker {
	date: string;
	version: string | null;
	changed: string[];
}

export interface ReportStats {
	trackedKeywords: number;
	rankedKeywords: number;
	averageRank: number | null;
	averageRankChange: number | null;
	best: number | null;
	worst: number | null;
	distribution: { top5: number; top25: number; top100: number; beyond: number };
	movement: { up: number; down: number; unchanged: number };
}

export interface Report {
	storefront: string;
	days: number;
	/** The days that carry an observation — sparse, and never an axis. */
	dates: string[];
	/**
	 * The requested window, inclusive.
	 *
	 * The chart spans this, one slot per calendar day, rather than one slot per
	 * observed day: pairs sit on a stretched cadence rung, so plotting observed
	 * days side by side drew a six-day gap the same width as an overnight step
	 * and flattened the slope across it.
	 */
	window: { from: string; to: string };
	stats: ReportStats;
	/** Decision-shaped counts: what to defend, what to push, what to drop. */
	insights: OpportunitySummary;
	/** Metadata releases in the window — the anchors a rank move is read against. */
	metadataChanges: MetadataMarker[];
	rows: KeywordRow[];
}

// Four is the readable ceiling for categorical series; past it the palette runs
// out of hues that survive a colour-vision check side by side. More can still be
// switched on from the table, where the reader is choosing them deliberately.
const CHART_SERIES_LIMIT = 4;

function isoToday(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Positions of the tracked app, per keyword, per observed day. */
function fetchObservations(env: Env, q: ReportQuery, since: string) {
	return env.DB.prepare(
		`SELECT cp.id AS pair_id, k.id AS keyword_id, k.text AS keyword,
            r.observed_date, re.position, r.result_count
     FROM tracked_keyword tk
     JOIN keyword k ON k.id = tk.keyword_id
     JOIN crawl_pair cp ON cp.keyword_id = k.id AND cp.ref_count > 0
       AND cp.storefront_code = ?2
     LEFT JOIN ranking r ON r.pair_id = cp.id AND r.valid = 1
       AND r.observed_date >= ?3
     LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.app_id = tk.app_id
     WHERE tk.app_id = ?1 AND tk.user_id = ?4
     ORDER BY k.text, r.observed_date`
	)
		.bind(q.appId, q.storefront, since, q.userId)
		.all<ObservationRow>();
}

/**
 * Failed crawls per pair per day, for the days the chart would otherwise draw
 * as ordinary absence.
 *
 * A failure deliberately writes no observation row, so the only link back to
 * the pair is `fetch_error.params`, which the crawl task fills with
 * "keyword|storefront|locale" — the same key `queries/coverage.ts` joins on.
 */
function fetchErrors(env: Env, q: ReportQuery, since: string) {
	return env.DB.prepare(
		`SELECT cp.id AS pair_id, fe.error_class,
            DATE(fe.fetched_at / 1000, 'unixepoch') AS d, COUNT(*) AS n
     FROM tracked_keyword tk
     JOIN keyword k ON k.id = tk.keyword_id
     JOIN crawl_pair cp ON cp.keyword_id = k.id AND cp.ref_count > 0
       AND cp.storefront_code = ?2
     JOIN fetch_error fe
       ON fe.params = k.text || '|' || cp.storefront_code || '|' || cp.locale_code
     WHERE tk.app_id = ?1 AND tk.user_id = ?4
       AND DATE(fe.fetched_at / 1000, 'unixepoch') >= ?3
     GROUP BY cp.id, d, fe.error_class
     ORDER BY d`
	)
		.bind(q.appId, q.storefront, since, q.userId)
		.all<{
			pair_id: number;
			error_class: string | null;
			d: string;
			n: number;
		}>();
}

/**
 * Latest Apple Ads popularity per keyword for this storefront, including the
 * rows that record an *absence*.
 *
 * Apple publishes only the top ~500 terms per country × top-level genre, so a
 * tracked keyword is routinely missing from the list — for this app, 22 of 25
 * are. `present = 0` is the collector saying "we asked, Apple had nothing",
 * which is not the same fact as "nobody searches this", and neither is the same
 * as never having pulled popularity at all. Filtering the absences out here
 * collapsed all three into one null.
 */
function fetchPopularity(env: Env, q: ReportQuery) {
	return env.DB.prepare(
		`SELECT p.keyword_id, p.present, p.popularity_1_100 AS popularity
     FROM popularity p
     JOIN tracked_keyword tk ON tk.keyword_id = p.keyword_id
       AND tk.app_id = ?1 AND tk.user_id = ?3
     WHERE p.storefront_code = ?2
       AND p.week_start = (
         SELECT MAX(week_start) FROM popularity
         WHERE keyword_id = p.keyword_id AND storefront_code = ?2)
     GROUP BY p.keyword_id`
	)
		.bind(q.appId, q.storefront, q.userId)
		.all<{ keyword_id: number; present: number; popularity: number | null }>();
}

/**
 * The apps holding the top five slots on each keyword's latest observation,
 * with their icons — the newest metadata version we hold for each.
 */
function fetchTopResults(env: Env, q: ReportQuery) {
	return env.DB.prepare(
		`WITH latest AS (
       SELECT cp.id AS pair_id, MAX(r.observed_date) AS d
       FROM tracked_keyword tk
       JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id AND cp.ref_count > 0
         AND cp.storefront_code = ?2
       JOIN ranking r ON r.pair_id = cp.id AND r.valid = 1
       WHERE tk.app_id = ?1 AND tk.user_id = ?3
         -- Same bound as queries/apps.ts: reads scale with history, and the
         -- top-of-page snapshot only has meaning if it is recent.
         AND r.observed_date >= date('now', '-90 day')
       GROUP BY cp.id
     ),
     newest_meta AS (
       SELECT app_id, MAX(captured_at) AS captured_at
       FROM app_metadata_version GROUP BY app_id
     )
     SELECT l.pair_id, re.position, re.app_id,
            COALESCE(a.current_name, CAST(re.app_id AS TEXT)) AS name,
            amv.icon_url
     FROM latest l
     JOIN ranking r ON r.pair_id = l.pair_id AND r.observed_date = l.d
     JOIN rank_entry re ON re.ranking_id = r.id AND re.position <= 5
     LEFT JOIN app a ON a.id = re.app_id
     LEFT JOIN newest_meta nm ON nm.app_id = re.app_id
     LEFT JOIN app_metadata_version amv ON amv.app_id = nm.app_id
       AND amv.captured_at = nm.captured_at
     ORDER BY l.pair_id, re.position`
	)
		.bind(q.appId, q.storefront, q.userId)
		.all<{
			pair_id: number;
			position: number;
			app_id: number;
			name: string;
			icon_url: string | null;
		}>();
}

/** Latest difficulty score per pair, with the inputs that produced it. */
function fetchDifficulty(env: Env, q: ReportQuery) {
	return env.DB.prepare(
		`SELECT kd.pair_id, kd.score, kd.entrenchment, kd.incumbent_strength,
            kd.stability, kd.saturation, kd.sample_size, kd.formula_version
     FROM keyword_difficulty kd
     JOIN crawl_pair cp ON cp.id = kd.pair_id AND cp.storefront_code = ?2
     JOIN tracked_keyword tk ON tk.keyword_id = cp.keyword_id
       AND tk.app_id = ?1 AND tk.user_id = ?3
     WHERE kd.observed_date = (
       SELECT MAX(observed_date) FROM keyword_difficulty
       WHERE pair_id = kd.pair_id)
     GROUP BY kd.pair_id`
	)
		.bind(q.appId, q.storefront, q.userId)
		.all<{
			pair_id: number;
			score: number;
			entrenchment: number;
			incumbent_strength: number;
			stability: number;
			saturation: number;
			sample_size: number;
			formula_version: string;
		}>();
}

function groupObservations(rows: ObservationRow[]): Map<number, KeywordRow> {
	const byPair = new Map<number, KeywordRow>();
	for (const r of rows) {
		let row = byPair.get(r.pair_id);
		if (!row) {
			row = {
				best: null,
				change: null,
				changeDaysAgo: null,
				keyword: r.keyword,
				fetchErrors: [],
				keywordId: r.keyword_id,
				pairId: r.pair_id,
				points: [],
				difficulty: null,
				popularity: null,
				popularityStatus: "unqueried" as PopularityStatus,
				resultCountChange: null,
				position: null,
				resultCount: null,
				topResults: [],
				worst: null,
			};
			byPair.set(r.pair_id, row);
		}
		// A LEFT JOIN with no observations in the window yields one all-null row.
		if (r.observed_date) {
			row.points.push({ date: r.observed_date, position: r.position });
			// Rows arrive oldest-first, so the first sighting is the baseline.
			row.resultCountChange ??= r.result_count;
			row.resultCount = r.result_count;
		}
	}
	return byPair;
}

/** Releases in the window, with the fields each one changed. */
const MARKER_LIMIT = 50;

/** Latest rank, its move against the previous *different* rank, and extremes. */
function summarisePoints(row: KeywordRow): void {
	const ranked = row.points.filter(
		(p): p is { date: string; position: number } => p.position !== null
	);
	const latest = ranked.at(-1);
	if (!latest) {
		return;
	}
	row.position = latest.position;
	row.best = Math.min(...ranked.map((p) => p.position));
	row.worst = Math.max(...ranked.map((p) => p.position));

	for (let i = ranked.length - 2; i >= 0; i -= 1) {
		const earlier = ranked[i];
		if (earlier && earlier.position !== latest.position) {
			// Positive = improved (moved towards rank 1).
			row.change = earlier.position - latest.position;
			row.changeDaysAgo = Math.max(
				1,
				Math.round(
					(Date.parse(latest.date) - Date.parse(earlier.date)) / 86_400_000
				)
			);
			break;
		}
	}
}

function mean(xs: number[]): number | null {
	return xs.length === 0
		? null
		: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function computeStats(rows: KeywordRow[]): ReportStats {
	const ranked = rows.filter((r) => r.position !== null);
	const positions = ranked.map((r) => r.position as number);

	// The previous average is taken over the same keywords' pre-change ranks, so
	// the delta answers "did we move?" rather than "did the tracked set change?".
	const previous = ranked.map((r) =>
		r.change === null
			? (r.position as number)
			: (r.position as number) + r.change
	);
	const now = mean(positions);
	const before = mean(previous);

	return {
		averageRank: now,
		averageRankChange: now === null || before === null ? null : before - now,
		best: positions.length === 0 ? null : Math.min(...positions),
		distribution: {
			beyond: positions.filter((p) => p > 100).length,
			top5: positions.filter((p) => p <= 5).length,
			top25: positions.filter((p) => p > 5 && p <= 25).length,
			top100: positions.filter((p) => p > 25 && p <= 100).length,
		},
		movement: {
			down: ranked.filter((r) => (r.change ?? 0) < 0).length,
			unchanged: ranked.filter((r) => !r.change).length,
			up: ranked.filter((r) => (r.change ?? 0) > 0).length,
		},
		rankedKeywords: ranked.length,
		trackedKeywords: rows.length,
		worst: positions.length === 0 ? null : Math.max(...positions),
	};
}

export async function buildReport(env: Env, q: ReportQuery): Promise<Report> {
	const since = sinceDate(q.days);
	const [
		observations,
		popularity,
		topResults,
		difficulty,
		changes,
		errors,
		appRow,
	] = await Promise.all([
		fetchObservations(env, q, since),
		fetchPopularity(env, q),
		fetchTopResults(env, q),
		fetchDifficulty(env, q),
		metadataChanges(env.DB, q.appId, since, isoToday(), MARKER_LIMIT),
		fetchErrors(env, q, since),
		env.DB.prepare("SELECT current_name FROM app WHERE id = ?1")
			.bind(q.appId)
			.first<{ current_name: string | null }>(),
	]);

	const byPair = groupObservations(observations.results);
	const popByKeyword = new Map(
		popularity.results.map((p) => [
			p.keyword_id,
			{
				popularity: p.present === 1 ? p.popularity : null,
				status: (p.present === 1 ? "measured" : "absent") as PopularityStatus,
			},
		])
	);
	const resultsByPair = new Map<number, TopResult[]>();
	for (const r of topResults.results) {
		const found = resultsByPair.get(r.pair_id) ?? [];
		found.push({
			appId: r.app_id,
			iconUrl: r.icon_url,
			name: r.name,
			position: r.position,
		});
		resultsByPair.set(r.pair_id, found);
	}
	const errorsByPair = new Map<number, SeriesError[]>();
	for (const e of errors.results) {
		const found = errorsByPair.get(e.pair_id) ?? [];
		// A null class predates the closed vocabulary; it is still a failed day.
		found.push({
			count: e.n,
			date: e.d,
			errorClass: e.error_class ?? "unknown",
		});
		errorsByPair.set(e.pair_id, found);
	}
	const difficultyByPair = new Map(
		difficulty.results.map((d) => [
			d.pair_id,
			{
				entrenchment: d.entrenchment,
				formulaVersion: d.formula_version,
				incumbentStrength: d.incumbent_strength,
				sampleSize: d.sample_size,
				saturation: d.saturation,
				score: d.score,
				stability: d.stability,
			},
		])
	);

	const rows = [...byPair.values()];
	for (const row of rows) {
		summarisePoints(row);
		const pop = popByKeyword.get(row.keywordId);
		row.popularity = pop?.popularity ?? null;
		row.popularityStatus = pop?.status ?? "unqueried";
		row.topResults = resultsByPair.get(row.pairId) ?? [];
		row.fetchErrors = errorsByPair.get(row.pairId) ?? [];
		row.difficulty = difficultyByPair.get(row.pairId) ?? null;
		row.resultCountChange =
			row.resultCount === null || row.resultCountChange === null
				? null
				: row.resultCount - row.resultCountChange;
		row.brand = isBrandTerm(row.keyword, appRow?.current_name ?? null);
		row.verdict = classify(row);
	}

	// Ranked keywords first, best rank at the top; unranked keep alphabetical order.
	const sorted = rows.toSorted((a, b) => {
		const ra = a.position ?? Number.POSITIVE_INFINITY;
		const rb = b.position ?? Number.POSITIVE_INFINITY;
		return ra - rb || a.keyword.localeCompare(b.keyword);
	});

	const dates = [
		...new Set(sorted.flatMap((r) => r.points.map((p) => p.date))),
	].toSorted();

	return {
		dates,
		days: q.days,
		insights: summarise(
			sorted as (KeywordRow & { verdict: KeywordVerdict; brand: boolean })[]
		),
		metadataChanges: changes.map((c) => ({
			changed: c.changed,
			date: c.date,
			version: c.version,
		})),
		rows: sorted,
		stats: computeStats(sorted),
		storefront: q.storefront,
		window: { from: since, to: isoToday() },
	};
}

/** The keywords the chart plots by default: best-ranked first. */
export function chartSeries(report: Report): KeywordRow[] {
	return report.rows
		.filter((r) => r.position !== null)
		.slice(0, CHART_SERIES_LIMIT);
}
