// Shared client-test helpers: a routing table for the stubbed `fetch` and
// neutral fixtures. Nothing here talks to a real server.

import { fireEvent, screen, within } from "@testing-library/dom";
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
	// Preferences are cached in localStorage as well as stored server-side, and
	// the cache outlives a render. Without this, a test that ticks a keyword onto
	// the chart restores that selection in the next test, which is correct
	// behaviour in a browser and a hidden dependency between test cases here.
	try {
		localStorage.clear();
	} catch {
		// No storage in this environment; nothing to reset.
	}
	const calls: string[] = [];
	const impl = (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const path = url.split("?")[0] ?? url;
		for (const [pattern, value] of Object.entries(routes)) {
			if (pattern === "*" || path.endsWith(pattern)) {
				// A promise is awaited rather than resolved here, which is how a test
				// holds a response in flight and decides when it lands. What it
				// resolves to is handled the same way as a synchronous route, because
				// `unknown` narrowed by `instanceof Promise` says nothing about its
				// payload: asserting one would be a cast standing in for a check.
				if (value instanceof Promise) {
					return (async () => {
						const resolved: unknown = await value;
						return resolved instanceof Response
							? resolved.clone()
							: Response.json(resolved);
					})();
				}
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

/**
 * Drives a Base UI select: open the listbox, then pick the option by its text.
 *
 * The trigger is a combobox button and the list is portalled, so `fireEvent
 * .change` has nothing to change and a query scoped to the render container
 * cannot see the options. The listbox is opened with the key a keyboard user
 * would press, because happy-dom's synthetic pointer events do not carry
 * enough for the trigger's own press handling.
 */
export function chooseOption(controlName: string | RegExp, option: string) {
	const trigger = screen.getByLabelText(controlName);
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
	fireEvent.keyUp(trigger, { key: "ArrowDown" });
	const item = within(screen.getByRole("listbox")).getByRole("option", {
		name: option,
	});
	fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
	fireEvent.mouseDown(item, { button: 0 });
	fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
	fireEvent.mouseUp(item, { button: 0 });
	fireEvent.click(item, { button: 0 });
}
