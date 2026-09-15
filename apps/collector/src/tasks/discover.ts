// Keyword discovery: what Apple would suggest for an app we already track.
//
// A deliberately small slice of the Tier-2 sweep. The original design was to
// crawl the market at large and calibrate difficulty against it; this does none
// of that. It asks Apple's own keyword-suggestions endpoint, scoped to the
// promoted app, which is what makes the answers relevant without any
// classification of our own.
//
// That scoping is the whole reason this is worth doing at all. Apple's genre
// top-500 sorted by popularity is nine parts competitor brand name (roblox,
// fortnite, brawl stars) and yields almost no word-game keyword this operator
// is missing. Seeded per tracked term, the same account returned 1,231 distinct
// terms, 1,110 of them untracked, of which roughly 200 are near variants of
// keywords already watched: a tracked term with "gratuit" or a similar
// modifier appended. Those are the cheapest wins in ASO and
// nothing in this repository was looking at them.
//
// Nothing here touches the crawl budget. A proposal is a row in `suggestion`;
// only an operator accepting one creates a crawl pair.

import { AdsClient, AdsRateLimitedError } from "@apprank/core/apple/ads";
import type { KeywordSuggestionRow } from "@apprank/core/apple/ads";

import type { Env } from "../env";
import { putArchived } from "../lib/archive";
import { recordFetchError } from "../lib/state";
import { adsCreds, adAccountId, normalize, rateLimited } from "./ads";
import type { Task } from "./types";

/**
 * Proposals per seed. Apple answers one seed with up to ~75 associations, most
 * of them irrelevant; taking the whole tail would bury the operator in an inbox
 * they stop opening, which is the failure mode a suggestion queue dies of.
 */
export const PROPOSALS_PER_SEED = 3;

/**
 * Relevance floor, on Apple's 0-100 scale for this app. Below roughly this the
 * answers stop being variants of the seed and start being other categories
 * entirely.
 */
export const MIN_RELEVANCE = 15;

function isoDay(): string {
	return new Date().toISOString().slice(0, 10);
}

interface Candidate {
	term: string;
	relevance: number;
}

/** Words worth matching on. Shorter tokens are digits and articles. */
function tokens(term: string): string[] {
	return term.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
}

/**
 * Whether a candidate is a variant of the seed rather than a change of subject.
 *
 * Relevance cannot answer this. Measured on the live account, Apple returned
 * unrelated terms at 53 and 17 from two tracked seeds: high scores for terms
 * about nothing the app does. Sharing a
 * word with the seed is the signal that survives, and it is what the useful
 * answers all look like anyway, since the value here is the modifier variants
 * (a tracked term with "gratuit" appended).
 *
 * Token-based rather than a substring test, in either direction: "local" is
 * inside "localisation" and "locality", which is how a naive filter re-admits exactly
 * the noise it was added to remove.
 */
export function isVariantOf(candidate: string, seed: string): boolean {
	const seedWords = new Set(tokens(seed));
	return seedWords.size === 0
		? false
		: tokens(candidate).some((w) => seedWords.has(w));
}

/**
 * The terms worth proposing out of one answer.
 *
 * Apple returns the seed itself along with its associations, so the seed is
 * dropped by the tracked check rather than by name: a seed one operator tracks
 * may be a genuine proposal for another.
 */
export function pickCandidates(
	rows: KeywordSuggestionRow[],
	known: Set<string>,
	seed: string
): Candidate[] {
	const seen = new Map<string, number>();
	for (const row of rows) {
		const term = normalize(row.text ?? "");
		const relevance = row.popularity ?? 0;
		if (
			!term ||
			known.has(term) ||
			relevance < MIN_RELEVANCE ||
			!isVariantOf(term, seed)
		) {
			continue;
		}
		seen.set(term, Math.max(seen.get(term) ?? 0, relevance));
	}
	return [...seen.entries()]
		.map(([term, relevance]) => ({ relevance, term }))
		.toSorted((a, b) => b.relevance - a.relevance)
		.slice(0, PROPOSALS_PER_SEED);
}

/**
 * Terms this user should not be offered: already tracked in this storefront, or
 * already ruled on. A dismissal is an answer, and re-asking every week is how a
 * queue teaches people to ignore it.
 */
async function alreadyAnswered(
	env: Env,
	task: Extract<Task, { type: "ads_discover" }>
): Promise<Set<string>> {
	const [tracked, proposed] = await Promise.all([
		env.DB.prepare(
			`SELECT DISTINCT k.normalized AS term
         FROM crawl_pair cp
         JOIN keyword k ON k.id = cp.keyword_id
        WHERE cp.storefront_code = ?1 AND cp.ref_count > 0`
		)
			.bind(task.storefront)
			.all<{ term: string }>(),
		env.DB.prepare(
			`SELECT json_extract(payload, '$.term') AS term
         FROM suggestion
        WHERE user_id = ?1 AND type = 'promote_keyword'
          AND json_extract(payload, '$.storefront') = ?2`
		)
			.bind(task.userId, task.storefront)
			.all<{ term: string | null }>(),
	]);
	const known = new Set(tracked.results.map((r) => normalize(r.term)));
	for (const r of proposed.results) {
		if (r.term) {
			known.add(normalize(r.term));
		}
	}
	return known;
}

export async function adsDiscoverStep(
	env: Env,
	task: Extract<Task, { type: "ads_discover" }>
): Promise<Task[]> {
	// The next seed starts with a clean attempt count. Carried over, 429s added up
	// across seeds, and a unit refused once per seed was abandoned whole on its
	// fifth, taking every seed not yet asked with it.
	const requeue: Task[] =
		task.rest.length > 0
			? [
					{
						...task,
						attempt: 0,
						rest: task.rest.slice(1),
						seed: task.rest[0] as string,
					},
				]
			: [];

	try {
		const client = new AdsClient(adsCreds(env), await adAccountId(env));
		const { rows, raw } = await client.keywordSuggestions({
			countriesOrRegions: [task.storefront.toUpperCase()],
			promotedObjectId: task.appAdamId,
			terms: [task.seed],
		});
		// Keyed by the seed, which is what a reader looking at an R2 listing wants
		// to find, and stable across a retry.
		await putArchived(
			env,
			`ads/discover/${isoDay()}/${task.storefront}/${task.appAdamId}/${encodeURIComponent(task.seed)}.json`,
			JSON.stringify(raw)
		);
		if (task.verifyOnly) {
			return requeue;
		}

		const known = await alreadyAnswered(env, task);
		const candidates = pickCandidates(rows, known, task.seed);
		if (candidates.length === 0) {
			return requeue;
		}
		const now = Date.now();
		await env.DB.batch(
			candidates.map((c) =>
				env.DB.prepare(
					`INSERT INTO suggestion (user_id, type, payload, status, created_at)
           VALUES (?1, 'promote_keyword', ?2, 'pending', ?3)`
				).bind(
					task.userId,
					JSON.stringify({
						appId: task.appId,
						language: task.language,
						locale: task.localeCode,
						relevance: c.relevance,
						seed: task.seed,
						storefront: task.storefront,
						term: c.term,
					}),
					now
				)
			)
		);
		return requeue;
	} catch (error) {
		if (error instanceof AdsRateLimitedError) {
			return rateLimited(
				env,
				task,
				"ads:discover",
				`${task.storefront}/${task.appAdamId}`,
				requeue
			);
		}
		await recordFetchError(env.DB, {
			endpoint: "ads:discover",
			params: `${task.storefront}/${task.appAdamId}`,
			errorClass: "upstream_error",
			message:
				error instanceof Error ? error.message.slice(0, 1200) : "unknown",
		});
		// Drop this seed, keep the rest moving. Nothing was proposed, and the seed
		// comes round again next week.
		return requeue;
	}
}
