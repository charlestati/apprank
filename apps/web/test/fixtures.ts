// Neutral seed data shared by the API tests. Everything here is synthetic:
// one tracked app, one rival, two keywords, two storefronts.

import { env } from "cloudflare:test";

export const USER_ID = "admin";
export const APP_ID = 424_242;
export const RIVAL_ID = 515_151;
export const KEYWORD_A = "example keyword";
export const KEYWORD_B = "another keyword";

const DAY_MS = 86_400_000;

export function isoDay(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

export function apiRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com/api${path}`, init);
}

// Storage is shared across tests in this pool, so every test starts by
// emptying the tables it might touch. Child rows go first (foreign keys).
const RESETTABLE_TABLES = [
  "keyword_difficulty",
  "rank_entry",
  "ranking",
  "popularity",
  "tracked_keyword",
  "tracked_app",
  "crawl_pair",
  "keyword",
  "review",
  "rating_snapshot",
  "app_localization",
  "suggestion",
  "collector_state",
  "collector_run",
  "fetch_error",
  "asc_report_instance",
  // Children of `app` must go before it: Miniflare's D1 enforces foreign keys.
  "app_metadata_version",
  "app_localization",
  "app_language",
  "app",
  "storefront_locale",
  "storefront",
  "locale",
];

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    RESETTABLE_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`))
  );
}

/** Locales, storefronts and the two apps every other fixture hangs off. */
export async function seedCatalog(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO locale (code, language) VALUES ('en-US', 'en')"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, apple_storefront_id, weight, active) VALUES ('fr', 'France', 143442, 1, 1)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, apple_storefront_id, weight, active) VALUES ('us', 'United States', 143441, 1, 1)"
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO storefront (code, name, apple_storefront_id, weight, active) VALUES ('de', 'Germany', 143443, 1, 0)"
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO app (id, bundle_id, current_name, developer_name, primary_genre_id, first_seen_at, last_seen_at)
       VALUES (?1, 'com.example.tracked', 'Tracked App', 'Example Developer', 6002, 0, 0)`
    ).bind(APP_ID),
    env.DB.prepare(
      `INSERT OR IGNORE INTO app (id, bundle_id, current_name, developer_name, primary_genre_id, first_seen_at, last_seen_at)
       VALUES (?1, 'com.example.rival', 'Rival App', 'Other Developer', 6002, 0, 0)`
    ).bind(RIVAL_ID),
  ]);
}

/** Marks the tracked app as followed by USER_ID. */
export async function seedTrackedApp(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES (?1, ?2, 0)"
  )
    .bind(USER_ID, APP_ID)
    .run();
}

/**
 * Two keywords, three crawl pairs (keyword A in fr + us, keyword B in fr).
 * Pair ids are 1, 2 and 3 in that order.
 */
export async function seedKeywords(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO keyword (id, text, normalized, language) VALUES (1, ?1, ?1, 'fr')"
    ).bind(KEYWORD_A),
    env.DB.prepare(
      "INSERT INTO keyword (id, text, normalized, language) VALUES (2, ?1, ?1, 'fr')"
    ).bind(KEYWORD_B),
    env.DB.prepare(
      `INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
       VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 0)`
    ),
    env.DB.prepare(
      `INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
       VALUES (2, 1, 'us', 'en-US', 1, 1, 0)`
    ),
    env.DB.prepare(
      `INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
       VALUES (3, 2, 'fr', 'fr-FR', 1, 1, 0)`
    ),
    env.DB.prepare(
      "INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 1, 0)"
    ).bind(USER_ID, APP_ID),
    env.DB.prepare(
      "INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 2, 0)"
    ).bind(USER_ID, APP_ID),
  ]);
}

interface RankingSeed {
  id: number;
  pairId: number;
  date: string;
  valid?: number;
  resultCount?: number;
  /** position -> app id */
  entries?: [number, number][];
}

export async function seedRanking(seed: RankingSeed): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
     VALUES (?1, ?2, ?3, 0, 200, ?4, '[]', 'test', ?5)`
  )
    .bind(
      seed.id,
      seed.pairId,
      seed.date,
      seed.resultCount ?? 200,
      seed.valid ?? 1
    )
    .run();
  for (const [position, appId] of seed.entries ?? []) {
    await env.DB.prepare(
      "INSERT INTO rank_entry (ranking_id, position, app_id) VALUES (?1, ?2, ?3)"
    )
      .bind(seed.id, position, appId)
      .run();
  }
}
