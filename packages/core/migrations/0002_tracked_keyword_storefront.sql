CREATE TABLE `tracked_keyword_storefront` (
	`created_at` integer NOT NULL,
	`locale_code` text NOT NULL,
	`storefront_code` text NOT NULL,
	`tracked_keyword_id` integer NOT NULL,
	PRIMARY KEY(`tracked_keyword_id`, `storefront_code`),
	FOREIGN KEY (`locale_code`) REFERENCES `locale`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`storefront_code`) REFERENCES `storefront`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tracked_keyword_id`) REFERENCES `tracked_keyword`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill from the pairs being collected today. Before this table the database
-- never recorded which storefronts a user chose, so the active pairs of each
-- tracked keyword are the only evidence there is. That is exact while no two
-- tracks share a keyword (true when this landed: one operator, no shared
-- keyword). Where one did, both users would inherit the union of their
-- storefronts and should correct it with `pnpm track --prune`.
INSERT OR IGNORE INTO `tracked_keyword_storefront` (`tracked_keyword_id`, `storefront_code`, `locale_code`, `created_at`)
SELECT tk.id, cp.storefront_code, cp.locale_code, tk.created_at
  FROM tracked_keyword tk
  JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id AND cp.ref_count > 0;
