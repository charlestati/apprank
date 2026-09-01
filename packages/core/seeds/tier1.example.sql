-- Tier 1 tracking seed — TEMPLATE. Copy to seeds/local/ (gitignored), replace
-- every placeholder, then apply from apps/collector with:
--   npx wrangler d1 execute apprank --remote --file ../../packages/core/seeds/local/<your-file>.sql
--
-- Placeholders:
--   111111111   your app's App Store id (the number in its App Store URL)
--   'xx'        your app's content language ('fr', 'en', ...)
--   user_id     'admin' works until auth is configured; reassign afterwards
--
-- Idempotent: INSERT OR IGNORE throughout; re-running only adds what's missing.
-- Adding a keyword or storefront later is another INSERT, never a migration.

INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at)
VALUES (111111111, 'My App', strftime('%s','now')*1000, strftime('%s','now')*1000);

-- The app's content language drives which storefronts get crawled
-- (storefront set is derived from storefront_locale, seeded in reference.sql).
INSERT OR IGNORE INTO app_language (app_id, language) VALUES (111111111, 'xx');

INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at)
VALUES ('admin', 111111111, strftime('%s','now')*1000);

-- ── Keywords (normalized = lowercase, NFC, trimmed) ──────────────────────────
INSERT OR IGNORE INTO keyword (text, normalized, language) VALUES
  ('my first keyword',  'my first keyword',  'xx'),
  ('my second keyword', 'my second keyword', 'xx');

-- ── User tracking rows ───────────────────────────────────────────────────────
INSERT OR IGNORE INTO tracked_keyword (user_id, app_id, keyword_id, created_at)
SELECT 'admin', 111111111, k.id, strftime('%s','now')*1000
FROM keyword k WHERE k.language = 'xx';

-- ── Crawl pairs: keyword × active storefront × that storefront's matching locale ─
-- next_due_at = now → the backfill starts at the next scheduler tick.
INSERT OR IGNORE INTO crawl_pair (keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at)
SELECT k.id, s.code, MIN(sl.locale_code), 1, 1, 24, strftime('%s','now')*1000
FROM keyword k
CROSS JOIN storefront s
JOIN storefront_locale sl ON sl.storefront_code = s.code
JOIN locale l ON l.code = sl.locale_code AND l.language = k.language
WHERE s.active = 1 AND k.language = 'xx'
GROUP BY k.id, s.code;

-- Keep ref_count truthful for pairs that already existed.
UPDATE crawl_pair SET ref_count = 1 WHERE ref_count = 0 AND keyword_id IN (
  SELECT keyword_id FROM tracked_keyword WHERE user_id = 'admin'
);
