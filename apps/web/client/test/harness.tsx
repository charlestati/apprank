// Shared client-test helpers: a routing table for the stubbed `fetch` and
// neutral fixtures. Nothing here talks to a real server.

import { vi } from "vitest";

import type {
	CompetitorPoint,
	DataHealth,
	HistoryPoint,
	KeywordCell,
	Review,
	Suggestion,
	TrackedApp,
} from "../src/api";

export const APP_ID = 424_242;
export const RIVAL_ID = 515_151;

export const trackedApp: TrackedApp = {
	current_name: "Tracked App",
	developer_name: "Example Developer",
	id: APP_ID,
	primary_genre_id: 6002,
};

/**
 * A route table keyed by a path suffix ("keywords", "/api/apps"), matched
 * against the request path with the query string stripped. `"*"` matches
 * anything.
 */
export type Routes = Record<string, unknown>;

/**
 * Replaces `globalThis.fetch`. A route value that is a `Response` is returned
 * as-is (for error-path tests); anything else is serialised as JSON. Requests
 * matching no route resolve to 404 so a forgotten stub fails loudly. The
 * returned array records every URL requested, in order.
 */
export function stubFetch(routes: Routes): string[] {
	const calls: string[] = [];
	const impl = (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const path = url.split("?")[0] ?? url;
		for (const [pattern, value] of Object.entries(routes)) {
			if (pattern === "*" || path.endsWith(pattern)) {
				return Promise.resolve(
					value instanceof Response ? value.clone() : Response.json(value)
				);
			}
		}
		return Promise.resolve(new Response("not found", { status: 404 }));
	};
	vi.stubGlobal("fetch", vi.fn(impl));
	return calls;
}

export function keywordCell(over: Partial<KeywordCell> = {}): KeywordCell {
	return {
		keyword: "example keyword",
		keyword_id: 1,
		locale_code: "fr-FR",
		observed_date: "2026-01-10",
		pair_id: 1,
		popularity: null,
		rank: null,
		storefront_code: "fr",
		...over,
	};
}

export function historyPoint(over: Partial<HistoryPoint> = {}): HistoryPoint {
	return {
		app_id: APP_ID,
		observed_date: "2026-01-01",
		position: 10,
		result_count: 200,
		...over,
	};
}

export function competitorPoint(
	over: Partial<CompetitorPoint> = {}
): CompetitorPoint {
	return {
		app_id: RIVAL_ID,
		current_name: "Rival App",
		observed_date: "2026-01-01",
		position: 1,
		...over,
	};
}

export function review(over: Partial<Review> = {}): Review {
	return {
		app_version: "1.2.0",
		author: "Reviewer One",
		body: "A neutral review body.",
		id: "review-1",
		rating: 4,
		reviewed_at: Date.UTC(2026, 0, 10),
		storefront_code: "fr",
		title: "Solid",
		...over,
	};
}

export function suggestion(over: Partial<Suggestion> = {}): Suggestion {
	return {
		created_at: 1000,
		id: 1,
		payload: '{"keyword":"example keyword"}',
		status: "pending",
		type: "promote_keyword",
		...over,
	};
}

export function dataHealth(over: Partial<DataHealth> = {}): DataHealth {
	return {
		ascAnomalies: [],
		cadence: {
			capacity: { keywordsPerDay: 600, overheadPerDay: 120, totalPerDay: 720 },
			fastCount: 10,
			fastDays: 1,
			loadPerDay: 10,
			pairs: 10,
			saturated: false,
			slowDays: 1,
			summary: "All 10 pairs checked daily.",
		},
		collectedToday: 8,
		date: "2026-01-10",
		errorsLast24h: [],
		lastDailyRun: {
			finishedAt: Date.now() - 3_500_000,
			ok: true,
			queued: 4,
			startedAt: Date.now() - 3_600_000,
			trigger: "cron",
		},
		loop: { at: Date.now(), didWork: true, queued: 0 },
		overduePairs: 0,
		pacing: { lastErrorAt: 0, pauseUntil: 0, ratePerMin: 12 },
		tier1Pairs: 10,
		...over,
	};
}
