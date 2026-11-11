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
// Start 4/min, ×1.1 per day that stayed within tolerance and on which the loop
// actually fetched (ceiling 18/min), ×0.5 on a day that did not stay within it
// (floor 1/min). Persisted in D1 so redeploys keep discovery.

import { getState, getStateJson, setStateJson } from "./state";

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
// Apple states the Search API is "limited to approximately 20 calls per minute
// (subject to change)" and answers a breach with 403, not 429. Twenty is the
// documented edge, so the learned rate stops just under it; what actually binds
// is the reputation of the egress IP, which is why the rate is discovered
// rather than set. Cold start stays at DEFAULTS.ratePerMin, well below this: a
// fresh clone must not open at the ceiling.
const RATE_CEILING = 18;

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

/**
 * Three writers share this row: the work loop, the manual triggers and the
 * daily roll, and each of them awaits Apple or D1 between reading it and
 * writing it back. A whole-object save from a copy loaded before that await
 * erased whatever landed meanwhile: a manual throttle saved one second after
 * the loop's put `pauseUntil` back to zero, and the loop fetched again while
 * Apple was still refusing. So a change is applied to the row as it is now,
 * and the write only lands if the row is still the one that was read.
 */
const SWAP_ATTEMPTS = 4;

export async function updatePacing(
	db: D1Database,
	change: (p: PacingState) => PacingState
): Promise<{ before: PacingState; after: PacingState }> {
	for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
		const raw = await getState(db, KEY);
		const before: PacingState = {
			...DEFAULTS,
			...(raw === null ? {} : (JSON.parse(raw) as Partial<PacingState>)),
		};
		const after = change(before);
		if (after === before) {
			return { after, before };
		}
		const next = JSON.stringify(after);
		const written =
			raw === null
				? await db
						.prepare(
							"INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING"
						)
						.bind(KEY, next, Date.now())
						.run()
				: await db
						.prepare(
							"UPDATE collector_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?"
						)
						.bind(next, Date.now(), KEY, raw)
						.run();
		if (written.meta.changes > 0) {
			return { after, before };
		}
	}
	// Outrun every time, which takes a writer per attempt. A throttle that is
	// not recorded is the worse outcome, so the last word is a plain save.
	const before = await loadPacing(db);
	const after = change(before);
	await savePacing(db, after);
	return { after, before };
}

/** Milliseconds until the next Apple-facing fetch, with ±25% jitter. */
export function tickMs(p: PacingState): number {
	const base = 60_000 / p.ratePerMin;
	return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function onThrottle(p: PacingState, now = Date.now()): PacingState {
	// Apple's limit is per shared egress IP ("Rate limit has been exceeded for:
	// itunes-apple-com|general|<ip>"), and it is mostly consumed by others on
	// the same address. Egress IPs vary per isolate, so spread retries out:
	// pauses grow with consecutive throttles (30m, 1h, 2h, 4h cap).
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
 *
 * A quiet day is not a clean one. The only writer of the tally is a loop
 * throttle, so a day on which the loop fetched nothing (a deployment that
 * collects credentialed endpoints only, or a runner driven entirely through
 * the manual triggers, whose throttles are deliberately kept out of the tally)
 * closed at zero and raised the rate all the same: 4 to the ceiling in about
 * sixteen days, on no evidence at all. `loopFetched` is that evidence: the
 * loop reached Apple at least once in the closed period and was answered.
 */
export function maybeRaise(
	p: PacingState,
	today: string,
	loopFetched: boolean
): PacingState {
	if (p.lastRollDay === today) {
		return p;
	}
	const rolled = {
		...p,
		lastRollDay: today,
		throttlesPrevDay: p.windowErrorCount,
		windowErrorCount: 0,
	};
	if (rolled.throttlesPrevDay > DAILY_THROTTLE_TOLERANCE || !loopFetched) {
		return rolled;
	}
	return {
		...rolled,
		ratePerMin: Math.min(p.ratePerMin * 1.1, RATE_CEILING),
	};
}
