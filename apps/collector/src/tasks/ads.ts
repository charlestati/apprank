// Apple Ads search-term popularity: a weekly pull, one query per task tick.
// Raw responses are archived verbatim (they are small JSON) before anything is
// derived from them.
//
// Two passes, because Apple answers two different questions and only one of
// them is about the keywords an operator tracks:
//
//  - `ads_pull` asks for the ranked top 500 of a (storefront × genre). That
//    list is a *discovery* feed: it fills `seed_term` for Tier 2, and its floor
//    is wherever rank 500 happens to land (popularity 51 for FR/GAMES in
//    August 2026). A tracked keyword is in it only by luck.
//  - `ads_terms` asks for the tracked keywords by name, with no genre filter,
//    which is the storefront-wide popularity a keyword report actually wants
//    and the only way to see a term Apple attributes to another genre or ranks
//    below the cut.
//
// Both are archived; only the second decides what the report shows.

import {
	AdsClient,
	AdsRateLimitedError,
	pickPrimaryAccount,
	STOREFRONT_WIDE_GENRE_ID,
} from "@apprank/core/apple/ads";
import type {
	AdsCredentials,
	SearchTermPopularityRow,
} from "@apprank/core/apple/ads";

import type { Env } from "../env";
import { putArchived } from "../lib/archive";
import { getState, setState, recordFetchError } from "../lib/state";
import type { Task } from "./types";

export function adsCreds(env: Env): AdsCredentials {
	return {
		clientId: env.ADS_CLIENT_ID,
		keyId: env.ADS_KEY_ID,
		privateKeyPem: env.ADS_PRIVATE_KEY,
		teamId: env.ADS_TEAM_ID,
	};
}

/** Discover and cache the ad account id needed for the X-AP-Context header. */
export async function adAccountId(env: Env): Promise<string> {
	const cached = await getState(env.DB, "ads:ad_account_id");
	if (cached) {
		return cached;
	}
	const { accounts, raw } = await AdsClient.listAdAccounts(adsCreds(env));
	const account = pickPrimaryAccount(accounts);
	if (!account) {
		// Credentials that authenticate but reach no account mean the API user was
		// never granted access to one. That is an Apple Ads user-management
		// problem rather than a key problem, and the two are easy to confuse.
		// Carry the raw body: an unexpected response shape produces an empty list
		// too, and that would be the same message for a completely different
		// cause.
		throw new Error(
			`Apple Ads credentials are valid but reached no ad account; acls=${JSON.stringify(raw).slice(0, 300)}`
		);
	}
	await setState(env.DB, "ads:ad_account_id", account.id);
	await setState(env.DB, "ads:ad_account_roles", account.roles.join(","));
	return account.id;
}

/** Most recent complete Sun–Sat week, offset one extra week for Apple's posting delay. */
export function latestCompleteWeekStart(now = new Date()): string {
	const d = new Date(now);
	d.setUTCDate(d.getUTCDate() - 7 - d.getUTCDay() - 7);
	return d.toISOString().slice(0, 10);
}

/**
 * The `n` complete weeks ending with `latestCompleteWeekStart`, oldest first.
 *
 * Popularity is the one thing in this repository that *can* be backfilled.
 * Ranks cannot: Apple publishes no past search results, so a day nobody
 * recorded is gone (invariant 1). Apple Ads does serve history, and its own
 * filterable-fields table takes `week` with an `IN` operator, so a week we
 * never collected is a request away rather than a permanent hole.
 */
export function recentWeekStarts(n: number, now = new Date()): string[] {
	const latest = new Date(`${latestCompleteWeekStart(now)}T00:00:00Z`);
	const weeks: string[] = [];
	for (let i = n - 1; i >= 0; i -= 1) {
		const d = new Date(latest);
		d.setUTCDate(d.getUTCDate() - 7 * i);
		weeks.push(d.toISOString().slice(0, 10));
	}
	return weeks;
}

/** The Saturday closing the Sun–Sat week that `start` opens. */
export function weekEnd(start: string): string {
	const d = new Date(`${start}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 6);
	return d.toISOString().slice(0, 10);
}

/**
 * Terms per by-name request. Apple accepts a list filter; the cap is on our
 * side, to keep one task tick inside the subrequest and CPU budget and to keep
 * a failed chunk small enough to retry cheaply.
 */
export const TERM_CHUNK = 100;

/**
 * Rows per genre-discovery page. The 500-term ceiling is Apple's, not ours:
 * asking for 1000 came back with `pageSize: 500`, 500 rows, and the last one at
 * `rankInGenre` 500. Worth having settled, because every pull until then had
 * asked for exactly 500 and received exactly 500, which looks identical to our
 * own page size being the binding limit.
 */
export const GENRE_PAGE = 500;

/** Every keyword somebody tracks in this storefront, normalized as stored. */
export async function trackedTerms(
	env: Env,
	storefront: string
): Promise<string[]> {
	const rows = await env.DB.prepare(
		`SELECT DISTINCT k.normalized AS term
       FROM crawl_pair cp
       JOIN keyword k ON k.id = cp.keyword_id
      WHERE cp.storefront_code = ? AND cp.ref_count > 0
      ORDER BY k.normalized`
	)
		.bind(storefront)
		.all<{ term: string }>();
	return rows.results.map((r) => r.term);
}

/** Apple echoes the term as searched; compare on the same normalization. */
export function normalize(term: string): string {
	return term.toLowerCase().normalize("NFC").trim();
}

/**
 * How many times an Ads task is requeued after a 429 before this pass gives up.
 *
 * `rate_limited` counts as absorbed back-pressure on the data-health page,
 * which is only true while the retry eventually lands. Uncapped, a quota that
 * stayed spent cycled the same task on every tick, invisibly, and starved the
 * queue behind it. Everything here is weekly and re-queued by the next pass or
 * a backfill, so abandoning it costs a delay, and `pull_abandoned` says so.
 */
export const MAX_RATE_LIMITED_ATTEMPTS = 5;

/**
 * Requeue a refused unit, or give up on it alone.
 *
 * `onGiveUp` is what the task would have handed on had this unit succeeded: the
 * remaining genre units, chunks or seeds. Giving up used to return nothing,
 * which dropped all of them for a refusal that was only ever about one.
 */
export async function rateLimited<T extends Task>(
	env: Env,
	task: T,
	endpoint: string,
	params: string,
	onGiveUp: Task[]
): Promise<Task[]> {
	await recordFetchError(env.DB, {
		endpoint,
		errorClass: "rate_limited",
		httpStatus: 429,
		params,
	});
	const attempt = (task.attempt ?? 0) + 1;
	if (attempt < MAX_RATE_LIMITED_ATTEMPTS) {
		return [{ ...task, attempt }];
	}
	await recordFetchError(env.DB, {
		endpoint,
		errorClass: "pull_abandoned",
		params: JSON.stringify({ attempts: attempt, unit: params }),
	});
	return onGiveUp;
}

/**
 * Tracked keywords in a storefront with no storefront-wide popularity row for
 * the week: never asked, or asked in a chunk that failed. An asked-and-absent
 * answer is a row (`present = 0`), so it is not asked again.
 *
 * Per keyword, not per week. Checking whether the week held *any* row skipped
 * every keyword tracked after the week was first pulled, which is exactly the
 * keyword a backfill exists for: one accepted from the suggestions inbox.
 */
export async function missingTerms(
	env: Env,
	storefront: string,
	weekStart: string
): Promise<string[]> {
	const rows = await env.DB.prepare(
		`SELECT DISTINCT k.normalized AS term
       FROM crawl_pair cp
       JOIN keyword k ON k.id = cp.keyword_id
      WHERE cp.storefront_code = ?1 AND cp.ref_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM popularity p
           WHERE p.keyword_id = k.id AND p.storefront_code = ?1
             AND p.genre_id = ?2 AND p.week_start = ?3
        )
      ORDER BY k.normalized`
	)
		.bind(storefront, STOREFRONT_WIDE_GENRE_ID, weekStart)
		.all<{ term: string }>();
	return rows.results.map((r) => r.term);
}

/**
 * The by-name pass for these weeks, one task per storefront and week that still
 * lacks an answer for some tracked keyword.
 *
 * Queued on its own rather than chained off the genre pull. Chained, it ran only
 * when a storefront's last genre unit succeeded, so one failed unit, or a
 * storefront whose genre maps to no Ads category, cost that storefront its
 * storefront-wide popularity for the week. A verify pass asks for every tracked
 * term, since a credential check that found nothing missing would make no
 * request at all.
 */
export async function buildTermsTasks(
	env: Env,
	weekStarts: string[],
	verifyOnly = false
): Promise<Task[]> {
	const storefronts = await env.DB.prepare(
		`SELECT DISTINCT cp.storefront_code AS code
       FROM crawl_pair cp
       JOIN storefront s ON s.code = cp.storefront_code
      WHERE cp.ref_count > 0 AND s.active = 1
      ORDER BY cp.storefront_code`
	).all<{ code: string }>();
	const tasks: Task[] = [];
	for (const { code } of storefronts.results) {
		for (const weekStart of weekStarts) {
			const terms = verifyOnly
				? await trackedTerms(env, code)
				: await missingTerms(env, code, weekStart);
			if (terms.length > 0) {
				tasks.push({
					storefront: code,
					terms,
					type: "ads_terms",
					weekStart,
					...(verifyOnly ? { verifyOnly } : {}),
				});
			}
		}
	}
	return tasks;
}

/** Eight hex characters of SHA-256 over the chunk: enough to tell passes apart. */
async function chunkTag(chunk: string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(chunk.join("\n"))
	);
	// Array.from, not a typed-array map: Uint8Array#map coerces each hex string
	// back into a byte.
	return Array.from(new Uint8Array(digest).slice(0, 4), (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
}

export async function adsPullStep(
	env: Env,
	task: Extract<Task, { type: "ads_pull" }>
): Promise<Task[]> {
	const [unit] = task.queue;
	if (!unit) {
		return [];
	}
	const rest = task.queue.slice(1);
	const requeue: Task[] =
		rest.length > 0
			? [
					{
						queue: rest,
						type: "ads_pull",
						verifyOnly: task.verifyOnly,
						weekStart: task.weekStart,
					},
				]
			: [];

	try {
		const client = new AdsClient(adsCreds(env), await adAccountId(env));
		const { rows, raw } = await client.searchTermPopularity({
			countryOrRegion: unit.storefront.toUpperCase(),
			end: weekEnd(task.weekStart),
			genre: unit.category,
			limit: GENRE_PAGE,
			start: task.weekStart,
		});

		// The genre id is in the key, not just the category name, because the
		// category cannot be mapped back: PRODUCTIVITY_UTILITIES is the Ads
		// category for both Productivity (6007) and Utilities (6002), so a key
		// naming only the category loses a dimension the rows were stored under
		// and `scripts/rebuild-d1` cannot reconstruct them. Same reason the ASC
		// keys carry the app id.
		const r2Key = `ads/popularity/${task.weekStart}/${unit.storefront}/${unit.genreId}-${unit.category}.json`;
		await putArchived(env, r2Key, JSON.stringify(raw));

		// The archive above is the source of truth, so a verify pass has already
		// proved everything a credential check cares about: the JWT signed, Apple
		// answered, the shape parsed. Stop before the D1 writes.
		if (task.verifyOnly) {
			return requeue;
		}

		const month = task.weekStart.slice(0, 7);
		const now = Date.now();
		const stmts: D1PreparedStatement[] = [];
		for (const row of rows) {
			stmts.push(
				// Tier-2 seed list entry.
				env.DB.prepare(
					// The WHERE turns an unchanged row into a no-op. Apple's list is
					// weekly, so most of a re-pull is identical. Without this, every
					// repeat spent a write per term against the free tier's daily
					// budget.
					"INSERT INTO seed_term (month, storefront_code, genre_id, term, rank_in_genre, popularity_1_100) VALUES (?, ?, ?, ?, ?, ?) " +
						"ON CONFLICT(month, storefront_code, genre_id, term) DO UPDATE SET rank_in_genre = excluded.rank_in_genre, popularity_1_100 = excluded.popularity_1_100 " +
						"WHERE rank_in_genre IS NOT excluded.rank_in_genre OR popularity_1_100 IS NOT excluded.popularity_1_100"
				).bind(
					month,
					unit.storefront,
					unit.genreId,
					row.searchTerm,
					row.rankInGenre ?? null,
					row.searchPopularity1to100 ?? null
				),
				// Popularity history only for keywords someone tracks.
				env.DB.prepare(
					`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, popularity_1_5, rank_in_genre, fetched_at)
           SELECT k.id, ?, ?, ?, 1, ?, ?, ?, ? FROM keyword k WHERE k.normalized = ?
           ON CONFLICT(keyword_id, storefront_code, genre_id, week_start) DO UPDATE SET
             present = 1, popularity_1_100 = excluded.popularity_1_100,
             popularity_1_5 = excluded.popularity_1_5, rank_in_genre = excluded.rank_in_genre
           WHERE present IS NOT 1
             OR popularity_1_100 IS NOT excluded.popularity_1_100
             OR popularity_1_5 IS NOT excluded.popularity_1_5
             OR rank_in_genre IS NOT excluded.rank_in_genre`
				).bind(
					unit.storefront,
					unit.genreId,
					task.weekStart,
					row.searchPopularity1to100 ?? null,
					row.searchPopularity1to5 ?? null,
					row.rankInGenre ?? null,
					now,
					row.searchTerm.toLowerCase().normalize("NFC").trim()
				)
			);
		}
		// Tracked keywords absent from the ranked list: "no data" is a first-class
		// observation, distinct from low popularity.
		stmts.push(
			env.DB.prepare(
				`INSERT OR IGNORE INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, fetched_at)
         SELECT DISTINCT cp.keyword_id, ?, ?, ?, 0, ?
         FROM crawl_pair cp WHERE cp.storefront_code = ? AND cp.ref_count > 0`
			).bind(
				unit.storefront,
				unit.genreId,
				task.weekStart,
				now,
				unit.storefront
			)
		);
		// D1 batch caps at reasonable sizes; chunk to stay safe.
		for (let i = 0; i < stmts.length; i += 50) {
			await env.DB.batch(stmts.slice(i, i + 50));
		}
		// Only a pull that actually returned terms counts as the week collected.
		// Marking an empty response done would let one bad answer from Apple block
		// every retry for that week, and the week is the whole retention grain.
		if (rows.length > 0) {
			await setState(
				env.DB,
				`ads:pulled:${unit.storefront}:${unit.category}`,
				task.weekStart
			);
		}
		return requeue;
	} catch (error) {
		if (error instanceof AdsRateLimitedError) {
			// Put the unit back; the scheduler's next tick naturally spaces retries.
			return rateLimited(
				env,
				task,
				"ads:popularity",
				`${unit.storefront}/${unit.genreId}`,
				requeue
			);
		}
		await recordFetchError(env.DB, {
			endpoint: "ads:popularity",
			params: `${unit.storefront}/${unit.genreId}`,
			errorClass: "upstream_error",
			// Wide enough to carry an upstream body: truncating a diagnosis to 100
			// characters cost an hour of guessing once.
			message:
				error instanceof Error ? error.message.slice(0, 1200) : "unknown",
		});
		// Skip the failing unit, keep the rest of the queue moving.
		return requeue;
	}
}

/**
 * One chunk of the by-name pass: ask Apple for the tracked keywords it was not
 * going to volunteer, and record an answer for every term in the chunk.
 *
 * No genre filter. Apple attributes a term to the genre its searches convert
 * in, so a word game's keyword can be published under Education or under
 * nothing the account tracks; filtering by GAMES would silently drop it and
 * leave a keyword that Apple *does* measure looking unmeasured.
 */
export async function adsTermsStep(
	env: Env,
	task: Extract<Task, { type: "ads_terms" }>
): Promise<Task[]> {
	const chunk = task.terms.slice(0, TERM_CHUNK);
	if (chunk.length === 0) {
		return [];
	}
	const rest = task.terms.slice(TERM_CHUNK);
	const requeue: Task[] =
		rest.length > 0
			? [
					{
						storefront: task.storefront,
						terms: rest,
						type: "ads_terms",
						verifyOnly: task.verifyOnly,
						weekStart: task.weekStart,
					},
				]
			: [];

	try {
		const client = new AdsClient(adsCreds(env), await adAccountId(env));
		const { rows, raw } = await client.searchTermPopularity({
			countryOrRegion: task.storefront.toUpperCase(),
			end: weekEnd(task.weekStart),
			searchTerms: chunk,
			start: task.weekStart,
		});

		// Remaining-count first, so a listing reads in pass order, then a short
		// hash of the chunk. The count alone collided: a later pass for the same
		// week whose term set happened to be the same size overwrote the earlier
		// body, and the rows derived from it were no longer reconstructible. Both
		// parts are stable across a retry of the same chunk.
		const offset = String(task.terms.length).padStart(4, "0");
		await putArchived(
			env,
			`ads/popularity-terms/${task.weekStart}/${task.storefront}/${offset}-${await chunkTag(chunk)}.json`,
			JSON.stringify(raw)
		);
		if (task.verifyOnly) {
			return requeue;
		}

		const now = Date.now();
		const byTerm = new Map<string, SearchTermPopularityRow>();
		for (const row of rows) {
			byTerm.set(normalize(row.searchTerm), row);
		}
		const stmts = chunk.map((term) => {
			const row = byTerm.get(term);
			return env.DB.prepare(
				// One statement for both outcomes. A term Apple answered nothing for
				// is an observation too (invariant 3): `present = 0` says we asked,
				// which the report keeps distinct from never having asked.
				`INSERT INTO popularity (keyword_id, storefront_code, genre_id, week_start, present, popularity_1_100, popularity_1_5, rank_in_genre, fetched_at)
         SELECT k.id, ?, ?, ?, ?, ?, ?, NULL, ? FROM keyword k WHERE k.normalized = ?
         ON CONFLICT(keyword_id, storefront_code, genre_id, week_start) DO UPDATE SET
           present = excluded.present, popularity_1_100 = excluded.popularity_1_100,
           popularity_1_5 = excluded.popularity_1_5, fetched_at = excluded.fetched_at
         WHERE present IS NOT excluded.present
           OR popularity_1_100 IS NOT excluded.popularity_1_100
           OR popularity_1_5 IS NOT excluded.popularity_1_5`
			).bind(
				task.storefront,
				STOREFRONT_WIDE_GENRE_ID,
				task.weekStart,
				row ? 1 : 0,
				row?.searchPopularity1to100 ?? null,
				row?.searchPopularity1to5 ?? null,
				now,
				term
			);
		});
		for (let i = 0; i < stmts.length; i += 50) {
			await env.DB.batch(stmts.slice(i, i + 50));
		}
		return requeue;
	} catch (error) {
		if (error instanceof AdsRateLimitedError) {
			return rateLimited(
				env,
				task,
				"ads:popularity_terms",
				`${task.storefront}/${chunk.length} terms`,
				requeue
			);
		}
		await recordFetchError(env.DB, {
			endpoint: "ads:popularity_terms",
			params: `${task.storefront}/${chunk.length} terms`,
			errorClass: "upstream_error",
			message:
				error instanceof Error ? error.message.slice(0, 1200) : "unknown",
		});
		// Skip the failing chunk, keep the rest moving: a term that gets no answer
		// keeps the row it had, which reads as a gap rather than as a zero.
		return requeue;
	}
}
