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
