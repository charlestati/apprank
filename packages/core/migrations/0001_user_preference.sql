CREATE TABLE `user_preference` (
	`key` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`)
);
