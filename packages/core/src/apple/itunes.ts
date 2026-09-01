// Public iTunes/App Store endpoints. Unauthenticated, IP-rate-limited
// (~20/min documented; effective budget discovered empirically by the
// scheduler). Critical failure mode: throttling returns HTTP 403 with an empty
// results array — a 403 must NEVER be persisted as an observation.

export interface ITunesResult {
	trackId: number;
	trackName?: string;
	bundleId?: string;
	artistId?: number;
	artistName?: string;
	primaryGenreId?: number;
	genreIds?: string[];
	version?: string;
	price?: number;
	currency?: string;
	description?: string;
	releaseNotes?: string;
	averageUserRating?: number;
	userRatingCount?: number;
	averageUserRatingForCurrentVersion?: number;
	userRatingCountForCurrentVersion?: number;
	screenshotUrls?: string[];
	artworkUrl512?: string;
	artworkUrl100?: string;
	[key: string]: unknown;
}

export interface ITunesResponse {
	resultCount: number;
	results: ITunesResult[];
}

/** 'fr-FR' → 'fr_FR' (iTunes lang parameter). */
export function localeToLang(localeCode: string): string {
	// Bare codes like 'it' pass through unchanged.
	return localeCode.replace("-", "_");
}

export function searchUrl(
	term: string,
	storefront: string,
	localeCode: string,
	limit = 200
): string {
	const p = new URLSearchParams({
		country: storefront,
		entity: "software",
		lang: localeToLang(localeCode),
		limit: String(limit),
		media: "software",
		term,
	});
	return `https://itunes.apple.com/search?${p}`;
}

export function lookupUrl(
	appId: number,
	storefront: string,
	localeCode?: string
): string {
	const p = new URLSearchParams({ country: storefront, id: String(appId) });
	if (localeCode) {
		p.set("lang", localeToLang(localeCode));
	}
	return `https://itunes.apple.com/lookup?${p}`;
}

/** Customer reviews RSS: 10 pages × 50 reviews max per storefront. */
export function reviewsRssUrl(
	appId: number,
	storefront: string,
	page = 1
): string {
	return `https://itunes.apple.com/${storefront}/rss/customerreviews/page=${page}/sortby=mostrecent/id=${appId}/json`;
}

/** Legacy iTunes RSS charts — the only public source with genre + grossing. */
export function chartRssUrl(
	storefront: string,
	chart: "free" | "paid" | "grossing",
	genreId?: number,
	limit = 100
): string {
	const feeds = {
		free: "topfreeapplications",
		grossing: "topgrossingapplications",
		paid: "toppaidapplications",
	} as const;
	const feed = feeds[chart];
	const genre = genreId ? `/genre=${genreId}` : "";
	return `https://itunes.apple.com/${storefront}/rss/${feed}/limit=${limit}${genre}/json`;
}

export type FetchOutcome =
	| {
			kind: "ok";
			status: number;
			json: unknown;
			responseMs: number;
			bodyText: string;
	  }
	| { kind: "throttled"; status: number; responseMs: number; bodyText: string }
	| { kind: "error"; status: number; responseMs: number; bodyText: string };

/**
 * Fetch + classify. 403 and 429 are throttling regardless of body content;
 * an empty result set is only trustworthy on a genuine 200.
 */
export async function fetchClassified(url: string): Promise<FetchOutcome> {
	const started = Date.now();
	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			"User-Agent":
				"AppRankCollector/0.2 (open-source ASO tracker; polite: ~4 req/min, backs off on 429)",
		},
	});
	const responseMs = Date.now() - started;
	const bodyText = await res.text();
	if (res.status === 403 || res.status === 429) {
		return { bodyText, kind: "throttled", responseMs, status: res.status };
	}
	if (!res.ok) {
		return { kind: "error", status: res.status, responseMs, bodyText };
	}
	try {
		return {
			bodyText,
			json: JSON.parse(bodyText),
			kind: "ok",
			responseMs,
			status: res.status,
		};
	} catch {
		return { bodyText, kind: "error", responseMs, status: res.status };
	}
}
