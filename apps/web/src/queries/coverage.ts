// How much of a window we actually observed, and what went wrong in the rest.
//
// This exists because a rate-limited week and a ranking collapse look identical
// in a series of positions. Apple's throttle returns HTTP 403 with an empty
// results array, which the collector records as a `fetch_error` rather than as
// "not ranking" — but a consumer reading only the observations still sees a
// hole and will happily narrate it as a decline. So every answer carries the
// shape of its own holes.
//
// Expected observations are computed from the pair's own cadence, not from the
// calendar. `crawl_pair.interval_hours` is stretched by the daily budget when
// demand exceeds the learned Apple rate, so a pair on a 7-day rung has six-day
// gaps by design. Counting those as missing days would report the whole tail of
// the tracked set as degraded and make the signal useless.

const DAY_MS = 86_400_000;

export interface ErrorWindow {
	from: string;
	to: string;
	errorClass: string;
	count: number;
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

export function daysBetween(from: string, to: string): number {
	return Math.max(
		1,
		Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
	);
}

export function isoDay(offsetDays: number, base = Date.now()): string {
	return new Date(base - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** Observed dates for one pair, plus the errors recorded against it. */
async function pairObservations(
	db: D1Database,
	pairId: number,
	from: string,
	to: string
) {
	const [dates, pair] = await Promise.all([
		db
			.prepare(
				`SELECT observed_date FROM ranking
         WHERE pair_id = ?1 AND valid = 1
           AND observed_date >= ?2 AND observed_date <= ?3
         ORDER BY observed_date`
			)
			.bind(pairId, from, to)
			.all<{ observed_date: string }>(),
		db
			.prepare(
				`SELECT cp.interval_hours, k.text AS keyword, cp.storefront_code, cp.locale_code
         FROM crawl_pair cp JOIN keyword k ON k.id = cp.keyword_id
         WHERE cp.id = ?1`
			)
			.bind(pairId)
			.first<{
				interval_hours: number;
				keyword: string;
				storefront_code: string;
				locale_code: string;
			}>(),
	]);

	if (!pair) {
		return {
			dates: dates.results.map((d) => d.observed_date),
			errors: [],
			pair,
		};
	}

	// The crawl task records the pair as "keyword|storefront|locale" in `params`;
	// that string is the only link between a failed fetch and the pair it was
	// for, since a failure deliberately writes no observation row.
	const key = `${pair.keyword}|${pair.storefront_code}|${pair.locale_code}`;
	const rows = await db
		.prepare(
			`SELECT error_class,
              MIN(DATE(fetched_at / 1000, 'unixepoch')) AS first_date,
              MAX(DATE(fetched_at / 1000, 'unixepoch')) AS last_date,
              COUNT(*) AS n
       FROM fetch_error
       WHERE params = ?1
         AND DATE(fetched_at / 1000, 'unixepoch') >= ?2
         AND DATE(fetched_at / 1000, 'unixepoch') <= ?3
       GROUP BY error_class
       ORDER BY n DESC`
		)
		.bind(key, from, to)
		.all<{
			error_class: string;
			first_date: string;
			last_date: string;
			n: number;
		}>();

	return {
		dates: dates.results.map((d) => d.observed_date),
		errors: rows.results.map((e) => ({
			count: e.n,
			errorClass: e.error_class,
			from: e.first_date,
			to: e.last_date,
		})),
		pair,
	};
}

/** Runs of consecutive calendar days with no observation. */
export function findGaps(dates: string[], from: string, to: string): Gap[] {
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

function describe(
	coverage: number,
	gaps: Gap[],
	errors: ErrorWindow[],
	windowDays: number
): string | null {
	if (coverage >= DEGRADED_BELOW && errors.length === 0) {
		return null;
	}
	const parts: string[] = [];
	const missing = gaps.reduce((n, g) => n + g.days, 0);
	if (missing > 0) {
		parts.push(`${missing} of ${windowDays} days have no observation`);
	}
	for (const e of errors) {
		parts.push(
			`${e.count} ${e.errorClass} ${e.count === 1 ? "fetch" : "fetches"} between ${e.from} and ${e.to}`
		);
	}
	if (parts.length === 0) {
		return null;
	}
	return `${parts.join("; ")}. Rank movement across this window is not evidence of a rank change.`;
}

export async function pairCoverage(
	db: D1Database,
	pairId: number,
	from: string,
	to: string
): Promise<Coverage> {
	const { dates, errors, pair } = await pairObservations(db, pairId, from, to);
	const windowDays = daysBetween(from, to);
	const intervalHours = pair?.interval_hours ?? 24;
	// A pair on a stretched rung is *supposed* to have gaps; expectation follows
	// its cadence so that flexed frequency does not read as lost coverage.
	const expected = Math.max(1, Math.round(windowDays / (intervalHours / 24)));
	const coverage = Math.min(1, dates.length / expected);
	const gaps = findGaps(dates, from, to);

	return {
		coverage: Number(coverage.toFixed(3)),
		degraded: coverage < DEGRADED_BELOW || errors.length > 0,
		errors,
		gaps,
		intervalHours,
		note: describe(coverage, gaps, errors, windowDays),
		observed: {
			expectedObservations: expected,
			firstDate: dates[0] ?? null,
			lastDate: dates.at(-1) ?? null,
			observationCount: dates.length,
		},
		requested: { days: windowDays, from, to },
	};
}
