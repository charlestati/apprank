-- Reference data seed. Idempotent: INSERT OR IGNORE everywhere, so re-running
-- never clobbers user edits (e.g. storefront.weight).
-- Storefronts are data, not code: adding one later is an INSERT, never a migration.

-- ── Storefronts ──────────────────────────────────────────────────────────────
-- apple_storefront_id feeds the X-Apple-Store-Front header on the search-hints
-- endpoint. Values below 143460 are long-published Apple constants; NULL means
-- not yet verified (fill in when the hints collector needs that storefront).
INSERT OR IGNORE INTO storefront (code, name, apple_storefront_id, weight, active) VALUES
  ('fr', 'France',         143442, 1.0, 1),
  ('be', 'Belgium',        143446, 0.6, 1),
  ('ch', 'Switzerland',    143459, 0.6, 1),
  ('ca', 'Canada',         143455, 0.6, 1),
  ('lu', 'Luxembourg',     143451, 0.3, 1),
  ('mc', 'Monaco',         NULL,   0.2, 1),
  ('ma', 'Morocco',        NULL,   0.3, 1),
  ('dz', 'Algeria',        NULL,   0.3, 1),
  ('tn', 'Tunisia',        NULL,   0.3, 1),
  ('sn', 'Senegal',        NULL,   0.2, 1),
  ('ci', 'Côte d''Ivoire', NULL,   0.2, 1),
  ('cm', 'Cameroon',       NULL,   0.2, 1),
  -- Inactive but pre-seeded for Tier 2 sweeps / a future English localization.
  ('us', 'United States',  143441, 1.0, 0),
  ('gb', 'United Kingdom', 143444, 0.8, 0),
  ('de', 'Germany',        143443, 0.5, 0),
  ('it', 'Italy',          143450, 0.4, 0),
  ('es', 'Spain',          143454, 0.4, 0),
  ('nl', 'Netherlands',    143452, 0.4, 0);

-- ── Locales (App Store Connect localization codes) ───────────────────────────
INSERT OR IGNORE INTO locale (code, language) VALUES
  ('fr-FR', 'fr'),
  ('fr-CA', 'fr'),
  ('en-US', 'en'),
  ('en-GB', 'en'),
  ('en-CA', 'en'),
  ('en-AU', 'en'),
  ('de-DE', 'de'),
  ('it',    'it'),
  ('nl-NL', 'nl'),
  ('es-ES', 'es'),
  ('ar-SA', 'ar');

-- ── Storefront ↔ indexed locales (Apple cross-localization) ──────────────────
-- Verified 2026-08-31 against Apple's ASC "App Store localizations" table:
--   FR = French (default) + English (U.K.)
--   CA = English (Canada) default + French (Canada)
--   BE = English (U.K.) default + Dutch + French
--   CH = German default + English (U.K.) + French + Italian
-- Rows marked TODO are best-guess pending verification against the same table.
INSERT OR IGNORE INTO storefront_locale (storefront_code, locale_code, is_default) VALUES
  ('fr', 'fr-FR', 1), ('fr', 'en-GB', 0),
  ('ca', 'en-CA', 1), ('ca', 'fr-CA', 0),
  ('be', 'en-GB', 1), ('be', 'nl-NL', 0), ('be', 'fr-FR', 0),
  ('ch', 'de-DE', 1), ('ch', 'en-GB', 0), ('ch', 'fr-FR', 0), ('ch', 'it', 0),
  -- TODO verify:
  ('lu', 'en-GB', 1), ('lu', 'fr-FR', 0), ('lu', 'de-DE', 0),
  ('mc', 'en-GB', 1), ('mc', 'fr-FR', 0),
  ('ma', 'en-GB', 1), ('ma', 'fr-FR', 0), ('ma', 'ar-SA', 0),
  ('dz', 'en-GB', 1), ('dz', 'fr-FR', 0), ('dz', 'ar-SA', 0),
  ('tn', 'en-GB', 1), ('tn', 'fr-FR', 0), ('tn', 'ar-SA', 0),
  ('sn', 'en-GB', 1), ('sn', 'fr-FR', 0),
  ('ci', 'en-GB', 1), ('ci', 'fr-FR', 0),
  ('cm', 'en-GB', 1), ('cm', 'fr-FR', 0),
  ('us', 'en-US', 1), ('us', 'fr-FR', 0), ('us', 'es-ES', 0), ('us', 'ar-SA', 0),
  ('gb', 'en-GB', 1),
  ('de', 'de-DE', 1), ('de', 'en-GB', 0),
  ('it', 'it', 1),    ('it', 'en-GB', 0),
  ('es', 'es-ES', 1), ('es', 'en-GB', 0),
  ('nl', 'nl-NL', 1), ('nl', 'en-GB', 0);

-- ── Genres (iTunes genre ids) ────────────────────────────────────────────────
INSERT OR IGNORE INTO genre (id, name, parent_id) VALUES
  (36,   'App Store',   NULL),
  (6014, 'Games',       36),
  (7019, 'Games/Word',        6014),
  (7012, 'Games/Puzzle',      6014),
  (7004, 'Games/Board',       6014),
  (7018, 'Games/Trivia',      6014),
  (7008, 'Games/Educational', 6014),
  (7003, 'Games/Card',        6014),
  (7002, 'Games/Adventure',   6014),
  (7017, 'Games/Strategy',    6014),
  (7001, 'Games/Action',      6014),
  (7015, 'Games/Simulation',  6014),
  (6017, 'Education',    36),
  (6016, 'Entertainment',36),
  (6007, 'Productivity', 36),
  (6002, 'Utilities',    36);
