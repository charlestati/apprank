CREATE TABLE `collector_run` (
	`detail` text,
	`finished_at` integer,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`ok` integer,
	`started_at` integer NOT NULL,
	`trigger` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cr_started` ON `collector_run` (`started_at`);--> statement-breakpoint
ALTER TABLE `fetch_error` ADD `message` text;