/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	lookupPullStep,
	reviewPullStep,
	chartPullStep,
	compactStep,
} from "../src/tasks/pulls";
import { stubFetch } from "./helpers";

const APP_ID = 424_242;

function lookupResponse(overrides: Record<string, unknown> = {}) {
	return {
		resultCount: 1,
		results: [
			{
				artistId: 900,
				artistName: "Tracked Dev",
				averageUserRating: 4.5,
				bundleId: "test.app",
				currency: "EUR",
				description: "A description",
				genreIds: ["7019"],
				price: 0,
				primaryGenreId: 7019,
				trackId: APP_ID,
				trackName: "Tracked App",
				userRatingCount: 70,
				version: "1.2.1",
				...overrides,
			},
		],
	};
}

function reviewFeed(count: number) {
	return {
		feed: {
			entry: [
				// Apple's feed leads with the app itself; it carries no im:rating.
				{ id: { label: "app-entry" }, title: { label: "Tracked App" } },
				...Array.from({ length: count }, (_, i) => ({
					author: { name: { label: `Author ${i}` } },
					content: { label: `Body ${i}` },
					id: { label: `r${i}` },
					"im:rating": { label: String(1 + (i % 5)) },
					"im:version": { label: "1.2.1" },
					title: { label: `Title ${i}` },
					updated: { label: "2026-08-30T12:00:00-07:00" },
				})),
			],
		},
	};
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM fetch_error"),
		env.DB.prepare("DELETE FROM review"),
		env.DB.prepare("DELETE FROM rating_snapshot"),
		env.DB.prepare("DELETE FROM chart_ranking"),
		env.DB.prepare("DELETE FROM app_metadata_version"),
		env.DB.prepare("DELETE FROM crawl_pair"),
		env.DB.prepare("DELETE FROM tracked_keyword"),
		env.DB.prepare("DELETE FROM tracked_app"),
		env.DB.prepare("DELETE FROM app"),
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Apple's throttle signature: 403 carrying an empty result set. */
function throttle() {
	stubFetch(() =>
		Response.json({ resultCount: 0, results: [] }, { status: 403 })
	);
}

describe("throttled batch pulls", () => {
	const units = [
		{ appId: APP_ID, localeCode: "fr-CA", storefront: "ca" },
		{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" },
	];

	it("retries the same unit in place while a throttle may be transient", async () => {
		throttle();
		const r = await lookupPullStep(env, { queue: units });
		expect(r.throttled).toBeTruthy();
		const next = r.followUps[0] as { queue: typeof units; attempt: number };
		expect(next.queue[0]?.storefront).toBe("ca");
		expect(next.attempt).toBe(1);
	});

	it("rotates the failing unit to the back so the rest get their turn", async () => {
		throttle();
		// Second consecutive throttle on the same head unit: yield the place.
		const r = await lookupPullStep(env, { queue: units, attempt: 1 });
		const next = r.followUps[0] as { queue: typeof units };
		expect(next.queue.map((u) => u.storefront)).toStrictEqual(["fr", "ca"]);
	});

	it("abandons the batch for the day once every unit has had its turn", async () => {
		throttle();
		// 2 units × 2 attempts each: the next attempt has nowhere left to go.
		const r = await lookupPullStep(env, { queue: units, attempt: 3 });
		expect(r.throttled).toBeTruthy();
		// Still throttled, so pacing still backs off — but the queue is not
		// handed back, or tomorrow's fresh copy would stack on a wedged one.
		expect(r.followUps).toStrictEqual([]);
		const row = await env.DB.prepare(
			"SELECT error_class, params FROM fetch_error WHERE error_class = 'pull_abandoned'"
		).first<{ error_class: string; params: string }>();
		expect(row?.error_class).toBe("pull_abandoned");
		expect(JSON.parse(row?.params ?? "{}")).toStrictEqual({
			attempts: 4,
			units: 2,
		});
	});

	it("never rotates a single-unit queue, it just retries then abandons", async () => {
		throttle();
		const one = [units[0] as (typeof units)[number]];
		const first = await lookupPullStep(env, { queue: one });
		expect(first.followUps).toHaveLength(1);
		const last = await lookupPullStep(env, { queue: one, attempt: 1 });
		expect(last.followUps).toStrictEqual([]);
	});

	it("rotates review and chart batches the same way", async () => {
		throttle();
		const reviews = await reviewPullStep(env, {
			attempt: 1,
			queue: [
				{ appId: APP_ID, storefront: "ca" },
				{ appId: APP_ID, storefront: "fr" },
			],
		});
		expect(
			(reviews.followUps[0] as { queue: { storefront: string }[] }).queue[0]
				?.storefront
		).toBe("fr");

		const charts = await chartPullStep(env, {
			attempt: 1,
			queue: [
				{ chart: "free" as const, genreId: null, storefront: "ca" },
				{ chart: "free" as const, genreId: null, storefront: "fr" },
			],
		});
		expect(
			(charts.followUps[0] as { queue: { storefront: string }[] }).queue[0]
				?.storefront
		).toBe("fr");
	});
});

describe(lookupPullStep, () => {
	it("returns nothing when the queue is empty", async () => {
		const r = await lookupPullStep(env, { queue: [] });
		expect(r).toStrictEqual({ followUps: [], throttled: false });
	});

	it("writes the app dimension, a metadata version and a rating snapshot", async () => {
		stubFetch(() => Response.json(lookupResponse()));
		const r = await lookupPullStep(env, {
			queue: [{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" }],
		});
		expect(r.throttled).toBeFalsy();
		expect(r.followUps).toStrictEqual([]);

		const app = await env.DB.prepare("SELECT * FROM app WHERE id = ?")
			.bind(APP_ID)
			.first<{ current_name: string }>();
		expect(app?.current_name).toBe("Tracked App");

		const versions = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM app_metadata_version WHERE app_id = ?"
		)
			.bind(APP_ID)
			.first<{ n: number }>();
		expect(versions?.n).toBe(1);

		const rating = await env.DB.prepare(
			"SELECT rating_count, rating_avg FROM rating_snapshot WHERE app_id = ?"
		)
			.bind(APP_ID)
			.first<{ rating_count: number; rating_avg: number }>();
		expect(rating).toStrictEqual({ rating_avg: 4.5, rating_count: 70 });
	});

	it("keeps one metadata version per change, not per sighting", async () => {
		stubFetch(() => Response.json(lookupResponse()));
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		await lookupPullStep(env, { queue: [unit] });
		await lookupPullStep(env, { queue: [unit] });
		const versions = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM app_metadata_version WHERE app_id = ?"
		)
			.bind(APP_ID)
			.first<{ n: number }>();
		expect(versions?.n).toBe(1);
	});

	it("bursts the crawl cadence for 14 days after a tracked app's metadata changes", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (1, 'kw', 'kw', 'fr')"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 0, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT OR IGNORE INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES ('admin', ?, 1, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT OR IGNORE INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 168, 0)"
			),
		]);
		stubFetch(() => Response.json(lookupResponse({ trackName: "Renamed" })));
		await lookupPullStep(env, {
			queue: [{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" }],
		});
		const pair = await env.DB.prepare(
			"SELECT burst_until, interval_hours FROM crawl_pair WHERE id = 1"
		).first<{ burst_until: number; interval_hours: number }>();
		expect(pair?.interval_hours).toBe(24);
		expect(pair?.burst_until).toBeGreaterThan(Date.now());
	});

	it("records an absent app rather than inventing a row", async () => {
		stubFetch(() => Response.json({ resultCount: 0, results: [] }));
		await lookupPullStep(env, {
			queue: [{ appId: APP_ID, localeCode: "nl-NL", storefront: "nl" }],
		});
		const err = await env.DB.prepare(
			"SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<{ error_class: string }>();
		expect(err?.error_class).toBe("app_not_in_storefront");
		const app = await env.DB.prepare("SELECT id FROM app WHERE id = ?")
			.bind(APP_ID)
			.first();
		expect(app).toBeNull();
	});

	it("requeues the whole queue and reports throttling on a 403", async () => {
		stubFetch(() => Response.json({}, { status: 403 }));
		const queue = [
			{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" },
			{ appId: APP_ID, localeCode: "en-CA", storefront: "ca" },
		];
		const r = await lookupPullStep(env, { queue });
		expect(r.throttled).toBeTruthy();
		expect(r.followUps).toHaveLength(1);
		expect(r.followUps[0]).toMatchObject({ attempt: 1, type: "lookup_pull" });
	});

	it("drops only the failing unit on a server error", async () => {
		stubFetch(() => new Response("boom", { status: 500 }));
		const r = await lookupPullStep(env, {
			queue: [
				{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" },
				{ appId: APP_ID, localeCode: "en-CA", storefront: "ca" },
			],
		});
		expect(r.throttled).toBeFalsy();
		expect(r.followUps).toHaveLength(1);
		const err = await env.DB.prepare(
			"SELECT error_class FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<{ error_class: string }>();
		expect(err?.error_class).toBe("http_error");
	});
});

describe(reviewPullStep, () => {
	it("stores reviews idempotently and skips the app entry", async () => {
		stubFetch(() => Response.json(reviewFeed(3)));
		const unit = { appId: APP_ID, storefront: "fr" };
		await reviewPullStep(env, { queue: [unit] });
		await reviewPullStep(env, { queue: [unit] });
		const rows = await env.DB.prepare(
			"SELECT id, rating, author FROM review ORDER BY id"
		).all<{ id: string; rating: number; author: string }>();
		expect(rows.results).toHaveLength(3);
		expect(rows.results[0]?.id).toBe("fr-r0");
		expect(rows.results[0]?.rating).toBe(1);
	});

	it("handles a feed with no reviews at all", async () => {
		stubFetch(() => Response.json({ feed: { entry: { id: { label: "x" } } } }));
		const r = await reviewPullStep(env, {
			queue: [{ appId: APP_ID, storefront: "lu" }],
		});
		expect(r.throttled).toBeFalsy();
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM review"
		).first<{
			n: number;
		}>();
		expect(rows?.n).toBe(0);
	});

	it("returns nothing for an empty queue", async () => {
		await expect(reviewPullStep(env, { queue: [] })).resolves.toStrictEqual({
			followUps: [],
			throttled: false,
		});
	});

	it("reports throttling and requeues", async () => {
		stubFetch(() => new Response("", { status: 429 }));
		const r = await reviewPullStep(env, {
			queue: [{ appId: APP_ID, storefront: "fr" }],
		});
		expect(r.throttled).toBeTruthy();
		expect(r.followUps[0]).toMatchObject({ type: "review_pull" });
	});

	it("records a server error and moves on", async () => {
		stubFetch(() => new Response("", { status: 503 }));
		const r = await reviewPullStep(env, {
			queue: [
				{ appId: APP_ID, storefront: "fr" },
				{ appId: APP_ID, storefront: "be" },
			],
		});
		expect(r.throttled).toBeFalsy();
		expect(r.followUps).toHaveLength(1);
	});
});

describe(chartPullStep, () => {
	const chartFeed = {
		feed: {
			entry: [
				{ id: { attributes: { "im:id": "111" } } },
				{ id: { attributes: { "im:id": "222" } } },
			],
		},
	};

	it("stores the ordered chart with its source endpoint", async () => {
		stubFetch(() => Response.json(chartFeed));
		await chartPullStep(env, {
			queue: [{ chart: "free", genreId: 7019, storefront: "fr" }],
		});
		const row = await env.DB.prepare(
			"SELECT result_ids, source, http_status FROM chart_ranking LIMIT 1"
		).first<{ result_ids: string; source: string; http_status: number }>();
		expect(JSON.parse(row?.result_ids ?? "[]")).toStrictEqual([111, 222]);
		expect(row?.source).toBe("itunes-rss");
		expect(row?.http_status).toBe(200);
	});

	it("updates the storefront-wide chart instead of appending a duplicate", async () => {
		// genre_id IS NULL for the whole-storefront chart, and SQLite counts every
		// NULL as distinct in a UNIQUE index — so the ordinary conflict target
		// never matched and each pull appended a row. Alarms are at-least-once, so
		// a second run is the normal case, not an edge one.
		stubFetch(() => Response.json(chartFeed));
		const unit = { chart: "free" as const, genreId: null, storefront: "fr" };
		await chartPullStep(env, { queue: [unit] });
		stubFetch(() =>
			Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "333" } } }] },
			})
		);
		await chartPullStep(env, { queue: [unit] });

		const rows = await env.DB.prepare(
			"SELECT result_ids FROM chart_ranking WHERE storefront_code='fr' AND genre_id IS NULL AND chart='free'"
		).all<{ result_ids: string }>();
		expect(rows.results).toHaveLength(1);
		expect(JSON.parse(rows.results[0]?.result_ids ?? "[]")).toStrictEqual([
			333,
		]);
	});

	it("accepts a single-entry feed that is not an array", async () => {
		stubFetch(() =>
			Response.json({
				feed: { entry: { id: { attributes: { "im:id": "9" } } } },
			})
		);
		await chartPullStep(env, {
			queue: [{ chart: "grossing", genreId: null, storefront: "be" }],
		});
		const row = await env.DB.prepare(
			"SELECT result_ids FROM chart_ranking WHERE storefront_code = 'be'"
		).first<{ result_ids: string }>();
		expect(JSON.parse(row?.result_ids ?? "[]")).toStrictEqual([9]);
	});

	it("returns nothing for an empty queue", async () => {
		await expect(chartPullStep(env, { queue: [] })).resolves.toStrictEqual({
			followUps: [],
			throttled: false,
		});
	});

	it("reports throttling and requeues the queue unchanged", async () => {
		stubFetch(() => new Response("", { status: 403 }));
		const r = await chartPullStep(env, {
			queue: [{ chart: "paid", genreId: null, storefront: "fr" }],
		});
		expect(r.throttled).toBeTruthy();
		expect(r.followUps[0]).toMatchObject({ attempt: 1, type: "chart_pull" });
	});

	it("records a server error and continues with the rest", async () => {
		stubFetch(() => new Response("", { status: 500 }));
		const r = await chartPullStep(env, {
			queue: [
				{ chart: "free", genreId: null, storefront: "fr" },
				{ chart: "paid", genreId: null, storefront: "fr" },
			],
		});
		expect(r.followUps).toHaveLength(1);
		const err = await env.DB.prepare(
			"SELECT endpoint FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<{ endpoint: string }>();
		expect(err?.endpoint).toBe("itunes:charts");
	});
});

describe(compactStep, () => {
	it("merges a day's staged observations into one NDJSON file per storefront", async () => {
		const date = "2026-08-30";
		await env.ARCHIVE.put(
			`staging/rankings/${date}/1.json`,
			JSON.stringify({ pairId: 1, storefront: "fr" })
		);
		await env.ARCHIVE.put(
			`staging/rankings/${date}/2.json`,
			JSON.stringify({ pairId: 2, storefront: "fr" })
		);
		await env.ARCHIVE.put(
			`staging/rankings/${date}/3.json`,
			JSON.stringify({ pairId: 3, storefront: "be" })
		);

		const followUps = await compactStep(env, { date });
		expect(followUps).toStrictEqual([]);

		const fr = await env.ARCHIVE.get(`rankings/v1/2026-08/fr/${date}.ndjson`);
		const frText = await fr?.text();
		expect(frText?.trim().split("\n")).toHaveLength(2);
		const be = await env.ARCHIVE.get(`rankings/v1/2026-08/be/${date}.ndjson`);
		const beText = await be?.text();
		expect(beText?.trim().split("\n")).toHaveLength(1);
	});

	it("is a no-op when nothing was staged", async () => {
		const followUps = await compactStep(env, { date: "2026-01-01" });
		expect(followUps).toStrictEqual([]);
		const out = await env.ARCHIVE.get(
			"rankings/v1/2026-01/fr/2026-01-01.ndjson"
		);
		expect(out).toBeNull();
	});

	it("files observations with no storefront under 'unknown' rather than dropping them", async () => {
		const date = "2026-08-29";
		await env.ARCHIVE.put(
			`staging/rankings/${date}/9.json`,
			JSON.stringify({ pairId: 9 })
		);
		await compactStep(env, { date });
		const out = await env.ARCHIVE.get(
			`rankings/v1/2026-08/unknown/${date}.ndjson`
		);
		expect(out).not.toBeNull();
	});
});
