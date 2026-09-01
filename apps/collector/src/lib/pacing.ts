// Adaptive politeness toward Apple's shared-IP tolerance. The learned rate is
// the actual crawl budget; Cloudflare limits are just guard rails.
//
// Two brakes, deliberately separate:
//
//   pause: per incident. Any 403/429 parks the loop, growing 30m → 1h → 2h →
//          4h across repeats within a day. This is what actually stops us
//          pushing on a bucket that is already full.
//   rate:  per day. Only moves when a day's throttle count exceeds what a
//          shared egress IP produces on its own, because most of that bucket
//          is consumed by other Workers on the same address; halving our own
//          share on one stray 429 costs coverage and relieves nothing.
//
// Start 4/min, ×1.1 per day that stayed within tolerance (ceiling 6/min),
// ×0.5 on a day that did not (floor 1/min). Persisted in D1 so redeploys keep
// discovery.

import { getStateJson, setStateJson } from "./state";

export interface PacingState {
	ratePerMin: number;
	pauseUntil: number; // epoch ms; 0 = not paused
	lastErrorAt: number;
	lastRollDay: string; // 'YYYY-MM-DD' of the last daily roll
	windowErrorCount: number; // throttle hits since that roll
	throttlesPrevDay: number; // the previous roll period's final count
}

const DEFAULTS: PacingState = {
	lastErrorAt: 0,
	lastRollDay: "",
	pauseUntil: 0,
	ratePerMin: 4,
	throttlesPrevDay: 0,
	windowErrorCount: 0,
};

const KEY = "pacing";

const RATE_FLOOR = 1;
const RATE_CEILING = 6;

/**
 * Throttles in a day that count as the shared IP's background level rather
 * than as pressure we are causing. Below this the pauses have already done the
 * work and the rate holds; above it the rate halves.
 */
const DAILY_THROTTLE_TOLERANCE = 4;

export async function loadPacing(db: D1Database): Promise<PacingState> {
	// Merged over defaults: state persisted by an older shape is missing the
	// newer counters, and an undefined counter would poison the arithmetic.
	const stored = await getStateJson<Partial<PacingState>>(db, KEY);
	return { ...DEFAULTS, ...stored };
}

export async function savePacing(
	db: D1Database,
	p: PacingState
): Promise<void> {
	await setStateJson(db, KEY, p);
}

/** Milliseconds until the next Apple-facing fetch, with ±50% jitter. */
export function tickMs(p: PacingState): number {
	const base = 60_000 / p.ratePerMin;
	return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function onThrottle(p: PacingState, now = Date.now()): PacingState {
	// Apple's limit is per shared egress IP ("Rate limit has been exceeded for:
	// itunes-apple-com|general|<ip>"), and it is mostly consumed by others on
	// the same address. Egress IPs vary per isolate, so spread retries out:
	// pauses grow
	// with consecutive throttles (30m, 1h, 2h, 4h cap).
	const count = p.windowErrorCount + 1;

	// Belt and braces: the loop parks for the whole pause, and manual fetches
	// book through `onAdminThrottle`, so this should not be reachable. Alarms
	// are at-least-once and can fire early on a retry, though, and a doubled
	// pause on a redelivered tick would be a hard bug to see. Count it, do not
	// compound a backoff already being served.
	if (now < p.pauseUntil) {
		return { ...p, lastErrorAt: now, windowErrorCount: count };
	}

	const pauseMinutes =
		Math.min(30 * 2 ** (count - 1), 240) * (0.75 + Math.random() * 0.5);
	return {
		...p,
		lastErrorAt: now,
		pauseUntil: now + Math.round(pauseMinutes * 60_000),
		// Halve once, on the throttle that takes the day past tolerance, not on
		// every throttle after it. Applying it repeatedly made the rate a one-way
		// ratchet again (4 → 2 → 1 in three hits), which is the exact behaviour
		// the two-brake split was introduced to remove: the pause is the
		// per-incident brake, the rate is the per-day trend.
		ratePerMin:
			count === DAILY_THROTTLE_TOLERANCE + 1
				? Math.max(p.ratePerMin * 0.5, RATE_FLOOR)
				: p.ratePerMin,
		windowErrorCount: count,
	};
}

/**
 * A throttle seen by a manually triggered fetch (`/admin/run`).
 *
 * Recorded, because it happened, but kept out of the day's tally and off the
 * pause ladder. The admin path already ignores `pauseUntil` on the way in, on
 * the grounds that it is a diagnostic and not the work loop; letting its
 * throttles steer the learned rate would make the measurement change the thing
 * it measures. Ten probe requests once halved a rate the loop had earned.
 */
export function onAdminThrottle(p: PacingState, now = Date.now()): PacingState {
	return { ...p, lastErrorAt: now };
}

/**
 * Called by the daily job: close out the day's throttle tally and move the
 * rate against it.
 *
 * Recovery is judged on the closed day, not on a throttle-free 24h. Apple
 * throttles this IP most days, so a "clean 24h" condition never held and the
 * rate was a one-way ratchet: every stray 429 halved it and nothing ever put
 * it back. Sitting at the floor is not a safe default: it silently shrinks the
 * budget that decides how often each pair is checked.
 */
export function maybeRaise(p: PacingState, today: string): PacingState {
	if (p.lastRollDay === today) {
		return p;
	}
	const rolled = {
		...p,
		lastRollDay: today,
		throttlesPrevDay: p.windowErrorCount,
		windowErrorCount: 0,
	};
	if (rolled.throttlesPrevDay > DAILY_THROTTLE_TOLERANCE) {
		return rolled;
	}
	return {
		...rolled,
		ratePerMin: Math.min(p.ratePerMin * 1.1, RATE_CEILING),
	};
}
