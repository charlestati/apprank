import {
	sqliteTable,
	text,
	integer,
	real,
	primaryKey,
	uniqueIndex,
	index,
} from "drizzle-orm/sqlite-core";

import { app } from "./apps";
import { storefront, locale } from "./reference";

// userId columns are plain text (no FK): the user table is generated and owned
// by Better Auth in a later milestone; the collector must not depend on it.

export const keyword = sqliteTable(
	"keyword",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		language: text("language").notNull(),
		normalized: text("normalized").notNull(), // lowercase, NFC, trimmed
		text: text("text").notNull(),
	},
	(t) => [uniqueIndex("kw_norm").on(t.normalized, t.language)]
);

export const trackedApp = sqliteTable(
	"tracked_app",
	{
		appId: integer("app_id")
			.notNull()
			.references(() => app.id),
		createdAt: integer("created_at").notNull(),
		userId: text("user_id").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.appId] })]
);

// Which storefronts matter is derived from the app's content language,
// not hard-coded per storefront.
export const appLanguage = sqliteTable(
	"app_language",
	{
		appId: integer("app_id").notNull(),
		language: text("language").notNull(),
	},
	(t) => [primaryKey({ columns: [t.appId, t.language] })]
);

export const trackedKeyword = sqliteTable(
	"tracked_keyword",
	{
		appId: integer("app_id")
			.notNull()
			.references(() => app.id),
		createdAt: integer("created_at").notNull(),
		id: integer("id").primaryKey({ autoIncrement: true }),
		keywordId: integer("keyword_id")
			.notNull()
			.references(() => keyword.id),
		userId: text("user_id").notNull(),
	},
	(t) => [uniqueIndex("tk_unique").on(t.userId, t.appId, t.keywordId)]
);

// The crawl unit: reference-counted union of distinct demand.
// N users tracking the same pair = 1 row = 1 fetch/day.
export const crawlPair = sqliteTable(
	"crawl_pair",
	{
		burstUntil: integer("burst_until"), // metadata-change burst window
		id: integer("id").primaryKey({ autoIncrement: true }),
		intervalHours: integer("interval_hours").notNull().default(24),
		keywordId: integer("keyword_id")
			.notNull()
			.references(() => keyword.id),
		lastFetchedAt: integer("last_fetched_at"),
		localeCode: text("locale_code")
			.notNull()
			.references(() => locale.code),
		nextDueAt: integer("next_due_at").notNull(),
		refCount: integer("ref_count").notNull().default(0), // 0 = retired: history kept, scheduling stopped
		storefrontCode: text("storefront_code")
			.notNull()
			.references(() => storefront.code),
		tier: integer("tier").notNull().default(1),
		volatility: real("volatility").notNull().default(0),
	},
	(t) => [
		uniqueIndex("cp_unique").on(t.keywordId, t.storefrontCode, t.localeCode),
		index("cp_due").on(t.nextDueAt),
	]
);
