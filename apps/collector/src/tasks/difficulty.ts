// Daily difficulty recompute. Pure SQL plus arithmetic — no fetches, so it
// costs nothing against the Apple budget and can be re-run at will.

import type { Env } from "../env";
import { computeDifficulty, FORMULA_VERSION } from "../lib/difficulty";

const STABILITY_WINDOW_DAYS = 14;
const CHUNK = 40;

interface PairFacts {
  pair_id: number;
  observed_date: string;
  result_count: number | null;
  /** Comma-separated "position:rating_count" for the top ten, ordered. */
  top: string | null;
  distinct_apps: number;
}

/**
 * One row per pair: its latest observation, the rating counts of the apps on
 * that result page, and how many distinct apps have held a top-10 slot lately.
 *
 * Rating counts come from the newest metadata version we hold for each app,
 * which the crawler already captures for every top-10 sighting.
 */
function fetchFacts(env: Env, since: string) {
  return env.DB.prepare(
    `WITH latest AS (
       SELECT r.pair_id, MAX(r.observed_date) AS d
       FROM ranking r
       JOIN crawl_pair cp ON cp.id = r.pair_id AND cp.ref_count > 0 AND cp.tier = 1
       WHERE r.valid = 1
       GROUP BY r.pair_id
     ),
     newest_meta AS (
       SELECT app_id, MAX(captured_at) AS captured_at
       FROM app_metadata_version GROUP BY app_id
     ),
     churn AS (
       SELECT r.pair_id, COUNT(DISTINCT re.app_id) AS distinct_apps
       FROM ranking r
       JOIN rank_entry re ON re.ranking_id = r.id AND re.position <= 10
       WHERE r.valid = 1 AND r.observed_date >= ?1
       GROUP BY r.pair_id
     )
     SELECT l.pair_id, l.d AS observed_date, r.result_count,
            GROUP_CONCAT(re.position || ':' || COALESCE(amv.rating_count, -1)) AS top,
            COALESCE(churn.distinct_apps, 0) AS distinct_apps
     FROM latest l
     JOIN ranking r ON r.pair_id = l.pair_id AND r.observed_date = l.d AND r.valid = 1
     LEFT JOIN rank_entry re ON re.ranking_id = r.id AND re.position <= 10
     LEFT JOIN newest_meta nm ON nm.app_id = re.app_id
     LEFT JOIN app_metadata_version amv ON amv.app_id = nm.app_id
       AND amv.captured_at = nm.captured_at
     LEFT JOIN churn ON churn.pair_id = l.pair_id
     GROUP BY l.pair_id`
  )
    .bind(since)
    .all<PairFacts>();
}

/** "3:1200,1:98000" → ratings for the top three and the top ten. */
function parseTop(top: string | null): {
  topThree: number[];
  topTen: number[];
} {
  const topThree: number[] = [];
  const topTen: number[] = [];
  for (const entry of (top ?? "").split(",")) {
    const [posText, ratingText] = entry.split(":");
    const position = Number(posText);
    const rating = Number(ratingText);
    // -1 marks an app we have not captured metadata for yet.
    if (!(position && Number.isFinite(rating)) || rating < 0) {
      continue;
    }
    topTen.push(rating);
    if (position <= 3) {
      topThree.push(rating);
    }
  }
  return { topThree, topTen };
}

export interface DifficultyRun {
  scored: number;
  skipped: number;
}

/**
 * Score every tracked pair's most recent observation. Pairs whose result page
 * we hold no rating counts for are skipped rather than scored from nothing —
 * a difficulty number with no evidence behind it is worse than none.
 */
export async function recomputeDifficulty(env: Env): Promise<DifficultyRun> {
  const since = new Date(Date.now() - STABILITY_WINDOW_DAYS * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const facts = await fetchFacts(env, since);

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;

  for (const row of facts.results) {
    const { topThree, topTen } = parseTop(row.top);
    if (topTen.length === 0) {
      skipped += 1;
      continue;
    }
    const d = computeDifficulty({
      distinctTopTenApps: row.distinct_apps,
      resultCount: row.result_count ?? 0,
      topThreeRatings: topThree,
      topTenRatings: topTen,
    });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO keyword_difficulty
           (pair_id, observed_date, score, entrenchment, incumbent_strength,
            stability, saturation, sample_size, formula_version, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(pair_id, observed_date) DO UPDATE SET
           score = excluded.score, entrenchment = excluded.entrenchment,
           incumbent_strength = excluded.incumbent_strength,
           stability = excluded.stability, saturation = excluded.saturation,
           sample_size = excluded.sample_size,
           formula_version = excluded.formula_version,
           computed_at = excluded.computed_at
         -- Recomputed daily from data that mostly has not moved; without this
         -- every pair rewrote an identical score once a day.
         WHERE score IS NOT excluded.score
            OR sample_size IS NOT excluded.sample_size
            OR formula_version IS NOT excluded.formula_version
      `
      ).bind(
        row.pair_id,
        row.observed_date,
        d.score,
        d.entrenchment,
        d.incumbentStrength,
        d.stability,
        d.saturation,
        d.sampleSize,
        FORMULA_VERSION,
        now
      )
    );
  }

  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }

  return { scored: stmts.length, skipped };
}
