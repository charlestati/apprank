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
  ('lb', 'Lebanon',        143497, 0.3, 1),
  ('ma', 'Morocco',        NULL,   0.3, 1),
  ('dz', 'Algeria',        NULL,   0.3, 1),
  ('tn', 'Tunisia',        NULL,   0.3, 1),
  ('sn', 'Senegal',        NULL,   0.2, 1),
  ('ci', 'Côte d''Ivoire', NULL,   0.2, 1),
  ('cm', 'Cameroon',       NULL,   0.2, 1),
  -- Monaco is not an App Store storefront of its own. Apple's localization
  -- table has no MCO row, and neither do Andorra, Liechtenstein or San Marino:
  -- the microstates are absent throughout. A search with country=mc answers
  -- HTTP 200 and an empty result set, which no collector can tell apart from
  -- "ranks nowhere", so leaving it active would bank clean-looking rows that
  -- are all false. Retired rather than deleted, so it is not tried again.
  ('mc', 'Monaco',         NULL,   0.2, 0),
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
  ('es-MX', 'es'),
  ('ca-ES', 'ca'),
  ('ar-SA', 'ar');

-- ── Storefront ↔ indexed locales (Apple cross-localization) ──────────────────
-- Verified 2026-09-02, row for row, against Apple's public "App Store
-- localizations" table (developer.apple.com/help/app-store-connect/reference/
-- app-information/app-store-localizations), which gives each storefront one
-- default language plus the additional indexed ones. No App Store Connect
-- login is needed to read it, so re-check it here rather than guessing.
INSERT OR IGNORE INTO storefront_locale (storefront_code, locale_code, is_default) VALUES
  ('fr', 'fr-FR', 1), ('fr', 'en-GB', 0),
  ('ca', 'en-CA', 1), ('ca', 'fr-CA', 0),
  ('be', 'en-GB', 1), ('be', 'nl-NL', 0), ('be', 'fr-FR', 0),
  ('ch', 'de-DE', 1), ('ch', 'en-GB', 0), ('ch', 'fr-FR', 0), ('ch', 'it', 0),
  ('lu', 'en-GB', 1), ('lu', 'fr-FR', 0), ('lu', 'de-DE', 0),
  ('lb', 'en-GB', 1), ('lb', 'fr-FR', 0), ('lb', 'ar-SA', 0),
  ('ma', 'en-GB', 1), ('ma', 'fr-FR', 0), ('ma', 'ar-SA', 0),
  ('dz', 'en-GB', 1), ('dz', 'fr-FR', 0), ('dz', 'ar-SA', 0),
  ('tn', 'en-GB', 1), ('tn', 'fr-FR', 0), ('tn', 'ar-SA', 0),
  ('sn', 'en-GB', 1), ('sn', 'fr-FR', 0),
  -- Cote d'Ivoire and Cameroon default to French. They are the only two
  -- francophone storefronts here that do, so an English default is wrong.
  ('ci', 'fr-FR', 1), ('ci', 'en-GB', 0),
  ('cm', 'fr-FR', 1), ('cm', 'en-GB', 0),
  -- Monaco is retired above and this pair is inert. It stays only so the row
  -- survives, carrying its reason with it, if anyone reactivates the storefront.
  ('mc', 'en-GB', 1), ('mc', 'fr-FR', 0),
  -- The US indexes Spanish (Mexico), never Spanish (Spain), and Spain itself
  -- indexes Catalan. Both storefronts are inactive, so neither is collected yet.
  ('us', 'en-US', 1), ('us', 'fr-FR', 0), ('us', 'es-MX', 0), ('us', 'ar-SA', 0),
  ('gb', 'en-GB', 1),
  ('de', 'de-DE', 1), ('de', 'en-GB', 0),
  ('it', 'it', 1),    ('it', 'en-GB', 0),
  ('es', 'es-ES', 1), ('es', 'ca-ES', 0), ('es', 'en-GB', 0),
  ('nl', 'nl-NL', 1), ('nl', 'en-GB', 0);

-- ── Genres (iTunes genre ids) ────────────────────────────────────────────────
-- The full App Store tree as Apple publishes it, taken from the live genre
-- endpoint (MZStoreServices .../ws/genres?id=36), not from a blog post. All 27
-- top-level genres are seeded because an operator in any category deploys this:
-- buildAdsTask resolves a tracked app's primary_genre_id through this table, so
-- an unseeded genre yields no rows, no Ads category, and a popularity table
-- that is silently empty rather than visibly unsupported.
--
-- Only Games (18), Magazines & Newspapers (28) and Stickers (15) have
-- sub-genres at all; every other top-level genre has none. The Games children
-- are seeded so a games operator can chart at sub-genre resolution. The other
-- two are an INSERT away if anyone needs them.
--
-- Eleven of these have no Apple Ads category (Weather, Reference, Navigation,
-- Music, Books, Medical, Magazines, Catalogs, Stickers, Developer Tools,
-- Graphics & Design): Ads reports only fifteen. resolveAdsCategory returns null
-- for them, which is recorded rather than guessed.
INSERT OR IGNORE INTO genre (id, name, parent_id) VALUES
  (36,   'App Store', NULL),
  (6000, 'Business',                36),
  (6001, 'Weather',                 36),
  (6002, 'Utilities',               36),
  (6003, 'Travel',                  36),
  (6004, 'Sports',                  36),
  (6005, 'Social Networking',       36),
  (6006, 'Reference',               36),
  (6007, 'Productivity',            36),
  (6008, 'Photo & Video',           36),
  (6009, 'News',                    36),
  (6010, 'Navigation',              36),
  (6011, 'Music',                   36),
  (6012, 'Lifestyle',               36),
  (6013, 'Health & Fitness',        36),
  (6014, 'Games',                   36),
  (6015, 'Finance',                 36),
  (6016, 'Entertainment',           36),
  (6017, 'Education',               36),
  (6018, 'Books',                   36),
  (6020, 'Medical',                 36),
  (6021, 'Magazines & Newspapers',  36),
  (6022, 'Catalogs',                36),
  (6023, 'Food & Drink',            36),
  (6024, 'Shopping',                36),
  (6025, 'Stickers',                36),
  (6026, 'Developer Tools',         36),
  (6027, 'Graphics & Design',       36),
  (7001, 'Games/Action',            6014),
  (7002, 'Games/Adventure',         6014),
  (7003, 'Games/Casual',            6014),
  (7004, 'Games/Board',             6014),
  (7005, 'Games/Card',              6014),
  (7006, 'Games/Casino',            6014),
  (7007, 'Games/Dice',              6014),
  (7008, 'Games/Educational',       6014),
  (7009, 'Games/Family',            6014),
  (7011, 'Games/Music',             6014),
  (7012, 'Games/Puzzle',            6014),
  (7013, 'Games/Racing',            6014),
  (7014, 'Games/Roleplaying',       6014),
  (7015, 'Games/Simulation',        6014),
  (7016, 'Games/Sports',            6014),
  (7017, 'Games/Strategy',          6014),
  (7018, 'Games/Trivia',            6014),
  (7019, 'Games/Word',              6014);

-- 7003 is Casual, not Card (Card is 7005). Seeds written before the tree was
-- checked against Apple carry the wrong name, and INSERT OR IGNORE will not
-- correct an existing row.
UPDATE genre SET name = 'Games/Casual' WHERE id = 7003 AND name = 'Games/Card';
