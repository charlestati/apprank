-- The baseline schema.
--
-- Regenerate with `wrangler d1 export apprank --remote --no-data`, then delete
-- the `PRAGMA` line and the `d1_migrations` table it emits: wrangler creates
-- that table itself, and a migration that also creates it fails on a fresh
-- database.
--
-- Never regenerate from drizzle. It cannot express the partial unique index
-- `cr_unique_storefront_wide`, so `drizzle-kit export` returns fourteen
-- indexes where this file has fifteen, and the storefront-wide chart rows
-- start duplicating.

CREATE TABLE `genre` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer
);
CREATE TABLE `locale` (
	`code` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL
);
CREATE TABLE `storefront` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`apple_storefront_id` integer,
	`weight` real DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
CREATE TABLE `storefront_locale` (
	`storefront_code` text NOT NULL,
	`locale_code` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`storefront_code`, `locale_code`),
	FOREIGN KEY (`storefront_code`) REFERENCES `storefront`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`locale_code`) REFERENCES `locale`(`code`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `app` (
	`id` integer PRIMARY KEY NOT NULL,
	`bundle_id` text,
	`current_name` text,
	`developer_id` integer,
	`developer_name` text,
	`primary_genre_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
CREATE TABLE `app_localization` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`locale_code` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`subtitle` text,
	`captured_at` integer NOT NULL,
	`content_hash` text,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`locale_code`) REFERENCES `locale`(`code`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `app_metadata_version` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`source` text NOT NULL,
	`title` text,
	`subtitle` text,
	`description_hash` text,
	`version` text,
	`price` real,
	`currency` text,
	`has_iap` integer,
	`genre_ids` text,
	`rating_count` integer,
	`rating_avg` real,
	`screenshot_urls_hash` text,
	`icon_url` text,
	`release_notes_hash` text,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `app_language` (
	`app_id` integer NOT NULL,
	`language` text NOT NULL,
	PRIMARY KEY(`app_id`, `language`)
);
CREATE TABLE `crawl_pair` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword_id` integer NOT NULL,
	`storefront_code` text NOT NULL,
	`locale_code` text NOT NULL,
	`tier` integer DEFAULT 1 NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`interval_hours` integer DEFAULT 24 NOT NULL,
	`next_due_at` integer NOT NULL,
	`last_fetched_at` integer,
	`volatility` real DEFAULT 0 NOT NULL,
	`burst_until` integer,
	FOREIGN KEY (`keyword_id`) REFERENCES `keyword`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`storefront_code`) REFERENCES `storefront`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`locale_code`) REFERENCES `locale`(`code`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `keyword` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`normalized` text NOT NULL,
	`language` text NOT NULL
);
CREATE TABLE `tracked_app` (
	`user_id` text NOT NULL,
	`app_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `app_id`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `tracked_keyword` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`app_id` integer NOT NULL,
	`keyword_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`keyword_id`) REFERENCES `keyword`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `chart_ranking` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storefront_code` text NOT NULL,
	`genre_id` integer,
	`chart` text NOT NULL,
	`observed_date` text NOT NULL,
	`result_ids` text NOT NULL,
	`http_status` integer NOT NULL,
	`source` text,
	`r2_key` text
);
CREATE TABLE `popularity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword_id` integer NOT NULL,
	`storefront_code` text NOT NULL,
	`genre_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`present` integer DEFAULT 1 NOT NULL,
	`popularity_1_100` integer,
	`popularity_1_5` integer,
	`rank_in_genre` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`keyword_id`) REFERENCES `keyword`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `rank_entry` (
	`ranking_id` integer NOT NULL,
	`position` integer NOT NULL,
	`app_id` integer NOT NULL,
	PRIMARY KEY(`ranking_id`, `position`),
	FOREIGN KEY (`ranking_id`) REFERENCES `ranking`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `ranking` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pair_id` integer NOT NULL,
	`observed_date` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`http_status` integer NOT NULL,
	`response_ms` integer,
	`result_count` integer,
	`result_ids` text NOT NULL,
	`collector_version` text NOT NULL,
	`r2_key` text,
	`valid` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`pair_id`) REFERENCES `crawl_pair`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `rating_snapshot` (
	`app_id` integer NOT NULL,
	`storefront_code` text NOT NULL,
	`observed_date` text NOT NULL,
	`rating_count` integer,
	`rating_avg` real,
	PRIMARY KEY(`app_id`, `storefront_code`, `observed_date`)
);
CREATE TABLE `review` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`storefront_code` text NOT NULL,
	`rating` integer,
	`title` text,
	`body` text,
	`author` text,
	`app_version` text,
	`reviewed_at` integer,
	`fetched_at` integer NOT NULL
);
CREATE TABLE `rollup_monthly_rank` (
	`pair_id` integer NOT NULL,
	`app_id` integer NOT NULL,
	`month` text NOT NULL,
	`best_rank` integer,
	`avg_rank` real,
	`last_rank` integer,
	`days_observed` integer,
	PRIMARY KEY(`pair_id`, `app_id`, `month`)
);
CREATE TABLE `seed_term` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`storefront_code` text NOT NULL,
	`genre_id` integer NOT NULL,
	`term` text NOT NULL,
	`rank_in_genre` integer,
	`popularity_1_100` integer,
	`label` text DEFAULT 'unknown' NOT NULL,
	`label_confidence` real,
	`matched_app_id` integer
);
CREATE TABLE `asc_report_instance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_type` text NOT NULL,
	`granularity` text NOT NULL,
	`processing_date` text NOT NULL,
	`instance_id` text,
	`r2_key` text,
	`checksum` text,
	`anomaly` text,
	`fetched_at` integer NOT NULL
, `app_id` integer NOT NULL);
CREATE TABLE `collector_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
CREATE TABLE `fetch_error` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fetched_at` integer NOT NULL,
	`endpoint` text NOT NULL,
	`params` text,
	`http_status` integer,
	`response_ms` integer,
	`error_class` text,
	`r2_key` text
, `message` text);
CREATE TABLE `suggestion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
, `user_id` text NOT NULL DEFAULT '');
CREATE TABLE `user_quota` (
	`user_id` text PRIMARY KEY NOT NULL,
	`max_apps` integer,
	`max_keywords` integer,
	`max_storefronts_per_app` integer
);
CREATE TABLE `keyword_difficulty` (
	`pair_id` integer NOT NULL,
	`observed_date` text NOT NULL,
	`score` integer NOT NULL,
	`entrenchment` real NOT NULL,
	`incumbent_strength` real NOT NULL,
	`stability` real NOT NULL,
	`saturation` real NOT NULL,
	`sample_size` integer NOT NULL,
	`formula_version` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`pair_id`, `observed_date`),
	FOREIGN KEY (`pair_id`) REFERENCES `crawl_pair`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `collector_run` (
	`detail` text,
	`finished_at` integer,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`ok` integer,
	`started_at` integer NOT NULL,
	`trigger` text NOT NULL
);
CREATE TABLE `mcp_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`name` text NOT NULL,
	`revoked_at` integer,
	`scopes` text DEFAULT '["read:all"]' NOT NULL,
	`secret_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`window_count` integer DEFAULT 0 NOT NULL,
	`window_start` integer
);
CREATE TABLE `mcp_tool_call` (
	`called_at` integer NOT NULL,
	`credential_id` text NOT NULL,
	`duration_ms` integer,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outcome` text NOT NULL,
	`params` text,
	`row_count` integer,
	`tool` text NOT NULL,
	`user_id` text NOT NULL
);
DELETE FROM sqlite_sequence;
CREATE UNIQUE INDEX `al_dedupe` ON `app_localization` (`app_id`,`locale_code`,`content_hash`);
CREATE UNIQUE INDEX `amv_dedupe` ON `app_metadata_version` (`app_id`,`content_hash`);
CREATE UNIQUE INDEX `cp_unique` ON `crawl_pair` (`keyword_id`,`storefront_code`,`locale_code`);
CREATE INDEX `cp_due` ON `crawl_pair` (`next_due_at`);
CREATE UNIQUE INDEX `kw_norm` ON `keyword` (`normalized`,`language`);
CREATE UNIQUE INDEX `tk_unique` ON `tracked_keyword` (`user_id`,`app_id`,`keyword_id`);
CREATE UNIQUE INDEX `cr_unique` ON `chart_ranking` (`storefront_code`,`genre_id`,`chart`,`observed_date`);
CREATE UNIQUE INDEX `pop_unique` ON `popularity` (`keyword_id`,`storefront_code`,`genre_id`,`week_start`);
CREATE INDEX `re_app` ON `rank_entry` (`app_id`,`ranking_id`);
CREATE UNIQUE INDEX `rk_pair_date` ON `ranking` (`pair_id`,`observed_date`);
CREATE UNIQUE INDEX `st_unique` ON `seed_term` (`month`,`storefront_code`,`genre_id`,`term`);
CREATE INDEX `cr_started` ON `collector_run` (`started_at`);
CREATE UNIQUE INDEX `ari_unique` ON `asc_report_instance` (`app_id`,`report_type`,`granularity`,`processing_date`,`instance_id`);
CREATE UNIQUE INDEX `cr_unique_storefront_wide`
  ON `chart_ranking` (`storefront_code`, `chart`, `observed_date`)
  WHERE `genre_id` IS NULL;
CREATE INDEX `mtc_called` ON `mcp_tool_call` (`called_at`);
