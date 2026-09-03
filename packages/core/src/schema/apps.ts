import {
	sqliteTable,
	text,
	integer,
	real,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { locale } from "./reference";

// App dimension: normalise, don't truncate. One row per change, not per sighting.

export const app = sqliteTable("app", {
	bundleId: text("bundle_id"),
	currentName: text("current_name"),
	developerId: integer("developer_id"),
	developerName: text("developer_name"),
	firstSeenAt: integer("first_seen_at").notNull(),
	id: integer("id").primaryKey(), // Apple trackId
	lastSeenAt: integer("last_seen_at").notNull(),
	primaryGenreId: integer("primary_genre_id"),
});

export const appMetadataVersion = sqliteTable(
	"app_metadata_version",
	{
		appId: integer("app_id")
			.notNull()
			.references(() => app.id),
		capturedAt: integer("captured_at").notNull(),
		contentHash: text("content_hash").notNull(), // new row only when this differs
		currency: text("currency"),
		descriptionHash: text("description_hash"),
		genreIds: text("genre_ids"), // JSON array
		hasIap: integer("has_iap"),
		iconUrl: text("icon_url"),
		id: integer("id").primaryKey({ autoIncrement: true }),
		price: real("price"),
		ratingAvg: real("rating_avg"),
		ratingCount: integer("rating_count"), // point-in-time copy; series in rating_snapshot
		releaseNotesHash: text("release_notes_hash"),
		screenshotUrlsHash: text("screenshot_urls_hash"),
		source: text("source").notNull(), // 'itunes-search' | 'itunes-lookup'
		subtitle: text("subtitle"),
		title: text("title"),
		version: text("version"),
	},
	(t) => [uniqueIndex("amv_dedupe").on(t.appId, t.contentHash)]
);

// "This app has no localization for this locale" is a first-class state,
// not a missing row.
export const appLocalization = sqliteTable(
	"app_localization",
	{
		appId: integer("app_id")
			.notNull()
			.references(() => app.id),
		capturedAt: integer("captured_at").notNull(),
		contentHash: text("content_hash"),
		id: integer("id").primaryKey({ autoIncrement: true }),
		localeCode: text("locale_code")
			.notNull()
			.references(() => locale.code),
		status: text("status", {
			enum: ["present", "absent", "unknown"],
		}).notNull(),
		subtitle: text("subtitle"),
		title: text("title"),
	},
	(t) => [uniqueIndex("al_dedupe").on(t.appId, t.localeCode, t.contentHash)]
);
