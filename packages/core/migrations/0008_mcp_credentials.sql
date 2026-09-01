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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `mtc_called` ON `mcp_tool_call` (`called_at`);