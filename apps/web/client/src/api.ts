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
	result_count: number;
	position: number | null;
	app_id: number | null;
}

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
	errorsLast24h: {
		errorClass: string;
		endpoint: string;
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

export interface SeriesPoint {
	date: string;
	position: number | null;
}

/** One release and the fields it touched: what a chart marker actually marks. */
export interface MetadataMarker {
	date: string;
	version: string | null;
	changed: string[];
}

/** A day the crawl failed: the reason a hole in a series is a hole. */
export interface SeriesError {
	date: string;
	errorClass: string;
	count: number;
}

export interface TopResult {
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

export interface SearchResultRow {
	position: number;
	appId: number;
	name: string | null;
	developer: string | null;
	iconUrl: string | null;
}

export interface ResultPage {
	date: string | null;
	resultCount: number;
	results: SearchResultRow[];
}

export type Opportunity =
	| "winning"
	| "close"
	| "blocked"
	| "vanity"
	| "dormant"
	| "unknown";

/** Whether Apple published a volume for a term. Absent is not zero. */
export type PopularityStatus = "measured" | "absent" | "unqueried";

export interface KeywordVerdict {
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
	history: (pairId: number, appId: number, days = 90) =>
		get<HistoryPoint[]>(`/pairs/${pairId}/history?appId=${appId}&days=${days}`),
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
};
