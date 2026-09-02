/* oxlint-disable vitest/max-expects, vitest/require-top-level-describe, typescript/no-non-null-assertion --
   integration tests assert the full persistence surface of one crawl, and the
   fetch-stub hook lives beside its helper above the describe blocks. */
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, afterEach, vi } from "vitest";

// vitest-pool-workers runs tests in the same isolate as the Worker (and its
// Durable Objects), so a global fetch stub intercepts the crawler's requests.
function stubItunes(handler: (url: string) => Response) {
	const original = globalThis.fetch;
	vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes("itunes.apple.com")) {
			return Promise.resolve(handler(url));
		}
		return original(input as never, init);
	}) as typeof fetch);
}

function seedReference() {
	return env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront_locale (storefront_code, locale_code, is_default) VALUES ('fr', 'fr-FR', 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (1, 'terme un', 'terme un', 'fr')"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (424242, 'Tracked App', 0, 0)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', 424242, 0)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, 0)"
		),
	]);
}

const fakeResults = {
	resultCount: 3,
	results: [
		{
			artistId: 9,
			artistName: "Dev A",
			averageUserRating: 4.5,
			currency: "EUR",
			genreIds: ["7019"],
			price: 0,
			primaryGenreId: 7019,
			trackId: 111,
			trackName: "Top App",
			userRatingCount: 100,
			version: "1.0",
		},
		{
			artistId: 10,
			artistName: "Tracked Dev",
			averageUserRating: 4.5,
			currency: "EUR",
			genreIds: ["7019"],
			price: 0,
			primaryGenreId: 7019,
			trackId: 424_242,
			trackName: "Tracked App",
			userRatingCount: 70,
			version: "1.2.1",
		},
		{
			artistId: 11,
			artistName: "Dev B",
			averageUserRating: 3.9,
			currency: "EUR",
			genreIds: ["7012"],
			price: 0,
			primaryGenreId: 7012,
			trackId: 222,
			trackName: "Other",
			userRatingCount: 5,
			version: "2.0",
		},
	],
};

afterEach(() => vi.unstubAllGlobals());

describe("SchedulerDO crawl loop", () => {
	it("crawls a due pair via alarm and persists an idempotent observation", async () => {
		await seedReference();
		stubItunes(() => Response.json(fakeResults));

		const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("test"));
		await stub.ensureAlarm();
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBeTruthy();

		const date = new Date().toISOString().slice(0, 10);
		const ranking = await env.DB.prepare(
			"SELECT * FROM ranking WHERE pair_id = 1 AND observed_date = ?"
		)
			.bind(date)
			.first<{
				result_count: number;
				result_ids: string;
				http_status: number;
				valid: number;
			}>();
		expect(ranking).toBeTruthy();
		expect(ranking!.http_status).toBe(200);
		expect(ranking!.valid).toBe(1);
		expect(JSON.parse(ranking!.result_ids)).toStrictEqual([111, 424_242, 222]);

		const entries = await env.DB.prepare(
			"SELECT position, app_id FROM rank_entry re JOIN ranking r ON r.id = re.ranking_id WHERE r.pair_id = 1 ORDER BY position"
		).all<{ position: number; app_id: number }>();
		expect(entries.results.map((e) => e.app_id)).toStrictEqual([
			111, 424_242, 222,
		]);

		// Pair rescheduled to the future.
		const pair = await env.DB.prepare(
			"SELECT next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ next_due_at: number }>();
		expect(pair!.next_due_at).toBeGreaterThan(Date.now());

		// Staging object written.
		const staged = await env.ARCHIVE.get(`staging/rankings/${date}/1.json`);
		expect(staged).toBeTruthy();
	});

	it("treats a 403-with-empty-results as throttling, never as an observation", async () => {
		await seedReference();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM rank_entry"),
			env.DB.prepare("DELETE FROM ranking"),
			env.DB.prepare("DELETE FROM fetch_error"),
			env.DB.prepare("UPDATE crawl_pair SET next_due_at = 0 WHERE id = 1"),
		]);
		stubItunes(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);

		const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("test-403"));
		await stub.ensureAlarm();
		await runDurableObjectAlarm(stub);

		const date = new Date().toISOString().slice(0, 10);
		const ranking = await env.DB.prepare(
			"SELECT id FROM ranking WHERE pair_id = 1 AND observed_date = ?"
		)
			.bind(date)
			.first();
		expect(ranking).toBeNull();

		const err = await env.DB.prepare(
			"SELECT error_class, http_status FROM fetch_error WHERE endpoint = 'itunes:search'"
		).first<{
			error_class: string;
			http_status: number;
		}>();
		expect(err?.error_class).toBe("throttled");
		expect(err?.http_status).toBe(403);

		// Pacing backed off: one hit parks the loop and is tallied. The rate is a
		// daily trend, so it does not move on a single 429.
		const pacing = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'pacing'"
		).first<{ value: string }>();
		const p = JSON.parse(pacing!.value) as {
			ratePerMin: number;
			pauseUntil: number;
			windowErrorCount: number;
		};
		expect(p.pauseUntil).toBeGreaterThan(Date.now());
		expect(p.windowErrorCount).toBe(1);
	});
});
