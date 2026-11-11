export interface TrackedApp {
	id: number;
	current_name: string | null;
	developer_name: string | null;
	primary_genre_id: number | null;
}

export interface KeywordCell {
	keyword_id: number;
	keyword: string;
	pair_id: number;
	storefront_code: string;
	locale_code: string;
	observed_date: string | null;
	rank: number | null;
	popularity: number | null;
}

export interface HistoryPoint {
	observed_date: string;
	result_count: number | null;
	position: number | null;
	app_id: number | null;
}

/**
 * One pair's rank history, with what the chart needs to tell its states apart:
 * the days collection failed and the window that was asked for.
 */
export interface PairHistory {
	points: HistoryPoint[];
	fetchErrors: SeriesError[];
	/** Null when the server did not say; the caller then derives it. */
	window: { from: string; to: string } | null;
}

type HistoryBody =
	| HistoryPoint[]
	| {
			points: HistoryPoint[];
			fetchErrors?: SeriesError[];
			window?: { from: string; to: string };
	  };

export interface CompetitorPoint {
	observed_date: string;
	position: number;
	app_id: number;
	current_name: string | null;
}

export interface Review {
	id: string;
	storefront_code: string;
	rating: number | null;
	title: string | null;
	body: string | null;
	author: string | null;
	app_version: string | null;
	reviewed_at: number | null;
}

export interface DataHealth {
	date: string;
	tier1Pairs: number;
	collectedToday: number;
	lostLast24h: number;
	errorsLast24h: {
		/** Null on rows written before the class was a closed vocabulary. */
		errorClass: string | null;
		endpoint: string;
		loss: boolean;
		n: number;
		lastAt: number;
		message: string | null;
	}[];
	pacing: {
		ratePerMin: number;
		pauseUntil: number;
		lastErrorAt: number;
	} | null;
	loop: {
		at: number;
		queued: number;
		didWork: boolean;
		tasks?: Record<string, number>;
	} | null;
	lastDailyRun: {
		startedAt: number;
		finishedAt: number | null;
		ok: boolean | null;
		trigger: string;
		queued: number | null;
	} | null;
	overduePairs: number;
	ascAnomalies: {
		report_type: string;
		processing_date: string;
		anomaly: string;
	}[];
	cadence: {
		pairs: number;
		fastDays: number;
		slowDays: number;
		fastCount: number;
		loadPerDay: number;
		saturated: boolean;
		summary: string;
		capacity: {
			totalPerDay: number;
			overheadPerDay: number;
			keywordsPerDay: number;
		};
	} | null;
}

export interface Suggestion {
	id: number;
	type: string;
	payload: string;
	status: string;
	created_at: number;
}

export interface StorefrontOption {
	code: string;
	name: string;
	keywords: number;
}

interface SeriesPoint {
	date: string;
	position: number | null;
}

/** One release and the fields it touched: what a chart marker actually marks. */
export interface MetadataMarker {
	date: string;
	/** When the version was captured; two on one day differ only here. */
	capturedAt?: number;
	version: string | null;
	changed: string[];
}

/** A day the crawl failed: the reason a hole in a series is a hole. */
interface SeriesError {
	date: string;
	errorClass: string;
	count: number;
}

interface TopResult {
	position: number;
	appId: number;
	name: string;
	iconUrl: string | null;
}

export interface Difficulty {
	score: number;
	entrenchment: number;
	incumbentStrength: number;
	stability: number;
	saturation: number;
	sampleSize: number;
	formulaVersion: string;
}

interface SearchResultRow {
	position: number;
	appId: number;
	name: string | null;
	developer: string | null;
	iconUrl: string | null;
}

export interface ResultPage {
	date: string | null;
	/** Null on an observation stored before the count was recorded. */
	resultCount: number | null;
	results: SearchResultRow[];
}

type Opportunity =
	| "winning"
	| "close"
	| "blocked"
	| "vanity"
	| "dormant"
	| "unknown";

/** Whether Apple published a volume for a term. Absent is not zero. */
type PopularityStatus = "measured" | "absent" | "unqueried";

interface KeywordVerdict {
	opportunity: Opportunity;
	/** Stable key for the explanation, so the client renders it in its own language. */
	reasonKey?: string;
	/** Canonical English prose: the fallback when a key is unrecognised. */
	reason: string;
	unproven: boolean;
}

export interface KeywordRow {
	pairId: number;
	keywordId: number;
	keyword: string;
	position: number | null;
	points: SeriesPoint[];
	fetchErrors: SeriesError[];
	change: number | null;
	changeDaysAgo: number | null;
	best: number | null;
	worst: number | null;
	popularity: number | null;
	popularityStatus: PopularityStatus;
	resultCount: number | null;
	topResults: TopResult[];
	difficulty: Difficulty | null;
	resultCountChange: number | null;
	brand?: boolean;
	verdict?: KeywordVerdict;
}

export interface Report {
	storefront: string;
	days: number;
	dates: string[];
	/** The requested window; the chart spans this one slot per calendar day. */
	window: { from: string; to: string };
	metadataChanges: MetadataMarker[];
	insights: {
		winning: number;
		close: number;
		blocked: number;
		vanity: number;
		dormant: number;
		unknown: number;
		inTapZone: number;
		brandKeywords: number;
		genericKeywords: number;
		genericInTapZone: number;
		unmeasuredKeywords: number;
		unqueriedKeywords: number;
	};
	stats: {
		trackedKeywords: number;
		rankedKeywords: number;
		averageRank: number | null;
		averageRankChange: number | null;
		best: number | null;
		worst: number | null;
		distribution: {
			top5: number;
			top25: number;
			top100: number;
			beyond: number;
		};
		movement: { up: number; down: number; unchanged: number };
	};
	rows: KeywordRow[];
}

/** The payload the collector writes on a `promote_keyword` suggestion. */
export interface PromoteKeyword {
	term: string;
	seed: string;
	storefront: string;
	locale: string;
	language: string;
	relevance: number;
	appId: number;
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`/api${path}`);
	if (!res.ok) {
		throw new Error(`${res.status} ${path}`);
	}
	return res.json() as Promise<T>;
}

export const api = {
	apps: () => get<TrackedApp[]>("/apps"),
	me: () => get<{ userId: string }>("/me"),
	competitors: (pairId: number, days = 30) =>
		get<CompetitorPoint[]>(`/pairs/${pairId}/competitors?days=${days}`),
	health: () => get<DataHealth>("/health/data"),
	// The endpoint has answered with a bare array of points; the object form
	// adds the failed days and the window, and both are accepted so the client
	// works on either side of that change.
	history: async (
		pairId: number,
		appId: number,
		days = 90
	): Promise<PairHistory> => {
		const body = await get<HistoryBody>(
			`/pairs/${pairId}/history?appId=${appId}&days=${days}`
		);
		return Array.isArray(body)
			? { fetchErrors: [], points: body, window: null }
			: {
					fetchErrors: body.fetchErrors ?? [],
					points: body.points,
					window: body.window ?? null,
				};
	},
	keywords: (appId: number) => get<KeywordCell[]>(`/apps/${appId}/keywords`),
	report: (appId: number, storefront: string, days = 30) =>
		get<Report>(`/apps/${appId}/report?storefront=${storefront}&days=${days}`),
	results: (pairId: number) => get<ResultPage>(`/pairs/${pairId}/results`),
	reviews: (appId: number) => get<Review[]>(`/apps/${appId}/reviews`),
	reportCsvUrl: (appId: number, storefront: string, days: number) =>
		`/api/apps/${appId}/report.csv?storefront=${storefront}&days=${days}`,
	storefronts: (appId: number) =>
		get<StorefrontOption[]>(`/apps/${appId}/storefronts`),
	suggestions: () => get<Suggestion[]>("/suggestions"),
	/** Accepting promotes the keyword into the crawl; dismissing closes it. */
	answerSuggestion: async (id: number, status: "accepted" | "dismissed") => {
		const res = await fetch(`/api/suggestions/${id}`, {
			body: JSON.stringify({ status }),
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		});
		if (!res.ok) {
			throw new Error(`${res.status} /suggestions/${id}`);
		}
	},
};
