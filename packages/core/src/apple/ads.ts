// Apple Ads Platform API client (OAuth client-credentials with a self-signed
// ES256 JWT client secret). Hand-rolled: Apple's Node SDK needs fs/axios and
// does not run on workerd.

import { importP8, signJwt, nowEpochSeconds } from "./jwt";

export interface AdsCredentials {
	clientId: string;
	teamId: string;
	keyId: string;
	privateKeyPem: string; // .p8 contents
}

const TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
const API_BASE = "https://api.ads.apple.com";

/** Client secret JWT: exp must stay under 180 days; we mint short-lived ones. */
export async function mintAdsClientSecret(
	creds: AdsCredentials,
	lifetimeSeconds = 86_400
): Promise<string> {
	const key = await importP8(creds.privateKeyPem);
	const iat = nowEpochSeconds();
	return signJwt(
		{ alg: "ES256", kid: creds.keyId },
		{
			aud: "https://appleid.apple.com",
			exp: iat + lifetimeSeconds,
			iat,
			iss: creds.teamId,
			sub: creds.clientId,
		},
		key
	);
}

export interface AdsToken {
	accessToken: string;
	expiresAt: number; // epoch ms
}

export async function fetchAdsAccessToken(
	creds: AdsCredentials
): Promise<AdsToken> {
	const clientSecret = await mintAdsClientSecret(creds);
	const body = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: clientSecret,
		grant_type: "client_credentials",
		scope: "searchadsorg",
	});
	const res = await fetch(TOKEN_URL, {
		body,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
	});
	if (!res.ok) {
		throw new Error(
			`Ads token exchange failed: ${res.status} ${await res.text()}`
		);
	}
	const json = (await res.json()) as {
		access_token: string;
		expires_in: number;
	};
	return {
		accessToken: json.access_token,
		// Renew a minute early.
		expiresAt: Date.now() + (json.expires_in - 60) * 1000,
	};
}

export class AdsRateLimitedError extends Error {
	retryAfterSeconds: number;
	constructor(retryAfterSeconds: number) {
		super(`Ads API rate limited; retry after ${retryAfterSeconds}s`);
		this.name = "AdsRateLimitedError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/**
 * The quota headers Apple puts on every response, successful or not. Apple asks
 * clients to pace off these rather than to discover the ceiling by being
 * refused, so a spent window is treated here exactly like a 429: the caller
 * backs off before the request that would have earned one.
 */
export interface AdsRateLimit {
	limit: number | null;
	remaining: number | null;
	resetSeconds: number | null;
}

function readRateLimit(headers: Headers): AdsRateLimit {
	const num = (name: string) => {
		const raw = headers.get(name);
		if (raw === null) {
			return null;
		}
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	};
	return {
		limit: num("RateLimit-Limit"),
		remaining: num("RateLimit-Remaining"),
		resetSeconds: num("RateLimit-Reset"),
	};
}

/**
 * Turn a refusal into the one error the callers already know how to requeue on.
 * `Retry-After` wins over `RateLimit-Reset`: Apple documents it as the exact
 * wait for the request it just rejected.
 *
 * Only a 429 is a refusal. A 200 carrying `RateLimit-Remaining: 0` spent the
 * last request of the window *and got its answer*; throwing there discarded a
 * body that had already cost quota, before anything archived it, and the retry
 * spent the quota again. The header still travels back in `rateLimit`.
 */
function rateLimitGuard(
	res: Response,
	rateLimit: AdsRateLimit
): AdsRateLimitedError | null {
	if (res.status !== 429) {
		return null;
	}
	const retryAfter = res.headers.get("Retry-After");
	return new AdsRateLimitedError(
		retryAfter ? Math.trunc(Number(retryAfter)) : (rateLimit.resetSeconds ?? 60)
	);
}

/**
 * Genre id for a popularity row that has no genre.
 *
 * Apple publishes popularity per country; a genre only ever scopes a *ranking*
 * within it. A row fetched by search term carries no genre at all, so it is
 * stored against this sentinel rather than against whichever genre the
 * discovery pass happened to be walking. Labelling a storefront-wide number
 * "Games popularity" would claim precision Apple does not provide, and would
 * make the column incomparable between two keywords.
 */
export const STOREFRONT_WIDE_GENRE_ID = 0;

export interface SearchTermPopularityRow {
	searchTerm: string;
	rankInGenre?: number;
	searchPopularityInGenre?: number;
	searchPopularity1to100?: number;
	searchPopularity1to5?: number;
	[key: string]: unknown;
}

/** One row of `POST /v1/suggestions/keywords/query`. */
export interface KeywordSuggestionRow {
	text: string;
	/**
	 * Apple's relevance score for this keyword *against this app*, 0-100.
	 *
	 * Not search popularity, and it must never be stored as one. Measured
	 * against the live account on the same storefront and week, a competitor head
	 * term is 64
	 * on the insights endpoint and 7 here, while the app's own brand term is 62
	 * here and 53 there. It ranks how well a term suits the app, which is what a
	 * discovery feed wants and what a volume column must not be.
	 */
	popularity?: number;
	[key: string]: unknown;
}

export interface KeywordSuggestionQuery {
	/** App Store (Adam) id. Suggestions are scoped to one promoted app. */
	promotedObjectId: string;
	/** Uppercase ISO-2 codes. */
	countriesOrRegions?: string[];
	/**
	 * Seed terms. Send **one**: Apple narrows on the list rather than answering
	 * for each entry, so 5 seeds came back with a single row and 100 came back
	 * with 16. One seed returns that seed plus the terms Apple associates with
	 * it, which is the whole point.
	 */
	terms?: string[];
	limit?: number;
	offset?: number;
}

export interface PopularityQuery {
	countryOrRegion: string; // ISO-2, uppercase
	/** Apple's own genre classification string, as echoed in each row. */
	genre?: string;
	/** Inclusive YYYY-MM-DD bounds; for WEEKLY_SUN_SAT these are a Sun–Sat week. */
	start: string;
	end: string;
	granularity?: "WEEKLY_SUN_SAT" | "MONTHLY";
	limit?: number;
	offset?: number;
	/** Optional filter to specific terms. */
	searchTerms?: string[];
}

interface RawAcl {
	adAccount?: { id?: string | number; name?: string; orgId?: string | number };
	roles?: string[];
}

export interface AdAccountAcl {
	id: string;
	name: string | null;
	orgId: string | null;
	roles: string[];
}

/**
 * An Apple Ads login can hold several ad accounts: an Advanced account and a
 * separate "Search Ads Basic" one, say. The Advanced account is the one whose
 * id matches its own orgId; Basic appears as a distinct id under the same org
 * and has no Insights data. Prefer the former, fall back to whatever exists.
 */
export function pickPrimaryAccount(
	accounts: AdAccountAcl[]
): AdAccountAcl | undefined {
	return (
		accounts.find((a) => a.orgId !== null && a.orgId === a.id) ?? accounts[0]
	);
}

export class AdsClient {
	#creds: AdsCredentials;
	#adAccountId: string;
	#token: AdsToken | null = null;

	constructor(creds: AdsCredentials, adAccountId: string) {
		this.#creds = creds;
		this.#adAccountId = adAccountId;
	}

	async #headers(): Promise<Record<string, string>> {
		if (!this.#token || this.#token.expiresAt < Date.now()) {
			this.#token = await fetchAdsAccessToken(this.#creds);
		}
		return {
			Authorization: `Bearer ${this.#token.accessToken}`,
			"Content-Type": "application/json",
			"X-AP-Context": `adAccountId=${this.#adAccountId}`,
		};
	}

	/**
	 * Ranked search-term popularity list for one genre × storefront.
	 *
	 * The body shape is the Platform API's own: `timeRange` plus flat `filters`,
	 * not the `selector`/`conditions` envelope the older Campaign Management API
	 * used; sending the latter earns `REQUEST_UNRECOGNIZED_PROPERTY`. A term must
	 * clear ~500 searches to appear at all, and Apple returns at most 500 terms
	 * per country × genre, so an absent term is "not in the top 500", never
	 * "no volume".
	 */
	async searchTermPopularity(q: PopularityQuery): Promise<{
		rows: SearchTermPopularityRow[];
		raw: unknown;
		rateLimit: AdsRateLimit;
	}> {
		const body = {
			filters: [
				{
					field: "countryOrRegion",
					operator: "EQUALS",
					value: q.countryOrRegion,
				},
				...(q.genre
					? [{ field: "genre", operator: "EQUALS", value: q.genre }]
					: []),
				...(q.searchTerms?.length
					? [{ field: "searchTerm", operator: "IN", value: q.searchTerms }]
					: []),
			],
			pagination: { offset: q.offset ?? 0, pageSize: q.limit ?? 500 },
			sorting: [{ field: "rankInGenre", order: "ASC" }],
			timeRange: {
				end: q.end,
				granularity: q.granularity ?? "WEEKLY_SUN_SAT",
				start: q.start,
			},
		};
		const res = await fetch(
			`${API_BASE}/v1/insights/apps/search-term-popularity/query`,
			{
				body: JSON.stringify(body),
				headers: await this.#headers(),
				method: "POST",
			}
		);
		const rateLimit = readRateLimit(res.headers);
		const refused = rateLimitGuard(res, rateLimit);
		if (refused) {
			throw refused;
		}
		if (!res.ok) {
			throw new Error(
				`Ads popularity query failed: ${res.status} ${await res.text()}`
			);
		}
		const raw = (await res.json()) as {
			result?: { rows?: SearchTermPopularityRow[] };
		};
		return { rateLimit, raw, rows: raw.result?.rows ?? [] };
	}

	/**
	 * Keywords Apple associates with this app, for discovery.
	 *
	 * Scoped to a promoted app rather than to a genre, which is what makes the
	 * answers relevant without any classification of our own: the genre top-500
	 * sorted by popularity is nine parts competitor brand name. Seeded with a
	 * term we already track, Apple returns the near variants of it that nobody
	 * thought to add.
	 *
	 * `popularity` here is relevance to the app, not search volume. See
	 * KeywordSuggestionRow.
	 */
	async keywordSuggestions(q: KeywordSuggestionQuery): Promise<{
		rows: KeywordSuggestionRow[];
		raw: unknown;
		rateLimit: AdsRateLimit;
	}> {
		const body = {
			filters: [
				{
					field: "promotedObjectId",
					operator: "EQUALS",
					value: [q.promotedObjectId],
				},
				// Required alongside the id; omitting either earns a 400 carrying
				// MISSING_REQUIRED_FILTER.
				{
					field: "promotedObjectType",
					operator: "EQUALS",
					value: ["APPSTORE_APP"],
				},
				...(q.countriesOrRegions?.length
					? [
							{
								field: "countriesOrRegions",
								operator: "IN",
								value: q.countriesOrRegions,
							},
						]
					: []),
				...(q.terms?.length
					? [{ field: "terms", operator: "IN", value: q.terms }]
					: []),
			],
			// No `sorting`. Apple's own discussion says to sort by popularity, and
			// the API answers `INVALID_FIELD_ATTRIBUTE ... 'popularity' is not
			// queryable`.
			pagination: { offset: q.offset ?? 0, pageSize: q.limit ?? 500 },
		};
		const res = await fetch(`${API_BASE}/v1/suggestions/keywords/query`, {
			body: JSON.stringify(body),
			headers: await this.#headers(),
			method: "POST",
		});
		const rateLimit = readRateLimit(res.headers);
		const refused = rateLimitGuard(res, rateLimit);
		if (refused) {
			throw refused;
		}
		if (!res.ok) {
			throw new Error(
				`Ads keyword suggestions failed: ${res.status} ${await res.text()}`
			);
		}
		// This endpoint returns `result` as the array itself, where the insights
		// ones wrap rows in `result.rows`. Accept both rather than guess: the
		// wrong guess yields an empty list, which reads as "Apple knows none".
		const raw = (await res.json()) as {
			result?: KeywordSuggestionRow[] | { rows?: KeywordSuggestionRow[] };
		};
		const { result } = raw;
		return {
			rateLimit,
			raw,
			rows: Array.isArray(result) ? result : (result?.rows ?? []),
		};
	}

	/**
	 * Discover the ad accounts this API user may act on, for the X-AP-Context
	 * header every other endpoint requires.
	 *
	 * `/v1/acls` is the documented discovery call, one of only two endpoints
	 * that work without X-AP-Context, and it returns the granted roles beside
	 * each account. `/v1/ad-accounts` answers 404 RESOURCE_NOT_FOUND when the
	 * user holds no grant, which is indistinguishable from a wrong URL; the ACL
	 * response says *why*, so it is worth preferring even though both exist.
	 */
	static async listAdAccounts(creds: AdsCredentials): Promise<{
		accounts: AdAccountAcl[];
		raw: unknown;
	}> {
		const token = await fetchAdsAccessToken(creds);
		const res = await fetch(`${API_BASE}/v1/acls`, {
			headers: { Authorization: `Bearer ${token.accessToken}` },
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Ads acls failed: ${res.status} ${body.slice(0, 200)}`);
		}
		// The live API wraps the payload in `result`; Apple's generated SDK models
		// it bare, and other endpoints use `data`. Accept all three. Guessing one
		// yields an empty list, which reads as "no access granted" and sends you
		// hunting a permissions problem that does not exist.
		const raw = (await res.json()) as {
			result?: { acls?: RawAcl[] };
			data?: { acls?: RawAcl[] };
			acls?: RawAcl[];
		};
		const acls = raw.result?.acls ?? raw.data?.acls ?? raw.acls ?? [];
		return {
			accounts: acls.flatMap((a) =>
				a.adAccount?.id === undefined
					? []
					: [
							{
								id: String(a.adAccount.id),
								name: a.adAccount.name ?? null,
								orgId:
									a.adAccount.orgId === undefined
										? null
										: String(a.adAccount.orgId),
								roles: a.roles ?? [],
							},
						]
			),
			raw,
		};
	}
}
