// Apple Ads search-term popularity: a weekly pull, one (storefront × genre)
// query per task tick. Raw response is archived verbatim (it's small JSON);
// popularity rows are upserted for keywords we know; seed_term rows feed Tier
// 2.

import {
	AdsClient,
	AdsRateLimitedError,
	pickPrimaryAccount,
} from "@apprank/core/apple/ads";
import type { AdsCredentials } from "@apprank/core/apple/ads";

import type { Env } from "../env";
import { getState, setState, recordFetchError } from "../lib/state";
import type { Task } from "./types";

function adsCreds(env: Env): AdsCredentials {
	return {
		clientId: env.ADS_CLIENT_ID,
		keyId: env.ADS_KEY_ID,
		privateKeyPem: env.ADS_PRIVATE_KEY,
		teamId: env.ADS_TEAM_ID,
	};
}

/** Discover and cache the ad account id needed for the X-AP-Context header. */
async function adAccountId(env: Env): Promise<string> {
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

/** The Saturday closing the Sun–Sat week that `start` opens. */
export function weekEnd(start: string): string {
	const d = new Date(`${start}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 6);
	return d.toISOString().slice(0, 10);
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
			? [{ queue: rest, type: "ads_pull", weekStart: task.weekStart }]
			: [];

	try {
		const client = new AdsClient(adsCreds(env), await adAccountId(env));
		const { rows, raw } = await client.searchTermPopularity({
			countryOrRegion: unit.storefront.toUpperCase(),
			end: weekEnd(task.weekStart),
			genre: unit.category,
			start: task.weekStart,
		});

		const r2Key = `ads/popularity/${task.weekStart}/${unit.storefront}/${unit.category}.json`;
		await env.ARCHIVE.put(r2Key, JSON.stringify(raw));

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
			await recordFetchError(env.DB, {
				endpoint: "ads:popularity",
				params: `${unit.storefront}/${unit.genreId}`,
				httpStatus: 429,
				errorClass: "rate_limited",
			});
			return [
				{
					type: "ads_pull",
					queue: task.queue,
					weekStart: task.weekStart,
					attempt: (task.attempt ?? 0) + 1,
				},
			];
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
