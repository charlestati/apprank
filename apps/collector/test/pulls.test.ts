/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { getState, setState } from "../src/lib/state";
import {
	lookupPullStep,
	reviewPullStep,
	chartPullStep,
	compactStep,
	chartMarker,
	compactMarker,
	lookupMarker,
	pulledOn,
	reviewMarker,
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
		// Only this file's own keys: collector_state also holds pacing, and the
		// files share one database.
		env.DB.prepare("DELETE FROM collector_state WHERE key LIKE 'pull:%'"),
	]);
});

const TODAY = new Date().toISOString().slice(0, 10);

afterEach(() => {
	vi.unstubAllGlobals();
});

/**
 * The bindings with an archive that refuses every write, the way R2 did on
 * 2026-09-11. A copy, never a spy on the shared binding: nothing to restore,
 * so a failed assertion cannot leave the next test without an archive.
 */
function refusingArchive(): typeof env {
	return {
		...env,
		ARCHIVE: new Proxy(env.ARCHIVE, {
			get(target, prop) {
				if (prop === "put") {
					return () =>
						Promise.reject(
							new Error(
								"We encountered an internal error. Please try again. (10001)"
							)
						);
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
}

async function rowCount(table: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

function lastError() {
	return env.DB.prepare(
		"SELECT endpoint, error_class, http_status, response_ms, message FROM fetch_error ORDER BY id DESC LIMIT 1"
	).first<{
		endpoint: string;
		error_class: string;
		http_status: number | null;
		response_ms: number | null;
		message: string | null;
	}>();
}

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
		// Still throttled, so pacing still backs off, but the queue is not handed
		// back, or tomorrow's fresh copy would stack on a wedged one.
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
		const before = Date.now();
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
		const fortnight = 14 * 24 * 3_600_000;
		expect(pair?.burst_until).toBeGreaterThan(before + fortnight - 1);
		expect(pair?.burst_until).toBeLessThanOrEqual(Date.now() + fortnight);
	});

	// `pnpm track` creates the app row before any lookup runs, with a name and
	// nothing else. The upsert used to update the name alone, so the genre
	// stayed null until the app surfaced in one of its own crawls, and a null
	// genre means no genre chart and no Ads pull.
	it("fills the genre, bundle id and developer on the bare row tracking created", async () => {
		await env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 5, 5)"
		)
			.bind(APP_ID)
			.run();
		stubFetch(() => Response.json(lookupResponse()));
		await lookupPullStep(env, {
			queue: [{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" }],
		});
		const app = await env.DB.prepare(
			"SELECT bundle_id, developer_id, developer_name, primary_genre_id, first_seen_at FROM app WHERE id = ?"
		)
			.bind(APP_ID)
			.first();
		expect(app).toStrictEqual({
			bundle_id: "test.app",
			developer_id: 900,
			developer_name: "Tracked Dev",
			first_seen_at: 5,
			primary_genre_id: 7019,
		});
	});

	it("leaves an app row alone when the lookup changes nothing in it", async () => {
		stubFetch(() => Response.json(lookupResponse()));
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		await lookupPullStep(env, { queue: [unit] });
		// A sentinel no real clock produces: any rewrite of the row replaces it.
		await env.DB.prepare("UPDATE app SET last_seen_at = 7 WHERE id = ?")
			.bind(APP_ID)
			.run();
		await lookupPullStep(env, { queue: [unit] });
		const app = await env.DB.prepare(
			"SELECT last_seen_at FROM app WHERE id = ?"
		)
			.bind(APP_ID)
			.first<{ last_seen_at: number }>();
		expect(app?.last_seen_at).toBe(7);
	});

	it("follows a genre change on a row it has already filled", async () => {
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		stubFetch(() => Response.json(lookupResponse()));
		await lookupPullStep(env, { queue: [unit] });
		vi.unstubAllGlobals();
		stubFetch(() => Response.json(lookupResponse({ primaryGenreId: 6014 })));
		await lookupPullStep(env, { queue: [unit] });
		const app = await env.DB.prepare(
			"SELECT primary_genre_id FROM app WHERE id = ?"
		)
			.bind(APP_ID)
			.first<{ primary_genre_id: number }>();
		expect(app?.primary_genre_id).toBe(6014);
	});

	it("derives nothing from a lookup whose archive did not land", async () => {
		stubFetch(() => Response.json(lookupResponse()));
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		await expect(
			lookupPullStep(refusingArchive(), { queue: [unit] })
		).rejects.toThrow(/archive did not persist/u);
		await expect(rowCount("rating_snapshot")).resolves.toBe(0);
		await expect(rowCount("app_metadata_version")).resolves.toBe(0);
		await expect(rowCount("app")).resolves.toBe(0);
		await expect(getState(env.DB, lookupMarker(unit))).resolves.toBeNull();
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

	// Apple's rate limit is a 403 carrying a well-formed, empty answer. Read as
	// an answer it says the app is not in this storefront, and marks the unit
	// done for the day.
	it("writes nothing from a 403, however well-formed its empty body", async () => {
		throttle();
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		const r = await lookupPullStep(env, { queue: [unit] });
		expect(r.throttled).toBeTruthy();
		await expect(
			Promise.all([
				rowCount("rating_snapshot"),
				rowCount("app_metadata_version"),
				rowCount("app"),
			])
		).resolves.toStrictEqual([0, 0, 0]);
		await expect(getState(env.DB, lookupMarker(unit))).resolves.toBeNull();
		const classes = await env.DB.prepare(
			"SELECT error_class FROM fetch_error ORDER BY id"
		).all<{ error_class: string }>();
		expect(classes.results.map((c) => c.error_class)).toStrictEqual([
			"throttled",
		]);
	});

	it("keeps the refusal's body and timing with the throttle it records", async () => {
		stubFetch(
			() =>
				new Response(
					"Rate limit has been exceeded for: itunes-apple-com|general|x",
					{ status: 429 }
				)
		);
		await lookupPullStep(env, {
			queue: [{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" }],
		});
		const err = await lastError();
		expect(err?.error_class).toBe("throttled");
		expect(err?.message).toContain("Rate limit has been exceeded");
		expect(err?.response_ms).toBeGreaterThanOrEqual(0);
	});

	// A 200 that is not JSON is Apple's edge serving an error page. It is not an
	// HTTP error, and with no body kept it was a row nobody could diagnose.
	it("classes a 200 that is not JSON as an invalid body and keeps what it said", async () => {
		stubFetch(() => new Response(`<html>${"x".repeat(5000)}</html>`));
		const unit = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		const r = await lookupPullStep(env, { queue: [unit] });
		expect(r).toStrictEqual({ followUps: [], throttled: false });
		const err = await lastError();
		expect(err).toMatchObject({
			endpoint: "itunes:lookup",
			error_class: "invalid_body",
			http_status: 200,
		});
		// The head of the page, cut to what the column is meant to hold.
		expect(err?.message).toBe(`<html>${"x".repeat(1194)}`);
		expect(err?.response_ms).toBeGreaterThanOrEqual(0);
		// No marker: nothing was collected, so the unit is tried again today.
		await expect(getState(env.DB, lookupMarker(unit))).resolves.toBeNull();
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
		const detail = await lastError();
		expect(detail).toMatchObject({ http_status: 500, message: "boom" });
		expect(detail?.response_ms).toBeGreaterThanOrEqual(0);
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

	it("stores no review from a 403, even one carrying a whole feed", async () => {
		stubFetch(() => Response.json(reviewFeed(3), { status: 403 }));
		const unit = { appId: APP_ID, storefront: "fr" };
		const r = await reviewPullStep(env, { queue: [unit] });
		expect(r.throttled).toBeTruthy();
		await expect(rowCount("review")).resolves.toBe(0);
		await expect(getState(env.DB, reviewMarker(unit))).resolves.toBeNull();
	});

	it("classes a 200 that is not JSON as an invalid body", async () => {
		stubFetch(() => new Response("<html>Bad Gateway</html>"));
		const unit = { appId: APP_ID, storefront: "fr" };
		await reviewPullStep(env, { queue: [unit] });
		const err = await lastError();
		expect(err).toMatchObject({
			endpoint: "itunes:reviews",
			error_class: "invalid_body",
			http_status: 200,
			message: "<html>Bad Gateway</html>",
		});
		await expect(getState(env.DB, reviewMarker(unit))).resolves.toBeNull();
	});

	it("derives nothing from a feed whose archive did not land", async () => {
		stubFetch(() => Response.json(reviewFeed(3)));
		const unit = { appId: APP_ID, storefront: "fr" };
		await expect(
			reviewPullStep(refusingArchive(), { queue: [unit] })
		).rejects.toThrow(/archive did not persist/u);
		await expect(rowCount("review")).resolves.toBe(0);
		await expect(getState(env.DB, reviewMarker(unit))).resolves.toBeNull();
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

	it("archives the chart body gzipped under a key that says so", async () => {
		stubFetch(() => Response.json(chartFeed));
		await chartPullStep(env, {
			queue: [{ chart: "free", genreId: 7019, storefront: "fr" }],
		});
		const row = await env.DB.prepare(
			"SELECT r2_key FROM chart_ranking LIMIT 1"
		).first<{ r2_key: string }>();
		expect(row?.r2_key).toMatch(/^charts\/.+\/fr\/free\/7019\/.+\.json\.gz$/u);
		const object = await env.ARCHIVE.get(row?.r2_key ?? "");
		expect(object?.httpMetadata?.contentType).toBe("application/gzip");
		const text = await new Response(
			object?.body.pipeThrough(new DecompressionStream("gzip"))
		).text();
		expect(JSON.parse(text)).toStrictEqual(chartFeed);
	});

	it("updates the storefront-wide chart instead of appending a duplicate", async () => {
		// genre_id IS NULL for the whole-storefront chart, and SQLite counts every
		// NULL as distinct in a UNIQUE index, so the ordinary conflict target
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

	it("stores no chart from a 403, even one carrying a whole board", async () => {
		stubFetch(() => Response.json(chartFeed, { status: 403 }));
		const unit = { chart: "paid" as const, genreId: null, storefront: "fr" };
		const r = await chartPullStep(env, { queue: [unit] });
		expect(r.throttled).toBeTruthy();
		await expect(rowCount("chart_ranking")).resolves.toBe(0);
		await expect(getState(env.DB, chartMarker(unit))).resolves.toBeNull();
	});

	it("classes a 200 that is not JSON as an invalid body", async () => {
		stubFetch(() => new Response("<html>Bad Gateway</html>"));
		const unit = { chart: "free" as const, genreId: 6014, storefront: "fr" };
		await chartPullStep(env, { queue: [unit] });
		const err = await lastError();
		expect(err).toMatchObject({
			endpoint: "itunes:charts",
			error_class: "invalid_body",
			http_status: 200,
			message: "<html>Bad Gateway</html>",
		});
		await expect(rowCount("chart_ranking")).resolves.toBe(0);
	});

	it("derives nothing from a board whose archive did not land", async () => {
		stubFetch(() => Response.json(chartFeed));
		const unit = { chart: "free" as const, genreId: null, storefront: "fr" };
		await expect(
			chartPullStep(refusingArchive(), { queue: [unit] })
		).rejects.toThrow(/archive did not persist/u);
		await expect(rowCount("chart_ranking")).resolves.toBe(0);
		await expect(getState(env.DB, chartMarker(unit))).resolves.toBeNull();
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

describe("daily pull markers", () => {
	// The day's queues live in a Durable Object that dies with the Actions
	// runner, so a run killed mid-drain loses whatever it had not reached. These
	// markers are what lets a second run the same day resume rather than refetch,
	// so what each outcome does or does not write is the contract.
	it("marks a lookup, a review pull and a chart done for today", async () => {
		stubFetch((url) => {
			if (url.includes("/lookup")) {
				return Response.json(lookupResponse());
			}
			if (url.includes("/rss/customerreviews")) {
				return Response.json(reviewFeed(1));
			}
			return Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "111" } } }] },
			});
		});
		const lookup = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		const review = { appId: APP_ID, storefront: "fr" };
		const chart = { chart: "free" as const, genreId: 7019, storefront: "fr" };
		await lookupPullStep(env, { queue: [lookup] });
		await reviewPullStep(env, { queue: [review] });
		await chartPullStep(env, { queue: [chart] });

		const pulled = await pulledOn(env.DB, TODAY);
		expect(pulled.has(lookupMarker(lookup))).toBeTruthy();
		expect(pulled.has(reviewMarker(review))).toBeTruthy();
		expect(pulled.has(chartMarker(chart))).toBeTruthy();
	});

	it("marks a feed with no reviews, which writes no row of its own", async () => {
		stubFetch(() => Response.json({ feed: { entry: { id: { label: "x" } } } }));
		const unit = { appId: APP_ID, storefront: "lu" };
		await reviewPullStep(env, { queue: [unit] });
		const pulled = await pulledOn(env.DB, TODAY);
		expect(pulled.has(reviewMarker(unit))).toBeTruthy();
	});

	it("marks an app absent from a storefront, since asking again today learns nothing", async () => {
		stubFetch(() => Response.json({ resultCount: 0, results: [] }));
		const unit = { appId: APP_ID, localeCode: "nl-NL", storefront: "nl" };
		await lookupPullStep(env, { queue: [unit] });
		const pulled = await pulledOn(env.DB, TODAY);
		expect(pulled.has(lookupMarker(unit))).toBeTruthy();
	});

	it("leaves no marker after an HTTP error, so the unit is tried again", async () => {
		stubFetch(() => new Response("boom", { status: 500 }));
		const lookup = { appId: APP_ID, localeCode: "fr-FR", storefront: "fr" };
		const chart = { chart: "paid" as const, genreId: null, storefront: "fr" };
		await lookupPullStep(env, { queue: [lookup] });
		await chartPullStep(env, { queue: [chart] });
		const pulled = await pulledOn(env.DB, TODAY);
		expect(pulled.has(lookupMarker(lookup))).toBeFalsy();
		expect(pulled.has(chartMarker(chart))).toBeFalsy();
	});

	it("leaves no marker after a throttle, which collected nothing", async () => {
		stubFetch(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);
		const unit = { appId: APP_ID, storefront: "fr" };
		await reviewPullStep(env, { queue: [unit] });
		const pulled = await pulledOn(env.DB, TODAY);
		expect(pulled.has(reviewMarker(unit))).toBeFalsy();
	});

	it("reads back only the markers of the day asked for", async () => {
		stubFetch(() => Response.json(reviewFeed(1)));
		await reviewPullStep(env, { queue: [{ appId: APP_ID, storefront: "fr" }] });
		const other = await pulledOn(env.DB, "2020-01-01");
		expect(other.size).toBe(0);
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

	it("marks the day compacted and forgets markers past the staging lifecycle", async () => {
		// The daily catch-up reads these to find days whose compaction never
		// finished, so the marker has to exist once the outputs have landed.
		const date = new Date(Date.now() - 2 * 24 * 3_600_000)
			.toISOString()
			.slice(0, 10);
		await env.ARCHIVE.put(
			`staging/rankings/${date}/4.json`,
			JSON.stringify({ pairId: 4, storefront: "fr" })
		);
		await setState(env.DB, compactMarker("2000-01-01"), "2000-01-01");
		try {
			await compactStep(env, { date });
		} finally {
			// R2 outlives the file, and the daily catch-up in another suite would
			// otherwise find this day still staged.
			await env.ARCHIVE.delete(`staging/rankings/${date}/4.json`);
		}
		await expect(getState(env.DB, compactMarker(date))).resolves.toBe(date);
		await expect(
			getState(env.DB, compactMarker("2000-01-01"))
		).resolves.toBeNull();
	});

	// The marker is what tells the daily catch-up a day needs no second pass.
	// Written before the outputs landed, a refused write would retire a day
	// whose staging then expires with nothing merged from it.
	it("leaves the day unmarked when an output does not land", async () => {
		const date = new Date(Date.now() - 3 * 24 * 3_600_000)
			.toISOString()
			.slice(0, 10);
		const key = `staging/rankings/${date}/5.json`;
		await env.ARCHIVE.put(key, JSON.stringify({ pairId: 5, storefront: "fr" }));
		try {
			await expect(compactStep(refusingArchive(), { date })).rejects.toThrow(
				/archive did not persist/u
			);
		} finally {
			await env.ARCHIVE.delete(key);
		}
		await expect(getState(env.DB, compactMarker(date))).resolves.toBeNull();
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
