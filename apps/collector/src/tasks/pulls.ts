// App-level daily pulls for tracked apps: metadata lookup (change detection +
// rating snapshot + localization presence), review RSS, chart RSS. One fetch
// per tick, sharing the same learned-rate pacing as the keyword crawl.

import {
	lookupUrl,
	reviewsRssUrl,
	chartRssUrl,
	fetchClassified,
} from "@apprank/core/apple/itunes";
import type { ITunesResponse } from "@apprank/core/apple/itunes";
import { normalizeApp } from "@apprank/core/normalize/itunes";

import type { Env } from "../env";
import { recordFetchError } from "../lib/state";
import type { Task } from "./types";

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

export interface LookupUnit {
	appId: number;
	storefront: string;
	localeCode: string;
}
export interface ReviewUnit {
	appId: number;
	storefront: string;
}
export interface ChartUnit {
	storefront: string;
	genreId: number | null;
	chart: "free" | "paid" | "grossing";
}

/**
 * How many times a throttled unit is retried where it stands before it yields
 * its place. Small, because the pause the throttle already imposed is the real
 * spacing; this only decides who goes next.
 */
const RETRY_IN_PLACE = 2;

/**
 * Re-queue a batch pull after a throttle.
 *
 * Retrying the head unit in place is right while a throttle is transient. It
 * was wrong as the only behaviour: `attempt` was counted and never read, so a
 * unit Apple refuses persistently (a storefront answering 403 to the RSS and
 * lookup endpoints, say) starved every unit behind it forever, and burned the
 * pacing pause ladder daily on a fetch that could not succeed.
 *
 * So the unit rotates to the back every `RETRY_IN_PLACE` attempts, and the
 * batch is abandoned once every unit has had its turn. Abandoning is for the
 * day only: the daily job rebuilds these queues from the tracked set, so a
 * bad storefront costs today's pull, never the series. Leaving it queued
 * instead would stack a fresh copy on top of a wedged one every night.
 */
function requeueThrottled<T extends { queue: unknown[]; attempt?: number }>(
	task: T,
	attempt: number
): T | null {
	const { queue } = task;
	if (attempt >= queue.length * RETRY_IN_PLACE) {
		return null;
	}
	const rotate = queue.length > 1 && attempt % RETRY_IN_PLACE === 0;
	const next = rotate ? [...queue.slice(1), queue[0]] : queue;
	return { ...task, attempt, queue: next };
}

export async function lookupPullStep(
	env: Env,
	task: { queue: LookupUnit[]; attempt?: number }
): Promise<{ followUps: Task[]; throttled: boolean }> {
	const [unit] = task.queue;
	if (!unit) {
		return { followUps: [], throttled: false };
	}
	const rest: Task[] =
		task.queue.length > 1
			? [{ queue: task.queue.slice(1), type: "lookup_pull" }]
			: [];

	const outcome = await fetchClassified(
		lookupUrl(unit.appId, unit.storefront, unit.localeCode)
	);
	if (outcome.kind === "throttled") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:lookup",
			errorClass: "throttled",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		const attempt = (task.attempt ?? 0) + 1;
		const next = requeueThrottled(
			{ ...task, type: "lookup_pull" as const },
			attempt
		);
		if (!next) {
			await recordFetchError(env.DB, {
				endpoint: "itunes:lookup",
				errorClass: "pull_abandoned",
				params: JSON.stringify({ attempts: attempt, units: task.queue.length }),
			});
		}
		return { followUps: next ? [next] : [], throttled: true };
	}
	if (outcome.kind === "error") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:lookup",
			errorClass: "http_error",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		return { followUps: rest, throttled: false };
	}

	const json = outcome.json as ITunesResponse;
	const result = json.results?.[0];
	const now = Date.now();
	const date = todayUtc();

	if (!result) {
		// App absent from this storefront, which is itself worth recording.
		await recordFetchError(env.DB, {
			endpoint: "itunes:lookup",
			errorClass: "app_not_in_storefront",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		return { followUps: rest, throttled: false };
	}

	const napp = await normalizeApp(result);
	const m = napp.metadata;

	// This lookup already existed below, for the metadata-change burst. Doing it
	// first lets it also skip the insert: app_metadata_version dedupes on
	// content_hash, but its key is AUTOINCREMENT, so an ignored insert still
	// costs a write, because SQLite touches sqlite_sequence regardless.
	const known = await env.DB.prepare(
		"SELECT 1 AS x FROM app_metadata_version WHERE app_id = ? AND content_hash = ?"
	)
		.bind(napp.id, m.contentHash)
		.first();

	const stmts = [
		env.DB.prepare(
			`INSERT INTO app (id, bundle_id, current_name, developer_id, developer_name, primary_genre_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET current_name = excluded.current_name, last_seen_at = excluded.last_seen_at
       -- Same reason as the crawl path: last_seen_at always differs, so
       -- without this the row is rewritten daily for a column nothing reads.
       WHERE current_name IS NOT excluded.current_name`
		).bind(
			napp.id,
			napp.bundleId,
			napp.name,
			napp.developerId,
			napp.developerName,
			napp.primaryGenreId,
			now,
			now
		),
		...(known
			? []
			: [
					env.DB.prepare(
						`INSERT OR IGNORE INTO app_metadata_version
             (app_id, captured_at, source, title, subtitle, description_hash, version, price, currency, has_iap,
              genre_ids, rating_count, rating_avg, screenshot_urls_hash, icon_url, release_notes_hash, content_hash)
           VALUES (?, ?, 'itunes-lookup', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
					).bind(
						napp.id,
						now,
						m.title,
						m.subtitle,
						m.descriptionHash,
						m.version,
						m.price,
						m.currency,
						m.genreIds,
						m.ratingCount,
						m.ratingAvg,
						m.screenshotUrlsHash,
						m.iconUrl,
						m.releaseNotesHash,
						m.contentHash
					),
				]),
		// Per-storefront rating series: drives difficulty, moves daily.
		env.DB.prepare(
			`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, storefront_code, observed_date) DO UPDATE SET rating_count = excluded.rating_count, rating_avg = excluded.rating_avg`
		).bind(napp.id, unit.storefront, date, m.ratingCount, m.ratingAvg),
	];

	// Metadata change → burst: force daily cadence on all this app's pairs for
	// 14 days.
	const isTracked = await env.DB.prepare(
		"SELECT 1 AS x FROM tracked_app WHERE app_id = ?"
	)
		.bind(napp.id)
		.first();
	if (!known && isTracked) {
		stmts.push(
			env.DB.prepare(
				`UPDATE crawl_pair SET burst_until = ?, interval_hours = 24
         WHERE ref_count > 0 AND keyword_id IN (SELECT keyword_id FROM tracked_keyword WHERE app_id = ?)`
			).bind(now + 14 * 24 * 3_600_000, napp.id)
		);
	}
	await env.DB.batch(stmts);
	await env.ARCHIVE.put(
		`lookups/${date}/${unit.appId}-${unit.storefront}-${unit.localeCode}.json`,
		outcome.bodyText
	);
	return { followUps: rest, throttled: false };
}

interface RssReviewEntry {
	id?: { label?: string };
	author?: { name?: { label?: string } };
	title?: { label?: string };
	content?: { label?: string };
	"im:rating"?: { label?: string };
	"im:version"?: { label?: string };
	updated?: { label?: string };
}

function reviewInsertStmt(
	env: Env,
	unit: ReviewUnit,
	e: RssReviewEntry,
	id: string,
	now: number
): D1PreparedStatement {
	return env.DB.prepare(
		`INSERT OR IGNORE INTO review (id, app_id, storefront_code, rating, title, body, author, app_version, reviewed_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).bind(
		`${unit.storefront}-${id}`,
		unit.appId,
		unit.storefront,
		e["im:rating"]?.label ? Math.trunc(Number(e["im:rating"].label)) : null,
		e.title?.label ?? null,
		e.content?.label ?? null,
		e.author?.name?.label ?? null,
		e["im:version"]?.label ?? null,
		e.updated?.label ? Date.parse(e.updated.label) || null : null,
		now
	);
}

export async function reviewPullStep(
	env: Env,
	task: { queue: ReviewUnit[]; attempt?: number }
): Promise<{ followUps: Task[]; throttled: boolean }> {
	const [unit] = task.queue;
	if (!unit) {
		return { followUps: [], throttled: false };
	}
	const rest: Task[] =
		task.queue.length > 1
			? [{ queue: task.queue.slice(1), type: "review_pull" }]
			: [];

	const outcome = await fetchClassified(
		reviewsRssUrl(unit.appId, unit.storefront, 1)
	);
	if (outcome.kind === "throttled") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:reviews",
			errorClass: "throttled",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		const attempt = (task.attempt ?? 0) + 1;
		const next = requeueThrottled(
			{ ...task, type: "review_pull" as const },
			attempt
		);
		if (!next) {
			await recordFetchError(env.DB, {
				endpoint: "itunes:reviews",
				errorClass: "pull_abandoned",
				params: JSON.stringify({ attempts: attempt, units: task.queue.length }),
			});
		}
		return { followUps: next ? [next] : [], throttled: true };
	}
	if (outcome.kind === "error") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:reviews",
			errorClass: "http_error",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		return { followUps: rest, throttled: false };
	}

	const feed = outcome.json as {
		feed?: { entry?: RssReviewEntry | RssReviewEntry[] };
	};
	const raw = feed.feed?.entry;
	// First entry is the app itself when the array form is returned; single
	// object means no reviews.
	const entries = Array.isArray(raw) ? raw.filter((e) => e["im:rating"]) : [];
	const now = Date.now();
	const stmts: D1PreparedStatement[] = [];
	for (const e of entries) {
		const id = e.id?.label;
		if (!id) {
			continue;
		}
		stmts.push(reviewInsertStmt(env, unit, e, id, now));
	}
	if (stmts.length > 0) {
		await env.DB.batch(stmts);
	}
	await env.ARCHIVE.put(
		`reviews/${unit.appId}/${unit.storefront}/${todayUtc()}.json`,
		outcome.bodyText
	);
	return { followUps: rest, throttled: false };
}

interface RssChartEntry {
	id?: { attributes?: { "im:id"?: string } };
}

export async function chartPullStep(
	env: Env,
	task: { queue: ChartUnit[]; attempt?: number }
): Promise<{ followUps: Task[]; throttled: boolean }> {
	const [unit] = task.queue;
	if (!unit) {
		return { followUps: [], throttled: false };
	}
	const rest: Task[] =
		task.queue.length > 1
			? [{ queue: task.queue.slice(1), type: "chart_pull" }]
			: [];

	const outcome = await fetchClassified(
		chartRssUrl(unit.storefront, unit.chart, unit.genreId ?? undefined)
	);
	if (outcome.kind === "throttled") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:charts",
			errorClass: "throttled",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		const attempt = (task.attempt ?? 0) + 1;
		const next = requeueThrottled(
			{ ...task, type: "chart_pull" as const },
			attempt
		);
		if (!next) {
			await recordFetchError(env.DB, {
				endpoint: "itunes:charts",
				errorClass: "pull_abandoned",
				params: JSON.stringify({ attempts: attempt, units: task.queue.length }),
			});
		}
		return { followUps: next ? [next] : [], throttled: true };
	}
	if (outcome.kind === "error") {
		await recordFetchError(env.DB, {
			endpoint: "itunes:charts",
			errorClass: "http_error",
			httpStatus: outcome.status,
			params: JSON.stringify(unit),
		});
		return { followUps: rest, throttled: false };
	}

	const feed = outcome.json as {
		feed?: { entry?: RssChartEntry | RssChartEntry[] };
	};
	const raw = feed.feed?.entry;
	let entries: RssChartEntry[] = [];
	if (Array.isArray(raw)) {
		entries = raw;
	} else if (raw) {
		entries = [raw];
	}
	const ids = entries
		.map((e) => e.id?.attributes?.["im:id"])
		.filter((x): x is string => !!x)
		.map(Number);
	const date = todayUtc();
	const r2Key = `charts/${date.slice(0, 7)}/${unit.storefront}/${unit.chart}/${unit.genreId ?? "all"}/${date}.json`;
	await env.ARCHIVE.put(r2Key, outcome.bodyText);
	// Two conflict targets, because SQLite counts every NULL as distinct: the
	// genre-less storefront-wide chart needs the partial index from migration
	// 0007, named by repeating its WHERE clause. Sharing one target silently
	// appended a duplicate row per pull instead of updating.
	const conflict =
		unit.genreId === null
			? "ON CONFLICT(storefront_code, chart, observed_date) WHERE genre_id IS NULL"
			: "ON CONFLICT(storefront_code, genre_id, chart, observed_date)";
	await env.DB.prepare(
		`INSERT INTO chart_ranking (storefront_code, genre_id, chart, observed_date, result_ids, http_status, source, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, 'itunes-rss', ?)
     ${conflict} DO UPDATE SET
       result_ids = excluded.result_ids, http_status = excluded.http_status, r2_key = excluded.r2_key`
	)
		.bind(
			unit.storefront,
			unit.genreId,
			unit.chart,
			date,
			JSON.stringify(ids),
			outcome.status,
			r2Key
		)
		.run();
	return { followUps: rest, throttled: false };
}

/** Nightly: merge yesterday's staging observations into one daily NDJSON per storefront. */
export async function compactStep(
	env: Env,
	task: { date: string }
): Promise<Task[]> {
	const prefix = `staging/rankings/${task.date}/`;
	const byStorefront = new Map<string, string[]>();
	let cursor: string | undefined;
	do {
		const listing = await env.ARCHIVE.list({ cursor, limit: 500, prefix });
		for (const obj of listing.objects) {
			const body = await env.ARCHIVE.get(obj.key);
			if (!body) {
				continue;
			}
			const text = await body.text();
			const storefront =
				(JSON.parse(text) as { storefront?: string }).storefront ?? "unknown";
			const lines = byStorefront.get(storefront) ?? [];
			lines.push(text);
			byStorefront.set(storefront, lines);
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);

	const month = task.date.slice(0, 7);
	for (const [storefront, lines] of byStorefront) {
		await env.ARCHIVE.put(
			`rankings/v1/${month}/${storefront}/${task.date}.ndjson`,
			`${lines.join("\n")}\n`
		);
	}
	// Staging objects expire via the R2 lifecycle rule (7 days), so no deletes
	// are needed.
	return [];
}
