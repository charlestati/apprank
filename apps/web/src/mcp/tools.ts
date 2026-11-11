// The MCP tool surface.
//
// Every tool is intent-shaped: there is deliberately no `run_sql`, no query
// builder and no passthrough, because a tool that accepts arbitrary SQL
// re-opens every boundary the rest of this file exists to hold: ownership, row
// caps, and the provenance that stops a throttled week reading as a
// ranking collapse.
//
// Three rules hold across all of them:
//
//   1. Ownership is checked here, by the same `ownsApp`/`ownsPair` the HTTP
//      routes call. A resource the caller does not track answers "no such"
//      rather than "forbidden".
// 2. Row caps are enforced, never trusted. The requested limit is clamped and
//      the query asks for one row past the cap, so truncation is a fact the
//      answer reports rather than a silence.
//   3. Aggregates are the default. A year of daily ranks across 150 pairs is
// tens of thousands of rows; `detail` opts into the raw ones, still capped.

import { ownsApp, ownsPair } from "../access";
import type { Env } from "../env";
import { DIFFICULTY_BLOCKED, POPULARITY_MEASURABLE } from "../insights";
import {
	TRACKED_PAIRS,
	appLocalizations,
	appRatings,
	appReviews,
	currentRankings,
	listApps,
	storefrontsByApp,
} from "../queries/apps";
import { chartMovement } from "../queries/charts";
import { isoDay, pairCoverage, pairsCoverage } from "../queries/coverage";
import type { Coverage } from "../queries/coverage";
import { dataHealth } from "../queries/health";
import { metadataChanges } from "../queries/metadata";
import { popularityHistory } from "../queries/popularity";
import {
	pairCompetitors,
	pairHistory,
	pairResultPage,
	trackedAppsForPair,
} from "../queries/rankings";
import { buildReport } from "../report";
import type { KeywordRow } from "../report";
import { InvalidArgumentsError, NotFoundError } from "./logging";
import type { ToolContext, ToolOutcome } from "./logging";

/** Hard ceilings. A tool clamps to these; it never takes the caller's word. */
export const CAPS = {
	chartMoves: 200,
	competitors: 400,
	history: 400,
	keywords: 300,
	metadata: 100,
	opportunities: 100,
	popularity: 200,
	ratings: 400,
	reports: 200,
	results: 200,
	reviews: 100,
} as const;

export function clamp(requested: number | undefined, cap: number): number {
	return Math.min(Math.max(Math.trunc(requested ?? cap), 1), cap);
}

/** Take at most `cap` rows and say whether more existed. */
function capped<T>(rows: T[], cap: number) {
	return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

async function requireApp(ctx: ToolContext, appId: number): Promise<void> {
	if (!(await ownsApp(ctx.db, ctx.principal.userId, appId))) {
		// Identical whether the app is absent or another operator's.
		throw new NotFoundError(
			`No tracked app with id ${appId}. Call list_tracked_apps for the ids you can read.`
		);
	}
}

async function requirePair(ctx: ToolContext, pairId: number): Promise<void> {
	if (!(await ownsPair(ctx.db, ctx.principal.userId, pairId))) {
		throw new NotFoundError(
			`No tracked keyword behind pair ${pairId}. Call get_current_rankings for the pair ids you can read.`
		);
	}
}

/** Resolve a keyword + storefront to the crawl pair the caller tracks. */
async function resolvePair(
	ctx: ToolContext,
	keyword: string,
	storefront: string
): Promise<number> {
	const row = await ctx.db
		.prepare(
			`SELECT cp.id
       FROM tracked_keyword tk
       JOIN keyword k ON k.id = tk.keyword_id
       ${TRACKED_PAIRS}
         AND cp.storefront_code = ?2
       WHERE tk.user_id = ?3 AND k.normalized = ?1
       ORDER BY cp.ref_count DESC LIMIT 1`
		)
		.bind(keyword.toLowerCase().trim(), storefront, ctx.principal.userId)
		.first<{ id: number }>();
	if (!row) {
		throw new NotFoundError(
			`You do not track "${keyword}" in storefront "${storefront}".`
		);
	}
	return row.id;
}

interface Window {
	from: string;
	to: string;
}

/** Default window when the caller names neither end. */
function window(from?: string, to?: string, fallbackDays = 30): Window {
	return { from: from ?? isoDay(fallbackDays), to: to ?? isoDay(0) };
}

// ---------------------------------------------------------------------------
// Series summarisation
// ---------------------------------------------------------------------------

export interface SeriesSummary {
	latest: number | null;
	best: number | null;
	worst: number | null;
	mean: number | null;
	median: number | null;
	observations: number;
	/** Days the rank changed by more than a shuffle, newest last. */
	inflections: { date: string; from: number; to: number; delta: number }[];
	/** Evenly spaced points, so a long window still plots. */
	sampled: { date: string; position: number | null }[];
}

const SAMPLE_POINTS = 30;
/** Below this, a day-to-day move is Apple reshuffling, not a rank change. */
const INFLECTION_THRESHOLD = 3;

export function summariseSeries(
	points: { date: string; position: number | null }[]
): SeriesSummary {
	const ranked = points.filter(
		(p): p is { date: string; position: number } => p.position !== null
	);
	const values = ranked.map((p) => p.position).toSorted((a, b) => a - b);

	const inflections: SeriesSummary["inflections"] = [];
	for (let i = 1; i < ranked.length; i += 1) {
		const previous = ranked[i - 1] as { date: string; position: number };
		const current = ranked[i] as { date: string; position: number };
		const delta = previous.position - current.position;
		if (Math.abs(delta) >= INFLECTION_THRESHOLD) {
			inflections.push({
				date: current.date,
				delta,
				from: previous.position,
				to: current.position,
			});
		}
	}

	const step = Math.max(1, Math.ceil(points.length / SAMPLE_POINTS));
	return {
		best: values[0] ?? null,
		inflections,
		// The newest observation's, ranked or not: a newer day outside the top
		// 200 means the older rank is no longer the app's.
		latest: points.at(-1)?.position ?? null,
		mean:
			values.length === 0
				? null
				: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
		median:
			values.length === 0
				? null
				: (values[Math.floor(values.length / 2)] as number),
		observations: ranked.length,
		sampled: points.filter((_, i) => i % step === 0 || i === points.length - 1),
		worst: values.at(-1) ?? null,
	};
}

// ---------------------------------------------------------------------------
// Tool bodies
// ---------------------------------------------------------------------------

/**
 * Deliberately carries no scope requirement and reads no data.
 *
 * It describes the credential the caller is already holding, which tells them
 * nothing they did not bring with them, and a credential with no usable scope
 * must still be able to find that out. Naming the tracked apps here would make
 * it a data tool; that list belongs to `list_tracked_apps`, behind a scope.
 */
// oxlint-disable-next-line require-await -- the tool signature is async
export async function whoami(
	_args: unknown,
	ctx: ToolContext
): Promise<ToolOutcome> {
	const p = ctx.principal;
	return {
		data: {
			callsRemainingToday: p.callsRemainingToday,
			credentialName: p.name,
			expiresAt: p.expiresAt,
			scopes: p.scopes,
			userId: p.userId,
		},
		rowCount: 0,
	};
}

export async function listTrackedApps(
	_args: unknown,
	ctx: ToolContext
): Promise<ToolOutcome> {
	const [apps, storefronts] = await Promise.all([
		listApps(ctx.db, ctx.principal.userId),
		storefrontsByApp(ctx.db, ctx.principal.userId),
	]);
	const withStorefronts = apps.results.map((a) => ({
		appId: a.id,
		developer: a.developer_name,
		name: a.current_name,
		primaryGenreId: a.primary_genre_id,
		storefronts: storefronts.get(a.id) ?? [],
	}));
	return { data: { apps: withStorefronts }, rowCount: withStorefronts.length };
}

interface ReportArgs {
	appId: number;
	storefront: string;
	from?: string;
	to?: string;
	detail?: "summary" | "rows";
	limit?: number;
}

/** The widest window the report reads, in days, both ends included. */
const REPORT_MAX_DAYS = 400;

/**
 * Days in a window, both ends included, or a refusal the caller can act on.
 *
 * A window the report cannot serve is said to be one. Clamping it silently
 * answered a different question under the dates that were asked, and every
 * keyword in the unread stretch came back as never observed.
 */
function reportDays(w: Window): number {
	const days = Math.round((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000);
	if (!Number.isFinite(days)) {
		throw new InvalidArgumentsError(
			`"${w.from}" to "${w.to}" is not a pair of calendar dates.`
		);
	}
	if (days < 0) {
		throw new InvalidArgumentsError(
			`The window ends (${w.to}) before it starts (${w.from}).`
		);
	}
	if (days + 1 > REPORT_MAX_DAYS) {
		throw new InvalidArgumentsError(
			`The window spans ${days + 1} days; the report reads at most ${REPORT_MAX_DAYS}. Narrow it, or call get_rank_history per keyword.`
		);
	}
	return days + 1;
}

/**
 * How far popularity coverage actually goes, for a caller that cannot see the
 * table. Silence has two causes and they do not license the same reasoning:
 * absent is Apple's answer, unqueried is ours.
 */
function popularityNote(
	absent: number,
	unqueried: number,
	total: number
): string | null {
	const parts: string[] = [];
	if (absent > 0) {
		parts.push(
			`Apple published no volume for ${absent} of ${total} tracked keywords when asked. Absent volume is not zero volume, and lane counts over those keywords are a thin read.`
		);
	}
	if (unqueried > 0) {
		parts.push(
			`${unqueried} of ${total} have not been through a popularity pull yet, so their volume is unknown rather than absent.`
		);
	}
	return parts.length > 0 ? parts.join(" ") : null;
}

function rowSummary(r: KeywordRow) {
	return {
		best: r.best,
		change: r.change,
		changeDaysAgo: r.changeDaysAgo,
		difficulty: r.difficulty?.score ?? null,
		heldDays: r.heldDays,
		isBrand: r.brand ?? false,
		keyword: r.keyword,
		lastObserved: r.points.at(-1)?.date ?? null,
		// Zero is its own answer: a null position on a row with no observation
		// is not "outside the top 200", it is "nobody looked".
		observations: r.points.length,
		pairId: r.pairId,
		popularity: r.popularity,
		popularityStatus: r.popularityStatus,
		position: r.position,
		reason: r.verdict?.reason ?? null,
		reasonKey: r.verdict?.reasonKey ?? null,
		resultCount: r.resultCount,
		unproven: r.verdict?.unproven ?? false,
		verdict: r.verdict?.opportunity ?? null,
		worst: r.worst,
	};
}

export async function getKeywordReport(
	args: ReportArgs,
	ctx: ToolContext,
	env: Env
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const w = window(args.from, args.to);
	const report = await buildReport(env, {
		appId: args.appId,
		days: reportDays(w),
		from: w.from,
		storefront: args.storefront,
		to: w.to,
		userId: ctx.principal.userId,
	});
	const limit = clamp(args.limit, CAPS.reports);
	const { rows, truncated } = capped(report.rows, limit);

	return {
		data: {
			dates: {
				first: report.dates[0] ?? null,
				last: report.dates.at(-1) ?? null,
			},
			insights: report.insights,
			metadataChanges: report.metadataChanges,
			provenance: {
				// Two counts, never one. "Apple had nothing" and "we never asked"
				// both leave the volume unknown, but only the first is a fact about
				// the market, and a note that merged them reported our own coverage
				// gap as Apple's answer.
				note: popularityNote(
					report.insights.unmeasuredKeywords,
					report.insights.unqueriedKeywords,
					report.rows.length
				),
				observedDates: report.dates.length,
				requested: w,
				truncated,
				unobservedKeywords: report.insights.unobserved,
			},
			rows: rows.map((r) =>
				args.detail === "rows"
					? { ...rowSummary(r), points: r.points, topResults: r.topResults }
					: rowSummary(r)
			),
			stats: report.stats,
			storefront: report.storefront,
		},
		rowCount: rows.length,
	};
}

interface HistoryArgs {
	pairId?: number | undefined;
	keyword?: string | undefined;
	storefront?: string | undefined;
	appId?: number | undefined;
	from?: string | undefined;
	to?: string | undefined;
	detail?: "summary" | "daily" | undefined;
	limit?: number | undefined;
}

async function pairFromArgs(
	ctx: ToolContext,
	args: Pick<HistoryArgs, "pairId" | "keyword" | "storefront">
): Promise<number> {
	if (args.pairId !== undefined) {
		await requirePair(ctx, args.pairId);
		return args.pairId;
	}
	if (args.keyword && args.storefront) {
		return resolvePair(ctx, args.keyword, args.storefront);
	}
	throw new NotFoundError(
		"Give either pairId, or both keyword and storefront."
	);
}

/**
 * The app whose rank a pair's history is about, when the caller named none.
 *
 * Without one, the history query returns every app Apple listed on each day,
 * so "the tracked app's own rank" summarised two hundred competitors at once.
 * An operator may track the same keyword for several apps, and then there is
 * no single answer to guess.
 */
async function trackedAppForPair(
	ctx: ToolContext,
	pairId: number
): Promise<number> {
	const apps = await trackedAppsForPair(ctx.db, ctx.principal.userId, pairId);
	const [only, ...others] = apps;
	if (only !== undefined && others.length === 0) {
		return only;
	}
	throw new NotFoundError(
		only === undefined
			? `No tracked keyword behind pair ${pairId}. Call get_current_rankings for the pair ids you can read.`
			: `You track pair ${pairId} for apps ${apps.join(", ")}. Pass appId to say whose rank you want.`
	);
}

export async function getRankHistory(
	args: HistoryArgs,
	ctx: ToolContext
): Promise<ToolOutcome> {
	const pairId = await pairFromArgs(ctx, args);
	const w = window(args.from, args.to, 90);
	const limit = clamp(args.limit, CAPS.history);
	const appId = args.appId ?? (await trackedAppForPair(ctx, pairId));

	const [rows, coverage] = await Promise.all([
		pairHistory(ctx.db, pairId, w.from, appId),
		pairCoverage(ctx.db, pairId, w.from, w.to),
	]);
	const points = (
		rows.results as { observed_date: string; position: number | null }[]
	)
		.filter((r) => r.observed_date <= w.to)
		.map((r) => ({ date: r.observed_date, position: r.position }));
	const { rows: limited, truncated } = capped(points, limit);

	return {
		data: {
			detail: args.detail ?? "summary",
			pairId,
			points: args.detail === "daily" ? limited : undefined,
			provenance: { ...coverage, truncated },
			summary: args.detail === "daily" ? undefined : summariseSeries(points),
		},
		rowCount: args.detail === "daily" ? limited.length : points.length,
	};
}

export async function getCurrentRankings(
	args: {
		appId: number;
		storefront?: string | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const limit = clamp(args.limit, CAPS.keywords);
	const result = await currentRankings(ctx.db, {
		appId: args.appId,
		limit,
		storefront: args.storefront ?? null,
		userId: ctx.principal.userId,
	});

	const today = isoDay(0);
	const { rows, truncated } = capped(result.results, limit);
	return {
		data: {
			provenance: {
				note: "position null with an observedDate means the app was observed outside Apple's top 200 on that date, not that the fetch failed. position null with a null observedDate means no valid observation in the last 90 days, which says nothing about the rank. staleDays counts days since the last valid observation; a pair on a stretched cadence is expected to be several days old.",
				truncated,
			},
			rankings: rows.map((r) => ({
				cadenceHours: r.interval_hours,
				keyword: r.keyword,
				locale: r.locale_code,
				observedDate: r.observed_date,
				pairId: r.pair_id,
				position: r.position,
				staleDays: r.observed_date
					? Math.round(
							(Date.parse(today) - Date.parse(r.observed_date)) / 86_400_000
						)
					: null,
				storefront: r.storefront_code,
			})),
		},
		rowCount: rows.length,
	};
}

export async function getCompetitors(
	args: HistoryArgs,
	ctx: ToolContext
): Promise<ToolOutcome> {
	const pairId = await pairFromArgs(ctx, args);
	const w = window(args.from, args.to);
	const limit = clamp(args.limit, CAPS.competitors);

	const [rows, coverage] = await Promise.all([
		pairCompetitors(ctx.db, pairId, w.from),
		pairCoverage(ctx.db, pairId, w.from, w.to),
	]);
	const entries = (
		rows.results as {
			observed_date: string;
			position: number;
			app_id: number;
			current_name: string | null;
		}[]
	).filter((r) => r.observed_date <= w.to);

	if (args.detail === "daily") {
		const { rows: limited, truncated } = capped(entries, limit);
		return {
			data: {
				pairId,
				provenance: { ...coverage, truncated },
				timeline: limited,
			},
			rowCount: limited.length,
		};
	}

	const dates = [...new Set(entries.map((e) => e.observed_date))].toSorted();
	const [first] = dates;
	const last = dates.at(-1);
	const byApp = new Map<
		number,
		{ name: string | null; positions: number[]; days: Set<string> }
	>();
	for (const e of entries) {
		const found = byApp.get(e.app_id) ?? {
			days: new Set<string>(),
			name: e.current_name,
			positions: [],
		};
		found.positions.push(e.position);
		found.days.add(e.observed_date);
		byApp.set(e.app_id, found);
	}

	const incumbents = [...byApp.entries()]
		.map(([appId, v]) => {
			const sorted = v.positions.toSorted((a, b) => a - b);
			return {
				appId,
				bestPosition: sorted[0] ?? null,
				daysInTopTen: v.days.size,
				entered: first !== undefined && !v.days.has(first),
				exited: last !== undefined && !v.days.has(last),
				medianPosition: sorted[Math.floor(sorted.length / 2)] ?? null,
				name: v.name,
			};
		})
		.toSorted((a, b) => b.daysInTopTen - a.daysInTopTen);

	return {
		data: {
			churn: incumbents.filter((i) => i.entered || i.exited).length,
			incumbents,
			pairId,
			provenance: coverage,
		},
		rowCount: incumbents.length,
	};
}

export async function getChartMovement(
	args: {
		storefront: string;
		chart: "free" | "paid" | "grossing";
		genreId?: number | undefined;
		from?: string | undefined;
		to?: string | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	const w = window(args.from, args.to);
	const limit = clamp(args.limit, CAPS.chartMoves);
	const result = await chartMovement(ctx.db, {
		chart: args.chart,
		from: w.from,
		genreId: args.genreId ?? null,
		storefront: args.storefront,
		to: w.to,
	});
	const { rows, truncated } = capped(result.moves, limit);
	return {
		data: {
			...result,
			moves: rows,
			provenance: {
				note:
					result.observationCount < 2
						? "Fewer than two observations in this window, so no movement can be computed. Top charts are collected daily; a short window or a throttled day leaves nothing to compare."
						: `Compared ${result.firstDate} against ${result.lastDate} across ${result.observationCount} observations. Endpoint(s): ${result.sources.join(", ") || "unknown"}.`,
				requested: w,
				truncated,
			},
		},
		rowCount: rows.length,
	};
}

export async function getKeywordPopularity(
	args: {
		appId: number;
		storefront: string;
		keyword?: string | undefined;
		from?: string | undefined;
		to?: string | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const w = window(args.from, args.to, 180);
	const limit = clamp(args.limit, CAPS.popularity);
	const series = await popularityHistory(
		ctx.db,
		ctx.principal.userId,
		args.appId,
		args.storefront,
		w.from,
		w.to,
		args.keyword
	);
	const { rows, truncated } = capped(series, limit);
	const unmeasured = rows.filter((s) => !s.everMeasured).length;

	return {
		data: {
			keywords: rows,
			provenance: {
				note: `Apple Ads publishes popularity weekly and covers only about the top 500 terms per storefront and top-level genre. ${unmeasured} of ${rows.length} keywords here have no published volume in this window. That is absence of data, never a measurement of zero demand.`,
				requested: w,
				storefront: args.storefront,
				truncated,
				unmeasuredKeywords: unmeasured,
			},
		},
		rowCount: rows.length,
	};
}

export async function getMetadataChanges(
	args: {
		appId: number;
		from?: string | undefined;
		to?: string | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const w = window(args.from, args.to, 180);
	const limit = clamp(args.limit, CAPS.metadata);
	const [changes, localizations] = await Promise.all([
		metadataChanges(ctx.db, args.appId, w.from, w.to, limit),
		appLocalizations(ctx.db, args.appId),
	]);
	return {
		data: {
			changes,
			localizations: localizations.results,
			provenance: {
				note: "One row per detected change, not per sighting: the collector stores a new version only when the content hash differs. A rank move is only interpretable against the release that might have caused it.",
				requested: w,
			},
		},
		rowCount: changes.length,
	};
}

export async function findKeywordOpportunities(
	args: {
		appId: number;
		storefront: string;
		lane?: "winning" | "close" | "blocked" | "vanity" | "dormant" | "unknown";
		minPopularity?: number;
		maxDifficulty?: number;
		includeBrand?: boolean;
		limit?: number;
	},
	ctx: ToolContext,
	env: Env
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const report = await buildReport(env, {
		appId: args.appId,
		days: 30,
		storefront: args.storefront,
		userId: ctx.principal.userId,
	});
	const limit = clamp(args.limit, CAPS.opportunities);

	const matching = report.rows.filter((r) => {
		if (args.lane && r.verdict?.opportunity !== args.lane) {
			return false;
		}
		// A lane is a judgement on a rank. A keyword nobody observed has none, so
		// it answers no lane filter, the "unknown" one included: that lane means
		// ranked with no published volume.
		if (args.lane && r.verdict?.reasonKey === "noObservation") {
			return false;
		}
		if (!(args.includeBrand ?? false) && r.brand) {
			return false;
		}
		if (
			args.minPopularity !== undefined &&
			(r.popularityStatus !== "measured" ||
				(r.popularity ?? 0) < args.minPopularity)
		) {
			return false;
		}
		if (
			args.maxDifficulty !== undefined &&
			(r.difficulty?.score ?? 0) > args.maxDifficulty
		) {
			return false;
		}
		return true;
	});
	const { rows, truncated } = capped(matching, limit);

	return {
		data: {
			keywords: rows.map(rowSummary),
			provenance: {
				note: "Brand keywords are excluded unless includeBrand is true: you should already rank first on your own name, and mixing brand terms into the average flatters the picture.",
				truncated,
			},
			thresholds: {
				difficultyBlocked: DIFFICULTY_BLOCKED,
				popularityMeasurable: POPULARITY_MEASURABLE,
				unprovenWithinDays: 2,
			},
			totals: report.insights,
		},
		rowCount: rows.length,
	};
}

export async function getSearchResults(
	args: {
		pairId: number;
		date?: string | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requirePair(ctx, args.pairId);
	const limit = clamp(args.limit, CAPS.results);
	const page = await pairResultPage(ctx.db, args.pairId, args.date);
	const { rows, truncated } = capped(page.results, limit);
	return {
		data: {
			date: page.date,
			provenance: {
				note: "Apps we have never observed elsewhere are returned as ids with a null name; they are kept in place because dropping them would silently shift every position below.",
				resultCount: page.resultCount,
				truncated,
			},
			results: rows,
		},
		rowCount: rows.length,
	};
}

export async function getReviews(
	args: {
		appId: number;
		storefront?: string | undefined;
		minRating?: number | undefined;
		maxRating?: number | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const limit = clamp(args.limit, CAPS.reviews);
	const result = await appReviews(ctx.db, args.appId, {
		limit: limit + 1,
		maxRating: args.maxRating,
		minRating: args.minRating,
		storefront: args.storefront,
	});
	const { rows, truncated } = capped(result.results, limit);
	return {
		data: {
			provenance: {
				note: "Apple's public review feed returns only the most recent pages per storefront, so this is a recency sample and never the full review history.",
				truncated,
			},
			reviews: rows,
		},
		rowCount: rows.length,
	};
}

export async function getRatingsHistory(
	args: {
		appId: number;
		storefront?: string | undefined;
		from?: string | undefined;
		to?: string | undefined;
		detail?: "summary" | "daily" | undefined;
		limit?: number | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	await requireApp(ctx, args.appId);
	const w = window(args.from, args.to, 90);
	const limit = clamp(args.limit, CAPS.ratings);
	const result = await appRatings(ctx.db, args.appId);
	const all = (
		result.results as {
			storefront_code: string;
			observed_date: string;
			rating_count: number | null;
			rating_avg: number | null;
		}[]
	).filter(
		(r) =>
			r.observed_date >= w.from &&
			r.observed_date <= w.to &&
			(!args.storefront || r.storefront_code === args.storefront)
	);

	if (args.detail === "daily") {
		const { rows, truncated } = capped(all, limit);
		return {
			data: { provenance: { requested: w, truncated }, snapshots: rows },
			rowCount: rows.length,
		};
	}

	const byStorefront = new Map<string, typeof all>();
	for (const r of all) {
		byStorefront.set(r.storefront_code, [
			...(byStorefront.get(r.storefront_code) ?? []),
			r,
		]);
	}
	const summary = [...byStorefront.entries()].map(([storefront, rows]) => {
		const [first] = rows;
		const last = rows.at(-1);
		return {
			countChange:
				first && last
					? (last.rating_count ?? 0) - (first.rating_count ?? 0)
					: null,
			firstDate: first?.observed_date ?? null,
			lastDate: last?.observed_date ?? null,
			latestAvg: last?.rating_avg ?? null,
			latestCount: last?.rating_count ?? null,
			observations: rows.length,
			storefront,
		};
	});

	return {
		data: {
			provenance: {
				note: "rating_avg is Apple's lifetime average for the current version stream, not a per-day average; a flat average with a rising count is normal.",
				requested: w,
			},
			storefronts: summary,
		},
		rowCount: summary.length,
	};
}

export async function getCollectionHealth(
	args: {
		appId?: number | undefined;
		from?: string | undefined;
		to?: string | undefined;
	},
	ctx: ToolContext
): Promise<ToolOutcome> {
	const health = await dataHealth(ctx.db, ctx.principal.userId);
	const global = {
		ascAnomalyCount: health.ascAnomalies.length,
		cadencePlan: health.cadence,
		collectedToday: health.collectedToday,
		errorsLast24h: health.errorsLast24h,
		lastDailyRun: health.lastDailyRun,
		// Named apart from the list on purpose. An agent summing the rows would
		// report throttles and Apple's own skipped dates as collection failures,
		// which is the mistake the dashboard badge used to make.
		lostLast24h: health.lostLast24h,
		loopHeartbeat: health.loop,
		overduePairs: health.overduePairs,
		pacing: health.pacing,
		tier1Pairs: health.tier1Pairs,
	};

	if (args.appId === undefined) {
		return {
			data: {
				collector: global,
				provenance: {
					note: "Collector pacing, cadence and error classes describe shared infrastructure: crawl_pair is the union of what every operator tracks. Pass appId for per-pair coverage of your own keywords. Only lostLast24h counts observations that are gone; the errorsLast24h rows also include throttles, which the pause and the next run absorb, and findings about Apple's own data that nothing of ours failed on. Each row carries `loss` to say which it is.",
				},
			},
			rowCount: health.errorsLast24h.length,
		};
	}

	await requireApp(ctx, args.appId);
	const w = window(args.from, args.to);
	const pairs = await ctx.db
		.prepare(
			`SELECT cp.id, k.text AS keyword, cp.storefront_code
       FROM tracked_keyword tk
       JOIN keyword k ON k.id = tk.keyword_id
       ${TRACKED_PAIRS}
       WHERE tk.app_id = ?1 AND tk.user_id = ?2
       ORDER BY k.text
       LIMIT ?3`
		)
		.bind(args.appId, ctx.principal.userId, CAPS.keywords)
		.all<{ id: number; keyword: string; storefront_code: string }>();

	const byPair = await pairsCoverage(
		ctx.db,
		pairs.results.map((p) => p.id),
		w.from,
		w.to
	);
	const coverage = pairs.results.map((p) => ({
		keyword: p.keyword,
		pairId: p.id,
		storefront: p.storefront_code,
		...(byPair.get(p.id) as Coverage),
	}));
	const degraded = coverage.filter((c) => c.degraded);

	return {
		data: {
			coverage,
			collector: global,
			provenance: {
				degradedPairs: degraded.length,
				note:
					degraded.length > 0
						? `${degraded.length} of ${coverage.length} tracked pairs have degraded coverage in this window. Rank comparisons across those pairs are not evidence of rank change.`
						: null,
				requested: w,
			},
		},
		rowCount: coverage.length,
	};
}
