// Tier 1 keyword-rank crawl: one (keyword, storefront, locale) pair per tick.
//
// Persistence per observation (all idempotent — alarms are at-least-once):
//   R2 staging/rankings/{date}/{pairId}.json      normalised observation
//   R2 verbatim/{date}/{fetchId}.json             failures + 1-in-10 sample
//   D1 ranking (UNIQUE pair_id+date), rank_entry (top-10 + tracked apps),
//      app + app_metadata_version (top-10 + tracked only — full 200-depth app
//      metadata is recoverable from the archive in batch, not worth 200 rows
//      of writes per fetch)
//   crawl_pair.next_due_at advanced to tomorrow's window

import { searchUrl, fetchClassified } from "@apprank/core/apple/itunes";
import {
  validateSearchResponse,
  extractRanking,
  normalizeApp,
} from "@apprank/core/normalize/itunes";

import type { Env } from "../env";
import { COLLECTOR_VERSION } from "../env";
import { recordFetchError } from "../lib/state";

export interface DuePair {
  id: number;
  keyword_text: string;
  storefront_code: string;
  locale_code: string;
  weight: number;
  interval_hours: number;
}

export async function pickDuePair(
  db: D1Database,
  now = Date.now()
): Promise<DuePair | null> {
  // Priority v1: overdue-age × market weight × burst multiplier. The full
  // volatility/threshold formula arrives with the daily recompute job.
  const row = await db
    .prepare(
      `SELECT cp.id, k.text AS keyword_text, cp.storefront_code, cp.locale_code, s.weight, cp.interval_hours
       FROM crawl_pair cp
       JOIN keyword k ON k.id = cp.keyword_id
       JOIN storefront s ON s.code = cp.storefront_code
       WHERE cp.ref_count > 0 AND cp.tier = 1 AND cp.next_due_at <= ?1
         -- The ranking table is unique on (pair_id, observed_date), so a
         -- second crawl of the same UTC day overwrites the row it already
         -- wrote: no new history, ~30 row-writes spent. Anything that moves
         -- next_due_at backwards -- a reseed, a manual re-run -- would
         -- otherwise re-crawl the whole set. Coverage is unaffected: the pair
         -- is still due, it just becomes collectable once the day turns.
         AND NOT EXISTS (
           SELECT 1 FROM ranking r
           WHERE r.pair_id = cp.id AND r.observed_date = ?2
         )
       ORDER BY (?1 - cp.next_due_at) * s.weight *
                (CASE WHEN cp.burst_until IS NOT NULL AND cp.burst_until > ?1 THEN 3 ELSE 1 END) DESC
       LIMIT 1`
    )
    .bind(now, new Date(now).toISOString().slice(0, 10))
    .first<DuePair>();
  return row ?? null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Next due: tomorrow at the window start (03:00 UTC), respecting interval_hours. */
function nextDue(intervalHours: number, windowStartHour: number): number {
  const next = new Date();
  next.setUTCHours(windowStartHour, 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  // interval_hours > 24 (weekly cadence etc.) pushes further out in whole days.
  const extraDays = Math.max(0, Math.round(intervalHours / 24) - 1);
  return next.getTime() + extraDays * 24 * 3_600_000;
}

/** Returns true when the fetch was throttled (caller backs off). */
export async function crawlPair(
  env: Env,
  pair: DuePair,
  windowStartHour: number
): Promise<{ throttled: boolean }> {
  const url = searchUrl(
    pair.keyword_text,
    pair.storefront_code,
    pair.locale_code
  );
  const date = todayUtc();
  const outcome = await fetchClassified(url);
  const fetchId = `${date}-p${pair.id}-${Date.now()}`;

  if (outcome.kind === "throttled") {
    await env.ARCHIVE.put(
      `verbatim/${date}/${fetchId}-throttled.json`,
      outcome.bodyText
    );
    await recordFetchError(env.DB, {
      endpoint: "itunes:search",
      errorClass: "throttled",
      httpStatus: outcome.status,
      params: `${pair.keyword_text}|${pair.storefront_code}|${pair.locale_code}`,
      r2Key: `verbatim/${date}/${fetchId}-throttled.json`,
      responseMs: outcome.responseMs,
    });
    return { throttled: true };
  }

  if (outcome.kind === "error" || !validateSearchResponse(outcome.json)) {
    await env.ARCHIVE.put(
      `verbatim/${date}/${fetchId}-error.json`,
      outcome.bodyText.slice(0, 4_000_000)
    );
    await recordFetchError(env.DB, {
      endpoint: "itunes:search",
      errorClass: outcome.kind === "error" ? "http_error" : "invalid_body",
      httpStatus: outcome.status,
      params: `${pair.keyword_text}|${pair.storefront_code}|${pair.locale_code}`,
      r2Key: `verbatim/${date}/${fetchId}-error.json`,
      responseMs: outcome.responseMs,
    });
    // Not throttling: reschedule the pair for tomorrow rather than wedging today.
    await env.DB.prepare("UPDATE crawl_pair SET next_due_at = ? WHERE id = ?")
      .bind(nextDue(pair.interval_hours, windowStartHour), pair.id)
      .run();
    return { throttled: false };
  }

  const { json } = outcome;
  const { resultIds, resultCount } = extractRanking(json);

  // Verbatim sample: 1-in-10 successes, for parser-bug recovery (R2 lifecycle
  // expires these at 21 days).
  const r2Key = Math.random() < 0.1 ? `verbatim/${date}/${fetchId}.json` : null;
  if (r2Key) {
    await env.ARCHIVE.put(r2Key, outcome.bodyText);
  }

  // Tracked apps in this response (beyond the top 10).
  const trackedRows = await env.DB.prepare(
    "SELECT DISTINCT app_id FROM tracked_app"
  ).all<{ app_id: number }>();
  const trackedIds = new Set(trackedRows.results.map((r) => r.app_id));
  const interesting = json.results.filter(
    (r, i) => i < 10 || trackedIds.has(r.trackId)
  );

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const result of interesting) {
    const napp = await normalizeApp(result);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO app (id, bundle_id, current_name, developer_id, developer_name, primary_genre_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bundle_id = excluded.bundle_id, current_name = excluded.current_name,
           developer_id = excluded.developer_id, developer_name = excluded.developer_name,
           primary_genre_id = excluded.primary_genre_id, last_seen_at = excluded.last_seen_at
         -- Without this, every top-10 app on every pair was a guaranteed
         -- row-write each day, because last_seen_at always differs. It is
         -- written and never read, so it alone must not cost anything.
         WHERE bundle_id IS NOT excluded.bundle_id
            OR current_name IS NOT excluded.current_name
            OR developer_id IS NOT excluded.developer_id
            OR developer_name IS NOT excluded.developer_name
            OR primary_genre_id IS NOT excluded.primary_genre_id`
      ).bind(
        napp.id,
        napp.bundleId,
        napp.name,
        napp.developerId,
        napp.developerName,
        napp.primaryGenreId,
        now,
        now
      )
    );
    const m = napp.metadata;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO app_metadata_version
           (app_id, captured_at, source, title, subtitle, description_hash, version, price, currency, has_iap,
            genre_ids, rating_count, rating_avg, screenshot_urls_hash, icon_url, release_notes_hash, content_hash)
         VALUES (?, ?, 'itunes-search', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        napp.id,
        now,
        m.title,
        m.subtitle,
        m.descriptionHash,
        m.version,
        m.price,
        m.currency,
        m.genreIds,
        m.ratingCount,
        m.ratingAvg,
        m.screenshotUrlsHash,
        m.iconUrl,
        m.releaseNotesHash,
        m.contentHash
      )
    );
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, response_ms, result_count, result_ids, collector_version, r2_key, valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(pair_id, observed_date) DO UPDATE SET fetched_at = excluded.fetched_at,
         http_status = excluded.http_status, response_ms = excluded.response_ms,
         result_count = excluded.result_count, result_ids = excluded.result_ids,
         collector_version = excluded.collector_version, r2_key = excluded.r2_key, valid = 1`
    ).bind(
      pair.id,
      date,
      now,
      outcome.status,
      outcome.responseMs,
      resultCount,
      JSON.stringify(resultIds),
      COLLECTOR_VERSION,
      r2Key
    ),
    env.DB.prepare(
      "UPDATE crawl_pair SET last_fetched_at = ?, next_due_at = ? WHERE id = ?"
    ).bind(now, nextDue(pair.interval_hours, windowStartHour), pair.id)
  );
  await env.DB.batch(stmts);

  // rank_entry rows need the ranking id (re-run safe: delete + insert).
  const rk = await env.DB.prepare(
    "SELECT id FROM ranking WHERE pair_id = ? AND observed_date = ?"
  )
    .bind(pair.id, date)
    .first<{ id: number }>();
  if (rk) {
    const wanted = json.results
      .map((r, i) => ({ appId: r.trackId, position: i + 1 }))
      .filter((e, i) => i < 10 || trackedIds.has(e.appId));

    // Rewrite only when the indexed page actually moved. A board that held its
    // order — the common case between two consecutive days — used to cost a
    // delete plus eleven inserts for an identical result.
    const existing = await env.DB.prepare(
      "SELECT position, app_id FROM rank_entry WHERE ranking_id = ? ORDER BY position"
    )
      .bind(rk.id)
      .all<{ position: number; app_id: number }>();
    const same =
      existing.results.length === wanted.length &&
      existing.results.every(
        (e, i) =>
          e.position === wanted[i]?.position && e.app_id === wanted[i]?.appId
      );

    if (!same) {
      const entryStmts: D1PreparedStatement[] = [
        env.DB.prepare("DELETE FROM rank_entry WHERE ranking_id = ?").bind(
          rk.id
        ),
      ];
      for (const e of wanted) {
        entryStmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO rank_entry (ranking_id, position, app_id) VALUES (?, ?, ?)"
          ).bind(rk.id, e.position, e.appId)
        );
      }
      await env.DB.batch(entryStmts);
    }
  }

  // Normalised observation to staging (compacted into daily NDJSON overnight).
  await env.ARCHIVE.put(
    `staging/rankings/${date}/${pair.id}.json`,
    JSON.stringify({
      collectorVersion: COLLECTOR_VERSION,
      date,
      fetchedAt: now,
      httpStatus: outcome.status,
      keyword: pair.keyword_text,
      locale: pair.locale_code,
      pairId: pair.id,
      responseMs: outcome.responseMs,
      resultCount,
      resultIds,
      storefront: pair.storefront_code,
    })
  );

  return { throttled: false };
}
