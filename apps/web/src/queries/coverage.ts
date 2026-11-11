// How much of a window we actually observed, and what went wrong in the rest.
//
// This exists because a rate-limited week and a ranking collapse look
// identical in a series of positions. Apple's throttle returns HTTP 403 with
// an empty results array, which the collector records as a `fetch_error`
// rather than as "not ranking", but a consumer reading only the observations
// still sees a hole and will happily narrate it as a decline. So every answer
// carries the shape of its own holes.
//
// Expected observations are computed from the pair's own cadence, not from the
// calendar. `crawl_pair.interval_hours` is stretched by the daily budget when
// demand exceeds the learned Apple rate, so a pair on a 7-day rung has six-day
// gaps by design. Counting those as missing days would report the whole tail
// of the tracked set as degraded and make the signal useless.

import { isLoss } from "./fetch-error-classes";

const DAY_MS = 86_400_000;

interface ErrorWindow {
	from: string;
	to: string;
	errorClass: string;
	count: number;
	/**
	 * Whether these fetches cost an observation. A throttle is requeued and the
	 * pair runs late, and a finding about Apple's own data failed nothing, so
	 * neither is a reason to distrust the window.
	 */
	loss: boolean;
}

export interface Gap {
	from: string;
	to: string;
	days: number;
}

export interface Coverage {
	requested: { from: string; to: string; days: number };
	observed: {
		firstDate: string | null;
		lastDate: string | null;
		observationCount: number;
		expectedObservations: number;
	};
	intervalHours: number;
	/** observed / expected, capped at 1. */
	coverage: number;
	degraded: boolean;
	gaps: Gap[];
	errors: ErrorWindow[];
	note: string | null;
}

/** Below this, the window is not a fair basis for a movement claim. */
const DEGRADED_BELOW = 0.9;

function daysBetween(from: string, to: string): number {
	return Math.max(
		1,
		Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
	);
}

export function isoDay(offsetDays: number, base = Date.now()): string {
	return new Date(base - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

interface PairObservations {
	dates: string[];
	errors: ErrorWindow[];
	intervalHours: number | null;
}

/**
 * Observed dates for a set of pairs, plus the errors recorded against each.
 *
 * Three queries whatever the number of pairs, with the ids passed as one JSON
 * parameter. Asking pair by pair cost three queries each, and Workers Free
 * allows 50 per invocation, so an app with a dozen keywords broke the health
 * tool outright; an IN list would hit D1's 100-parameter ceiling instead.
 */
async function pairsObservations(
	db: D1Database,
	pairIds: number[],
	from: string,
	to: string
): Promise<Map<number, PairObservations>> {
	const ids = JSON.stringify(pairIds);
	const [dates, pairs] = await Promise.all([
		db
			.prepare(
				`SELECT pair_id, observed_date FROM ranking
         WHERE pair_id IN (SELECT value FROM json_each(?1)) AND valid = 1
           AND observed_date >= ?2 AND observed_date <= ?3
         ORDER BY pair_id, observed_date`
			)
			.bind(ids, from, to)
			.all<{ pair_id: number; observed_date: string }>(),
		db
			.prepare(
				`SELECT cp.id, cp.interval_hours, k.text AS keyword, cp.storefront_code, cp.locale_code
         FROM crawl_pair cp JOIN keyword k ON k.id = cp.keyword_id
         WHERE cp.id IN (SELECT value FROM json_each(?1))`
			)
			.bind(ids)
			.all<{
				id: number;
				interval_hours: number;
				keyword: string;
				storefront_code: string;
				locale_code: string;
			}>(),
	]);

	const out = new Map<number, PairObservations>(
		pairIds.map((id) => [id, { dates: [], errors: [], intervalHours: null }])
	);
	for (const d of dates.results) {
		out.get(d.pair_id)?.dates.push(d.observed_date);
	}

	// The crawl task records the pair as "keyword|storefront|locale" in `params`;
	// that string is the only link between a failed fetch and the pair it was
	// for, since a failure deliberately writes no observation row. Two keywords
	// in different languages can share the text, hence a list per key.
	const byKey = new Map<string, number[]>();
	for (const p of pairs.results) {
		const found = out.get(p.id);
		if (found) {
			found.intervalHours = p.interval_hours;
		}
		const key = `${p.keyword}|${p.storefront_code}|${p.locale_code}`;
		byKey.set(key, [...(byKey.get(key) ?? []), p.id]);
	}
	if (byKey.size === 0) {
		return out;
	}

	const rows = await db
		.prepare(
			`SELECT params, error_class,
              MIN(DATE(fetched_at / 1000, 'unixepoch')) AS first_date,
              MAX(DATE(fetched_at / 1000, 'unixepoch')) AS last_date,
              COUNT(*) AS n
       FROM fetch_error
       WHERE params IN (SELECT value FROM json_each(?1))
         AND DATE(fetched_at / 1000, 'unixepoch') >= ?2
         AND DATE(fetched_at / 1000, 'unixepoch') <= ?3
       GROUP BY params, error_class
       ORDER BY n DESC, error_class`
		)
		.bind(JSON.stringify([...byKey.keys()]), from, to)
		.all<{
			params: string;
			error_class: string | null;
			first_date: string;
			last_date: string;
			n: number;
		}>();
	for (const e of rows.results) {
		for (const id of byKey.get(e.params) ?? []) {
			out.get(id)?.errors.push({
				count: e.n,
				// A null class predates the closed vocabulary; it is still a loss.
				errorClass: e.error_class ?? "unknown",
				from: e.first_date,
				loss: isLoss(e.error_class),
				to: e.last_date,
			});
		}
	}
	return out;
}

/** Every run of consecutive calendar days with no observation. */
function calendarGaps(dates: string[], from: string, to: string): Gap[] {
	const seen = new Set(dates);
	const gaps: Gap[] = [];
	const start = Date.parse(from);
	const end = Date.parse(to);
	let openedAt: string | null = null;
	let previous: string | null = null;

	for (let t = start; t <= end; t += DAY_MS) {
		const day = new Date(t).toISOString().slice(0, 10);
		if (seen.has(day)) {
			if (openedAt && previous) {
				gaps.push({
					days: daysBetween(openedAt, previous),
					from: openedAt,
					to: previous,
				});
			}
			openedAt = null;
		} else {
			openedAt ??= day;
			previous = day;
		}
	}
	if (openedAt && previous) {
		gaps.push({
			days: daysBetween(openedAt, previous),
			from: openedAt,
			to: previous,
		});
	}
	return gaps;
}

/**
 * Runs of consecutive calendar days with no observation, longer than the
 * pair's cadence explains.
 *
 * A pair checked every `intervalDays` has that many days less one between two
 * observations by design. Reporting those made every pair on a stretched rung
 * a list of gaps, the same mistake as counting them against coverage.
 */
export function findGaps(
	dates: string[],
	from: string,
	to: string,
	intervalDays = 1
): Gap[] {
	return calendarGaps(dates, from, to).filter((g) => g.days >= intervalDays);
}

function fetches(e: ErrorWindow): string {
	return `${e.count} ${e.errorClass} ${e.count === 1 ? "fetch" : "fetches"} between ${e.from} and ${e.to}`;
}

/**
 * The window's holes in prose, in two voices.
 *
 * What cost observations comes with the warning not to read movement into the
 * window. What was absorbed is still named, because the provenance is the
 * point, but without that warning: a throttle that was retried the same day on
 * a fully observed pair says nothing against the ranks, and attaching the
 * warning to it put the warning on every pair in ordinary weather.
 */
function describe(
	degraded: boolean,
	observed: number,
	expected: number,
	intervalHours: number,
	errors: ErrorWindow[]
): string | null {
	const sentences: string[] = [];
	if (degraded) {
		const parts: string[] = [];
		if (observed < expected) {
			// Counted against the cadence, never the calendar: a pair checked weekly
			// is not missing six days out of seven.
			parts.push(
				`${expected - observed} of ${expected} expected observations are missing (one expected every ${intervalHours} hours)`
			);
		}
		parts.push(...errors.filter((e) => e.loss).map(fetches));
		sentences.push(
			`${parts.join("; ")}. Rank movement across this window is not evidence of a rank change.`
		);
	}
	const absorbed = errors.filter((e) => !e.loss);
	if (absorbed.length > 0) {
		sentences.push(
			`Also recorded: ${absorbed.map(fetches).join("; ")}. These are retried or are findings about Apple's own data, and are not themselves a lost observation.`
		);
	}
	return sentences.length > 0 ? sentences.join(" ") : null;
}

function summariseCoverage(
	observations: PairObservations,
	from: string,
	to: string
): Coverage {
	const { dates, errors } = observations;
	const windowDays = daysBetween(from, to);
	const intervalHours = observations.intervalHours ?? 24;
	// A pair on a stretched rung is *supposed* to have gaps; expectation follows
	// its cadence so that flexed frequency does not read as lost coverage.
	const expected = Math.max(1, Math.round(windowDays / (intervalHours / 24)));
	const coverage = Math.min(1, dates.length / expected);
	const gaps = findGaps(
		dates,
		from,
		to,
		Math.max(1, Math.round(intervalHours / 24))
	);
	// Only a class that cost an observation degrades the window. Counting every
	// recorded class flagged a fully observed pair for one requeued throttle,
	// and a signal that is always on is the one nobody reads.
	const degraded = coverage < DEGRADED_BELOW || errors.some((e) => e.loss);

	return {
		coverage: Number(coverage.toFixed(3)),
		degraded,
		errors,
		gaps,
		intervalHours,
		note: describe(degraded, dates.length, expected, intervalHours, errors),
		observed: {
			expectedObservations: expected,
			firstDate: dates[0] ?? null,
			lastDate: dates.at(-1) ?? null,
			observationCount: dates.length,
		},
		requested: { days: windowDays, from, to },
	};
}

/** Coverage of every pair in the set, in a fixed number of queries. */
export async function pairsCoverage(
	db: D1Database,
	pairIds: number[],
	from: string,
	to: string
): Promise<Map<number, Coverage>> {
	const observations = await pairsObservations(db, pairIds, from, to);
	return new Map(
		[...observations].map(([id, o]) => [id, summariseCoverage(o, from, to)])
	);
}

export async function pairCoverage(
	db: D1Database,
	pairId: number,
	from: string,
	to: string
): Promise<Coverage> {
	const all = await pairsCoverage(db, [pairId], from, to);
	return all.get(pairId) as Coverage;
}
