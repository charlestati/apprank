-- ASC report instances are recorded per app.
--
-- The collector already fans out over `tracked_app` and creates one report
-- request per app, so the app is known at write time — it was simply dropped
-- on insert. Without it both anomaly detectors answer for the union of tracked
-- apps: one app's report hides another app's missing processing date, and a
-- second app's legitimate report is flagged as the first app's duplicate.
-- It also left first-party analytics with no column for an ownership check.
--
-- `NOT NULL` is deliberate. SQLite accepts this ALTER on an empty table and
-- rejects it on a populated one, which is the outcome we want: rows written
-- before this migration cannot be attributed to an app after the fact, and
-- neither can their archive keys, so there is nothing to back-fill from. If
-- this migration fails, the database holds unattributable ASC bookkeeping —
-- delete those rows deliberately, re-run, and let the collector re-ingest from
-- App Store Connect.
DROP INDEX `ari_unique`;--> statement-breakpoint
ALTER TABLE `asc_report_instance` ADD `app_id` integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `ari_unique` ON `asc_report_instance` (`app_id`,`report_type`,`granularity`,`processing_date`,`instance_id`);
