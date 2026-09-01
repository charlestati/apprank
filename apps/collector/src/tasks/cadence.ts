// Cadence recompute: decide how often each tracked pair is checked, given how
// much work exists and how fast Apple currently lets us go.
//
// Runs once a day, after the learned rate has been adjusted. It never adds or
// removes pairs — it only moves them between rungs of the interval ladder, so
// growth in tracked apps or keywords costs resolution, never coverage.

import type { Env } from "../env";
import {
	computeCapacity,
	measureOverheadPerDay,
	planCadence,
} from "../lib/budget";
import type { CadencePlan } from "../lib/budget";
import { loadPacing } from "../lib/pacing";
import { getStateJson, setStateJson } from "../lib/state";

const DEFAULT_WINDOW_HOURS = 3;
const DEFAULT_CHART_GENRES = 2;
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
 *   of the other signals mean anything.
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
  + CASE WHEN latest.position IS NULL AND obs.n < 7 THEN 1.0 ELSE 0 END
  + CASE WHEN cp.burst_until IS NOT NULL AND cp.burst_until > ?1 THEN 1.0 ELSE 0 END
`;

/**
 * Refresh each pair's volatility: the spread of its recent ranks, computed in
 * SQL so the rows never cross into the isolate. Unranked days are ignored —
 * "not in the top 200" is not a position to take a variance over.
 */
async function refreshVolatility(env: Env, since: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE crawl_pair SET volatility = COALESCE((
       SELECT
         -- population standard deviation of the observed positions
         CASE WHEN COUNT(re.position) < 2 THEN 0 ELSE
           SQRT(
             AVG(re.position * re.position) - AVG(re.position) * AVG(re.position)
           )
         END
       FROM ranking r
       JOIN rank_entry re ON re.ranking_id = r.id
       JOIN tracked_keyword tk ON tk.keyword_id = crawl_pair.keyword_id
         AND tk.app_id = re.app_id
       WHERE r.pair_id = crawl_pair.id AND r.valid = 1 AND r.observed_date >= ?1
     ), 0)
     WHERE ref_count > 0 AND tier = 1`
	)
		.bind(since)
		.run();
}

/** What the non-keyword daily work costs, measured from the tracked set. */
async function measureOverhead(env: Env): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT
       (SELECT COUNT(*) FROM (
          SELECT ta.app_id, sl.storefront_code
          FROM tracked_app ta
          JOIN app_language al ON al.app_id = ta.app_id
          JOIN locale l ON l.language = al.language
          JOIN storefront_locale sl ON sl.locale_code = l.code
          JOIN storefront s ON s.code = sl.storefront_code AND s.active = 1
          GROUP BY ta.app_id, sl.storefront_code)) AS app_storefronts,
       (SELECT COUNT(DISTINCT cp.storefront_code) FROM crawl_pair cp
         WHERE cp.ref_count > 0 AND cp.tier = 1) AS storefronts`
	).first<{ app_storefronts: number; storefronts: number }>();

	const configuredGenres = await getStateJson<(number | null)[]>(
		env.DB,
		"chart_genres"
	);
	const chartGenres = configuredGenres?.length ?? DEFAULT_CHART_GENRES;

	return measureOverheadPerDay({
		appStorefrontPairs: row?.app_storefronts ?? 0,
		chartGenres,
		storefronts: row?.storefronts ?? 0,
	});
}

/**
 * Apply the plan: rank every active pair by score and give the top slice the
 * fast interval, the rest the slow one. A pair inside its metadata-change burst
 * window is pinned to daily regardless of where it scores.
 */
async function applyIntervals(
	env: Env,
	plan: CadencePlan,
	now: number
): Promise<void> {
	await env.DB.prepare(
		`WITH latest AS (
       SELECT r.pair_id, re.position
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
 */
async function tightenDueDates(env: Env, now: number): Promise<void> {
	await env.DB.prepare(
		`UPDATE crawl_pair
     SET next_due_at = COALESCE(last_fetched_at, ?1) + interval_hours * 3600000
     WHERE ref_count > 0 AND tier = 1
       AND next_due_at > COALESCE(last_fetched_at, ?1) + interval_hours * 3600000`
	)
		.bind(now)
		.run();
}

/** Recompute the crawl budget and re-space every tracked pair against it. */
export async function recomputeCadence(env: Env): Promise<CadencePlan> {
	const now = Date.now();
	const since = new Date(now - VOLATILITY_WINDOW_DAYS * 24 * 3_600_000)
		.toISOString()
		.slice(0, 10);

	await refreshVolatility(env, since);

	const [pacing, overhead, pairRow, windowHours] = await Promise.all([
		loadPacing(env.DB),
		measureOverhead(env),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM crawl_pair WHERE ref_count > 0 AND tier = 1"
		).first<{ n: number }>(),
		getStateJson<number>(env.DB, "tier1_window_hours"),
	]);

	const capacity = computeCapacity({
		overheadPerDay: overhead,
		ratePerMin: pacing.ratePerMin,
		windowHours: windowHours ?? DEFAULT_WINDOW_HOURS,
	});
	const plan = planCadence(pairRow?.n ?? 0, capacity);

	await applyIntervals(env, plan, now);
	await tightenDueDates(env, now);
	await setStateJson(env.DB, "cadence_plan", { ...plan, computedAt: now });

	return plan;
}
