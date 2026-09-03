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
import { keyword, crawlPair } from "./tracking";

// Every observation carries provenance: this is what later distinguishes
// "we were rate-limited" from "the app genuinely wasn't ranking".

export const ranking = sqliteTable(
	"ranking",
	{
		collectorVersion: text("collector_version").notNull(),
		fetchedAt: integer("fetched_at").notNull(),
		httpStatus: integer("http_status").notNull(),
		id: integer("id").primaryKey({ autoIncrement: true }),
		observedDate: text("observed_date").notNull(), // 'YYYY-MM-DD', the idempotency grain
		pairId: integer("pair_id")
			.notNull()
			.references(() => crawlPair.id),
		r2Key: text("r2_key"),
		responseMs: integer("response_ms"),
		resultCount: integer("result_count"),
		resultIds: text("result_ids").notNull(), // JSON ordered array of up to 200 track IDs
		valid: integer("valid").notNull().default(1), // canary/gate verdict; suspect rows render as gaps
	},
	(t) => [uniqueIndex("rk_pair_date").on(t.pairId, t.observedDate)]
);

// Indexed rows for the top-10 + every tracked app found (the "11 rows").
export const rankEntry = sqliteTable(
	"rank_entry",
	{
		appId: integer("app_id")
			.notNull()
			.references(() => app.id),
		position: integer("position").notNull(),
		rankingId: integer("ranking_id")
			.notNull()
			.references(() => ranking.id),
	},
	(t) => [
		primaryKey({ columns: [t.rankingId, t.position] }),
		index("re_app").on(t.appId, t.rankingId),
	]
);

// Apple Ads search-term popularity, WEEKLY granularity.
export const popularity = sqliteTable(
	"popularity",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		keywordId: integer("keyword_id")
			.notNull()
			.references(() => keyword.id),
		storefrontCode: text("storefront_code").notNull(),
		genreId: integer("genre_id").notNull(),
		weekStart: text("week_start").notNull(),
		// 0 = queried but absent from Apple's ranked list: "no data" is distinct
		// from "low".
		present: integer("present").notNull().default(1),
		popularity1_100: integer("popularity_1_100"),
		popularity1_5: integer("popularity_1_5"),
		rankInGenre: integer("rank_in_genre"),
		fetchedAt: integer("fetched_at").notNull(),
	},
	(t) => [
		uniqueIndex("pop_unique").on(
			t.keywordId,
			t.storefrontCode,
			t.genreId,
			t.weekStart
		),
	]
);

export const ratingSnapshot = sqliteTable(
	"rating_snapshot",
	{
		appId: integer("app_id").notNull(),
		observedDate: text("observed_date").notNull(),
		ratingAvg: real("rating_avg"),
		ratingCount: integer("rating_count"),
		storefrontCode: text("storefront_code").notNull(),
	},
	(t) => [primaryKey({ columns: [t.appId, t.storefrontCode, t.observedDate] })]
);

export const review = sqliteTable("review", {
	appId: integer("app_id").notNull(),
	appVersion: text("app_version"),
	author: text("author"),
	body: text("body"),
	fetchedAt: integer("fetched_at").notNull(),
	id: text("id").primaryKey(), // Apple review id, natural idempotency
	rating: integer("rating"),
	reviewedAt: integer("reviewed_at"),
	storefrontCode: text("storefront_code").notNull(),
	title: text("title"),
});

export const chartRanking = sqliteTable(
	"chart_ranking",
	{
		chart: text("chart", { enum: ["free", "paid", "grossing"] }).notNull(),
		genreId: integer("genre_id"),
		httpStatus: integer("http_status").notNull(),
		id: integer("id").primaryKey({ autoIncrement: true }),
		observedDate: text("observed_date").notNull(),
		r2Key: text("r2_key"),
		resultIds: text("result_ids").notNull(),
		source: text("source"), // 'itunes-rss' | 'marketingtools-v2': which endpoint served it
		storefrontCode: text("storefront_code").notNull(),
	},
	(t) => [
		// NOTE: a second, partial unique index exists in migration 0000_init.sql
		// covering the genre_id IS NULL rows. Drizzle cannot express a partial
		// index, so it lives in SQL only. Do not "restore" this file from a fresh
		// generate without re-adding it, or the storefront-wide charts silently
		// start duplicating again.
		uniqueIndex("cr_unique").on(
			t.storefrontCode,
			t.genreId,
			t.chart,
			t.observedDate
		),
	]
);

// Tier 2 monthly seed list + entering/leaving diff signal + brand label.
export const seedTerm = sqliteTable(
	"seed_term",
	{
		genreId: integer("genre_id").notNull(),
		id: integer("id").primaryKey({ autoIncrement: true }),
		label: text("label", { enum: ["brand", "generic", "unknown"] })
			.notNull()
			.default("unknown"),
		labelConfidence: real("label_confidence"),
		matchedAppId: integer("matched_app_id"),
		month: text("month").notNull(),
		popularity1_100: integer("popularity_1_100"),
		rankInGenre: integer("rank_in_genre"),
		storefrontCode: text("storefront_code").notNull(),
		term: text("term").notNull(),
	},
	(t) => [
		uniqueIndex("st_unique").on(t.month, t.storefrontCode, t.genreId, t.term),
	]
);

// Powers >12-month charts after the D1 hot-window prune (R2 keeps everything).
export const rollupMonthlyRank = sqliteTable(
	"rollup_monthly_rank",
	{
		appId: integer("app_id").notNull(),
		avgRank: real("avg_rank"),
		bestRank: integer("best_rank"),
		daysObserved: integer("days_observed"),
		lastRank: integer("last_rank"),
		month: text("month").notNull(),
		pairId: integer("pair_id").notNull(),
	},
	(t) => [primaryKey({ columns: [t.pairId, t.appId, t.month] })]
);

/**
 * Keyword difficulty, recomputed daily from observations we already hold.
 *
 * The score is deliberately not a black box: every input is stored beside it,
 * so the formula can be revised and the whole history recomputed from the
 * archive rather than being stuck with whatever we shipped first.
 */
export const keywordDifficulty = sqliteTable(
	"keyword_difficulty",
	{
		pairId: integer("pair_id")
			.notNull()
			.references(() => crawlPair.id),
		observedDate: text("observed_date").notNull(),
		/** 0–100, higher is harder to rank for. */
		score: integer("score").notNull(),
		/** Rating mass of the top 3: how entrenched the leaders are. */
		entrenchment: real("entrenchment").notNull(),
		/** Rating mass of the whole top 10. */
		incumbentStrength: real("incumbent_strength").notNull(),
		/** 1 = the same ten apps every day; lower = the board keeps turning over. */
		stability: real("stability").notNull(),
		/** How full the result set is, relative to the 200 Apple returns. */
		saturation: real("saturation").notNull(),
		/** How many of the top ten we hold rating counts for (score confidence). */
		sampleSize: integer("sample_size").notNull(),
		formulaVersion: text("formula_version").notNull(),
		computedAt: integer("computed_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.pairId, t.observedDate] })]
);
