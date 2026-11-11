// Cadence recompute: decide how often each tracked pair is checked, given how
// much work exists and how fast Apple currently lets us go.
//
// Runs once a day, after the learned rate has been adjusted. It never adds or
// removes pairs, only moves them between rungs of the interval ladder, so
// growth in tracked apps or keywords costs resolution, never coverage.

import type { Env } from "../env";
import {
	computeCapacity,
	measureOverheadPerDay,
	planCadence,
} from "../lib/budget";
import type { CadencePlan } from "../lib/budget";
import { chartGenres, pullTargets, targetStorefronts } from "../lib/fanout";
import { loadPacing } from "../lib/pacing";
import { getStateJson, setStateJson } from "../lib/state";

const DEFAULT_WINDOW_HOURS = 3;
// Must match the crawl's own default (scheduler.ts), or the two disagree on
// when a pair is due.
const DEFAULT_WINDOW_START_HOUR = 3;
const VOLATILITY_WINDOW_DAYS = 14;

/**
 * Per-pair priority. Higher scores are checked more often.
 *
 * - popularity: a term nobody searches barely matters, however it moves.
 * - threshold proximity: rank 9–12 decides whether we are on page one;
 *   rank 180 is noise either way.
 * - volatility: a pair that has been flat for weeks tells us little daily.
 * - market weight: the operator's own judgement of which storefronts pay.
 * - unobserved pairs sort to the top: a new pair needs a baseline before any
 *   of the other signals mean anything. The count is coalesced because a pair
 *   with no ranking row at all has no row in the count either, and a NULL
 *   comparison quietly took the branch meant for well-observed pairs: the
 *   newest pair of all was the one pair that never got the boost.
 */
const SCORE_SQL = `
  0.30 * COALESCE(pop.popularity_1_100, 20) / 100.0
  + 0.40 * CASE
      WHEN latest.position IS NULL THEN 0.5
      WHEN latest.position <= 3 THEN 0.8
      WHEN latest.position BETWEEN 4 AND 20 THEN 1.0
      WHEN latest.position <= 60 THEN 0.6
      ELSE 0.2
    END
  + 0.20 * MIN(1.0, COALESCE(cp.volatility, 0) / 10.0)
  + 0.10 * MIN(1.0, s.weight)
  + CASE WHEN latest.position IS NULL AND COALESCE(obs.n, 0) < 7 THEN 1.0 ELSE 0 END
  + CASE WHEN cp.burst_until IS NOT NULL AND cp.burst_until > ?1 THEN 1.0 ELSE 0 END
`;

/**
 * Refresh each pair's volatility: the spread of its recent ranks, computed in
 * SQL so the rows never cross into the isolate. Unranked days are ignored:
 * "not in the top 200" is not a position to take a variance over.
 *
 * Per tracked app first, then the largest. A pair is shared by everyone who
 * tracks its keyword, so taking one deviation over all their apps measured the
 * distance between two apps rather than the movement of either: one at rank 3
 * and one at 150, neither having moved in a fortnight, read as the most
 * volatile pair in the set.
 */
async function refreshVolatility(env: Env, since: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE crawl_pair SET volatility = COALESCE((
       SELECT MAX(spread) FROM (
         SELECT
           -- population standard deviation of one app's observed positions
           CASE WHEN COUNT(re.position) < 2 THEN 0 ELSE
             SQRT(MAX(0,
               AVG(re.position * re.position) - AVG(re.position) * AVG(re.position)
             ))
           END AS spread
         FROM ranking r
         JOIN rank_entry re ON re.ranking_id = r.id
         JOIN tracked_keyword tk ON tk.keyword_id = crawl_pair.keyword_id
           AND tk.app_id = re.app_id
         WHERE r.pair_id = crawl_pair.id AND r.valid = 1 AND r.observed_date >= ?1
         GROUP BY re.app_id
       )
     ), 0)
     WHERE ref_count > 0 AND tier = 1`
	)
		.bind(since)
		.run();
}

/**
 * What the non-keyword daily work costs, measured from the same definition
 * the daily job queues it from (lib/fanout), so the budget charges the pulls
 * that will actually run.
 */
async function measureOverhead(env: Env): Promise<number> {
	const targets = await pullTargets(env.DB);
	const genres = await chartGenres(env.DB);
	return measureOverheadPerDay({
		appStorefrontPairs: targets.length,
		chartGenres: genres.length,
		storefronts: targetStorefronts(targets).length,
	});
}

/**
 * Apply the plan: rank every active pair by score and give the top slice the
 * fast interval, the rest the slow one. A pair inside its metadata-change
 * burst window is pinned to daily regardless of where it scores.
 */
async function applyIntervals(
	env: Env,
	plan: CadencePlan,
	now: number
): Promise<void> {
	await env.DB.prepare(
		`WITH latest AS (
       -- The best position among the apps tracking this keyword. A bare
       -- column under the GROUP BY returned whichever app SQLite read last.
       SELECT r.pair_id, MIN(re.position) AS position
       FROM ranking r
       JOIN crawl_pair cp ON cp.id = r.pair_id
       JOIN tracked_keyword tk ON tk.keyword_id = cp.keyword_id
       LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.app_id = tk.app_id
       WHERE r.valid = 1
         AND r.observed_date = (
           SELECT MAX(observed_date) FROM ranking
           WHERE pair_id = r.pair_id AND valid = 1)
       GROUP BY r.pair_id
     ),
     obs AS (
       SELECT pair_id, COUNT(*) AS n FROM ranking WHERE valid = 1 GROUP BY pair_id
     ),
     pop AS (
       SELECT p.keyword_id, p.storefront_code, MAX(p.week_start) AS w,
              p.popularity_1_100
       FROM popularity p WHERE p.present = 1
       GROUP BY p.keyword_id, p.storefront_code
     ),
     scored AS (
       SELECT cp.id,
              ROW_NUMBER() OVER (ORDER BY (${SCORE_SQL}) DESC, cp.id) AS rn
       FROM crawl_pair cp
       JOIN storefront s ON s.code = cp.storefront_code
       LEFT JOIN latest ON latest.pair_id = cp.id
       LEFT JOIN obs ON obs.pair_id = cp.id
       LEFT JOIN pop ON pop.keyword_id = cp.keyword_id
         AND pop.storefront_code = cp.storefront_code
       WHERE cp.ref_count > 0 AND cp.tier = 1
     )
     UPDATE crawl_pair
     SET interval_hours = CASE
       WHEN crawl_pair.burst_until IS NOT NULL AND crawl_pair.burst_until > ?1
         THEN 24
       WHEN (SELECT rn FROM scored WHERE scored.id = crawl_pair.id) <= ?2
         THEN ?3
       ELSE ?4
     END
     WHERE ref_count > 0 AND tier = 1`
	)
		.bind(now, plan.fastCount, plan.fastDays * 24, plan.slowDays * 24)
		.run();
}

/**
 * Pull in any pair whose next check is now further out than its new interval
 * allows, so a cadence speed-up takes effect today rather than after the old
 * (slower) interval elapses.
 *
 * The deadline is aligned to the crawl window, never to the fetch clock. An
 * earlier version wrote last_fetched_at + interval, and on 2026-09-03 that put
 * every pair crawled at 08:00 due at 08:00 the next day, five hours after the
 * 03:10 run had found nothing due and exited. Half the set then alternated
 * between "not yet due" and "overdue" and lost every other day, which is
 * exactly the history invariant 1 says cannot be recovered. This is the same
 * deadline crawl.ts computes on a successful fetch: the first window start
 * after the last fetch, plus whole days for the slower rungs, so a pair on the
 * daily rung is always due by the time the run starts.
 */
async function tightenDueDates(
	env: Env,
	now: number,
	windowStartHour: number
): Promise<void> {
	// Bound numbers arrive as REAL, so the day count is cast to floor it; epoch
	// seconds sit far above one day, so truncation and floor agree.
	const aligned = `(
       (CAST((COALESCE(last_fetched_at, ?1) / 1000 - ?2 * 3600) / 86400 AS INTEGER)
         + 1 + MAX(0, (interval_hours + 12) / 24 - 1)) * 86400
       + CAST(?2 AS INTEGER) * 3600
     ) * 1000`;
	await env.DB.prepare(
		`UPDATE crawl_pair
     SET next_due_at = ${aligned}
     WHERE ref_count > 0 AND tier = 1
       AND next_due_at > ${aligned}`
	)
		.bind(now, windowStartHour)
		.run();
}

/** Recompute the crawl budget and re-space every tracked pair against it. */
export async function recomputeCadence(env: Env): Promise<CadencePlan> {
	const now = Date.now();
	const since = new Date(now - VOLATILITY_WINDOW_DAYS * 24 * 3_600_000)
		.toISOString()
		.slice(0, 10);

	await refreshVolatility(env, since);

	const [pacing, overhead, pairRow, windowHours, windowStartHour] =
		await Promise.all([
			loadPacing(env.DB),
			measureOverhead(env),
			env.DB.prepare(
				"SELECT COUNT(*) AS n FROM crawl_pair WHERE ref_count > 0 AND tier = 1"
			).first<{ n: number }>(),
			getStateJson<number>(env.DB, "tier1_window_hours"),
			getStateJson<number>(env.DB, "tier1_window_start_hour"),
		]);

	const capacity = computeCapacity({
		overheadPerDay: overhead,
		ratePerMin: pacing.ratePerMin,
		windowHours: windowHours ?? DEFAULT_WINDOW_HOURS,
	});
	const plan = planCadence(pairRow?.n ?? 0, capacity);

	await applyIntervals(env, plan, now);
	await tightenDueDates(env, now, windowStartHour ?? DEFAULT_WINDOW_START_HOUR);
	await setStateJson(env.DB, "cadence_plan", { ...plan, computedAt: now });

	return plan;
}
