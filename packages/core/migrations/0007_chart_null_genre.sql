-- chart_ranking: make the storefront-wide chart actually unique per day.
--
-- `cr_unique` covers (storefront_code, genre_id, chart, observed_date), but
-- SQLite treats every NULL as distinct in a UNIQUE index, so the genre-less
-- "whole storefront" charts never matched the writer's ON CONFLICT target and
-- a fresh row was appended on every pull. Six duplicates appeared within two
-- hours of the collector running twice in a day, and alarms are at-least-once,
-- so this was always going to happen — it just needed the job to run more than
-- once.
--
-- A partial unique index gives the NULL case the constraint the others already
-- had, and the writer targets it explicitly with the matching WHERE clause.

DELETE FROM chart_ranking
WHERE genre_id IS NULL
  AND id NOT IN (
    SELECT MAX(id) FROM chart_ranking
    WHERE genre_id IS NULL
    GROUP BY storefront_code, chart, observed_date
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `cr_unique_storefront_wide`
  ON `chart_ranking` (`storefront_code`, `chart`, `observed_date`)
  WHERE `genre_id` IS NULL;
