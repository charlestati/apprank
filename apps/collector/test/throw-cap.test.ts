import { describe, it, expect } from "vitest";

import { retryAfterThrow, unitParams } from "../src/scheduler";
import { TERM_CHUNK } from "../src/tasks/ads";
import type { Task } from "../src/tasks/types";

const BROKE = "normaliser exploded";
const DEPLOYED = "Durable Object reset because its code was updated.";

/** The third consecutive throw: the one that gives up the head unit. */
function capped(task: Task): Task[] {
	return retryAfterThrow({ ...task, threw: 2 }, BROKE);
}

const discover: Extract<Task, { type: "ads_discover" }> = {
	appAdamId: "424242",
	appId: 424_242,
	language: "fr",
	localeCode: "fr-FR",
	rest: ["second seed", "third seed"],
	seed: "first seed",
	storefront: "fr",
	type: "ads_discover",
	userId: "admin",
};

const terms = Array.from({ length: TERM_CHUNK + 5 }, (_, i) => `term ${i}`);

describe(retryAfterThrow, () => {
	it("puts the task back with one more throw while under the cap", () => {
		const task: Task = { attempt: 2, date: "2026-08-30", type: "compact" };
		expect(retryAfterThrow(task, BROKE)).toStrictEqual([{ ...task, threw: 1 }]);
		expect(retryAfterThrow({ ...task, threw: 1 }, BROKE)).toStrictEqual([
			{ ...task, threw: 2 },
		]);
	});

	it("retries a deploy restart as it was, without spending a throw", () => {
		const task: Task = {
			queue: [{ appId: 1, storefront: "fr" }],
			threw: 2,
			type: "review_pull",
		};
		expect(retryAfterThrow(task, DEPLOYED)).toStrictEqual([task]);
	});

	it.each([
		{
			task: {
				queue: [
					{ appId: 1, localeCode: "fr-FR", storefront: "fr" },
					{ appId: 2, localeCode: "fr-FR", storefront: "fr" },
				],
				type: "lookup_pull",
			},
			type: "lookup_pull",
		},
		{
			task: {
				queue: [
					{ appId: 1, storefront: "fr" },
					{ appId: 2, storefront: "fr" },
				],
				type: "review_pull",
			},
			type: "review_pull",
		},
		{
			task: {
				queue: [
					{ chart: "free", genreId: null, storefront: "fr" },
					{ chart: "paid", genreId: null, storefront: "fr" },
				],
				type: "chart_pull",
			},
			type: "chart_pull",
		},
	] as { type: string; task: Task & { queue: unknown[] } }[])(
		"gives up only the head unit of a $type batch, with a fresh attempt count",
		({ task }) => {
			const [next] = capped({ ...task, attempt: 2 });
			expect(next).toMatchObject({ attempt: 0, type: task.type });
			expect(next && "queue" in next && next.queue).toStrictEqual(
				task.queue.slice(1)
			);
		}
	);

	it.each([
		{
			queue: [{ appId: 1, localeCode: "fr-FR", storefront: "fr" }],
			type: "lookup_pull",
		},
		{ queue: [{ appId: 1, storefront: "fr" }], type: "review_pull" },
		{
			queue: [{ chart: "free", genreId: null, storefront: "fr" }],
			type: "chart_pull",
		},
		{
			queue: [{ category: "GAMES", genreId: 6014, storefront: "fr" }],
			type: "ads_pull",
			weekStart: "2026-08-23",
		},
	] as Task[])(
		"leaves nothing behind when the last unit of a $type gives up",
		(task) => {
			expect(capped(task)).toStrictEqual([]);
		}
	);

	it("keeps the rest of an Ads genre pull for the same week", () => {
		const [next] = capped({
			attempt: 3,
			queue: [
				{ category: "GAMES", genreId: 6014, storefront: "fr" },
				{ category: "GAMES", genreId: 6014, storefront: "es" },
			],
			type: "ads_pull",
			verifyOnly: true,
			weekStart: "2026-08-23",
		});
		expect(next).toMatchObject({
			attempt: 0,
			queue: [{ category: "GAMES", genreId: 6014, storefront: "es" }],
			type: "ads_pull",
			verifyOnly: true,
			weekStart: "2026-08-23",
		});
	});

	it("gives up one chunk of an Ads terms pass and keeps the terms behind it", () => {
		const [next] = capped({
			attempt: 1,
			storefront: "fr",
			terms,
			type: "ads_terms",
			weekStart: "2026-08-23",
		});
		expect(next).toMatchObject({
			attempt: 0,
			storefront: "fr",
			terms: terms.slice(TERM_CHUNK),
			type: "ads_terms",
			weekStart: "2026-08-23",
		});
	});

	it("leaves nothing behind when the last chunk of an Ads terms pass gives up", () => {
		expect(
			capped({
				storefront: "fr",
				terms: terms.slice(0, TERM_CHUNK),
				type: "ads_terms",
				weekStart: "2026-08-23",
			})
		).toStrictEqual([]);
	});

	it("moves discovery on to the next seed when one seed keeps throwing", () => {
		const [next] = capped({ ...discover, attempt: 4 });
		expect(next).toMatchObject({
			...discover,
			attempt: 0,
			rest: ["third seed"],
			seed: "second seed",
		});
	});

	it.each([
		{
			queue: [
				{ category: "GAMES", genreId: 6014, storefront: "fr" },
				{ category: "GAMES", genreId: 6014, storefront: "es" },
			],
			type: "ads_pull",
			weekStart: "2026-08-23",
		},
		{ storefront: "fr", terms, type: "ads_terms", weekStart: "2026-08-23" },
		discover,
	] as Task[])(
		"gives the unit after a capped $type its own three throws",
		(task) => {
			const [next] = capped(task);
			expect(next?.threw ?? 0).toBe(0);
			expect(retryAfterThrow(next as Task, BROKE)).toHaveLength(1);
		}
	);

	it("ends discovery when the last seed gives up", () => {
		expect(capped({ ...discover, rest: [] })).toStrictEqual([]);
	});

	it.each([
		{ date: "2026-08-30", type: "compact" },
		{ stage: "init", type: "asc_poll" },
		{
			appId: "1",
			granularity: "DAILY",
			instanceId: "i-1",
			processingDate: "2026-08-30",
			report: { category: "APP_USAGE", name: "Installs", reportId: "r-1" },
			type: "asc_fetch_instance",
		},
	] as Task[])("drops a single-unit $type task at the cap", (task) => {
		expect(capped(task)).toStrictEqual([]);
	});
});

describe(unitParams, () => {
	it("names the head unit of a batch, the one that was lost", () => {
		expect(
			unitParams({
				queue: [
					{ appId: 7, localeCode: "fr-FR", storefront: "fr" },
					{ appId: 8, localeCode: "fr-FR", storefront: "fr" },
				],
				type: "lookup_pull",
			})
		).toStrictEqual({
			params: JSON.stringify({
				appId: 7,
				localeCode: "fr-FR",
				storefront: "fr",
			}),
		});
		expect(
			unitParams({
				queue: [{ category: "GAMES", genreId: 6014, storefront: "fr" }],
				type: "ads_pull",
				weekStart: "2026-08-23",
			})
		).toStrictEqual({
			params: JSON.stringify({
				category: "GAMES",
				genreId: 6014,
				storefront: "fr",
			}),
		});
	});

	it("records null rather than nothing for an empty batch", () => {
		expect(unitParams({ queue: [], type: "review_pull" })).toStrictEqual({
			params: "null",
		});
	});

	it("names the storefront and the size of the chunk an Ads terms pass lost", () => {
		const base = {
			storefront: "fr",
			type: "ads_terms",
			weekStart: "2026-08-23",
		};
		expect(unitParams({ ...base, terms } as Task)).toStrictEqual({
			params: `fr/${TERM_CHUNK} terms`,
		});
		expect(
			unitParams({ ...base, terms: ["one", "two"] } as Task)
		).toStrictEqual({ params: "fr/2 terms" });
	});

	it("names the seed and storefront discovery lost", () => {
		expect(unitParams(discover)).toStrictEqual({
			params: JSON.stringify({ seed: "first seed", storefront: "fr" }),
		});
	});

	it("names the day a compaction lost", () => {
		expect(unitParams({ date: "2026-08-30", type: "compact" })).toStrictEqual({
			params: "2026-08-30",
		});
	});

	it("records no params for an App Store Connect poll, which has no unit", () => {
		expect(unitParams({ type: "asc_poll" })).toStrictEqual({});
	});
});
