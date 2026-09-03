// Crawl-budget arithmetic: how much we can fetch in a day, and how often each
// tracked pair can therefore be checked.
//
// The governing rule is **flex frequency, never coverage**. Dropping a pair
// destroys its history permanently; checking it every other day keeps the
// series alive at lower resolution. So when demand outgrows the discovered
// Apple rate, intervals stretch, and the tracked set never shrinks.

/** Interval ladder in days. Nothing is ever checked less often than the last. */
export const INTERVAL_LADDER_DAYS = [1, 2, 3, 7] as const;

export interface CapacityInput {
	/** Fetches per minute the collector has learned Apple tolerates. */
	ratePerMin: number;
	/** Hours per day the collection window is open. */
	windowHours: number;
	/** Daily fetches already committed to app-level pulls and API polling. */
	overheadPerDay: number;
}

export interface Capacity {
	totalPerDay: number;
	overheadPerDay: number;
	/** What is left for keyword rank checks. */
	keywordsPerDay: number;
}

export function computeCapacity({
	ratePerMin,
	windowHours,
	overheadPerDay,
}: CapacityInput): Capacity {
	const totalPerDay = Math.floor(ratePerMin * 60 * windowHours);
	return {
		keywordsPerDay: Math.max(0, totalPerDay - overheadPerDay),
		overheadPerDay,
		totalPerDay,
	};
}

/**
 * Daily fetches the non-keyword work costs: one metadata lookup and one review
 * feed per (tracked app × storefront), plus the chart pulls, which are per
 * storefront rather than per app.
 */
export function measureOverheadPerDay(input: {
	appStorefrontPairs: number;
	storefronts: number;
	chartGenres: number;
}): number {
	const perApp = input.appStorefrontPairs * 2;
	const charts = input.storefronts * input.chartGenres * 3;
	return perApp + charts;
}

export interface Allocation {
	/** Interval, in days, for the highest-priority share of the pairs. */
	fastDays: number;
	/** Interval for the remainder. */
	slowDays: number;
	/** How many pairs get `fastDays`; the rest get `slowDays`. */
	fastCount: number;
	/** Fetches per day the plan consumes. */
	loadPerDay: number;
	/**
	 * True when even the slowest rung on the ladder overruns the budget: every
	 * pair is at the floor resolution and the window is genuinely too small.
	 */
	saturated: boolean;
}

/**
 * Split `count` pairs across two adjacent rungs of the ladder so the resulting
 * load fits the capacity exactly, rather than rounding everything to one rung.
 *
 * With capacity C and N pairs, each pair can be checked C/N times a day. If
 * that lands between two rungs a and b, the share f on the faster rung solves
 * f/a + (1 - f)/b = C/N.
 */
export function allocate(count: number, keywordsPerDay: number): Allocation {
	const ladder = INTERVAL_LADDER_DAYS;
	const [fastest] = ladder;
	const slowest = ladder.at(-1) as number;

	if (count === 0) {
		return {
			fastCount: 0,
			fastDays: fastest,
			loadPerDay: 0,
			saturated: false,
			slowDays: fastest,
		};
	}

	const perPairPerDay = keywordsPerDay / count;

	if (perPairPerDay >= 1) {
		return {
			fastCount: count,
			fastDays: fastest,
			loadPerDay: count,
			saturated: false,
			slowDays: fastest,
		};
	}

	if (perPairPerDay <= 1 / slowest) {
		return {
			fastCount: 0,
			fastDays: slowest,
			loadPerDay: count / slowest,
			saturated: true,
			slowDays: slowest,
		};
	}

	for (let i = 0; i < ladder.length - 1; i += 1) {
		const fast = ladder[i] as number;
		const slow = ladder[i + 1] as number;
		if (perPairPerDay <= 1 / fast && perPairPerDay >= 1 / slow) {
			const share = (perPairPerDay - 1 / slow) / (1 / fast - 1 / slow);
			const fastCount = Math.round(share * count);
			return {
				fastCount,
				fastDays: fast,
				loadPerDay: fastCount / fast + (count - fastCount) / slow,
				saturated: false,
				slowDays: slow,
			};
		}
	}

	// Unreachable: the loop covers every gap between the rungs.
	return {
		fastCount: 0,
		fastDays: slowest,
		loadPerDay: count / slowest,
		saturated: true,
		slowDays: slowest,
	};
}

export interface CadencePlan extends Allocation {
	capacity: Capacity;
	pairs: number;
	/** Human-readable summary for the data-health page. */
	summary: string;
}

export function planCadence(pairs: number, capacity: Capacity): CadencePlan {
	const allocation = allocate(pairs, capacity.keywordsPerDay);
	const slowCount = pairs - allocation.fastCount;
	let summary: string;
	if (pairs === 0) {
		summary = "Nothing tracked yet.";
	} else if (allocation.saturated) {
		summary = `Budget saturated: all ${pairs} pairs checked every ${allocation.slowDays} days, the floor resolution.`;
	} else if (slowCount === 0) {
		summary = `All ${pairs} pairs checked daily.`;
	} else {
		summary = `${allocation.fastCount} pairs every ${allocation.fastDays}d, ${slowCount} every ${allocation.slowDays}d.`;
	}
	return { ...allocation, capacity, pairs, summary };
}
