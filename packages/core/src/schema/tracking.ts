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

// userId columns are plain text with no foreign key. There is no user table:
// identity comes from the BASIC_AUTH_ACCOUNTS secret, so a userId is an opaque
// string the collector must not try to resolve.

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

// What the reader chose, as opposed to what the collector observed.
//
// One key-value table rather than a column per preference, so adding a fourth
// is an INSERT and not a migration, in the spirit of invariant 5. The value is
// text: a scalar for `app` and `language`, JSON for anything with shape.
//
// Keys in use:
//   app                        the app id the switcher last landed on
//   language                   the UI language
//   chart:{appId}:{storefront} the pair ids drawn on the line chart
//
// The scope of the chart key lives in the key because it varies by app and
// storefront while the other two do not, and a nullable scope column on every
// row would encode that at the cost of every read.
//
// Nothing here is foreign-keyed. A retired pair keeps its history, so a stale
// id in a stored selection is expected, and it is dropped on read rather than
// blocking the write.
export const userPreference = sqliteTable(
	"user_preference",
	{
		key: text("key").notNull(),
		updatedAt: integer("updated_at").notNull(),
		userId: text("user_id").notNull(),
		value: text("value").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.key] })]
);
