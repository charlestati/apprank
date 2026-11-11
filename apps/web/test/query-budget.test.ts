/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

// D1's hard ceilings, asserted where they bite: rows read per day (5M free),
// queries per Worker invocation (50 free) and bound parameters per statement
// (100). Local workerd rejects only the last, so the other two pass here in a
// query that breaks them in production unless the test counts for itself.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { clearReferenceCache } from "../src/mcp/reference";
import { appKeywords, currentRankings } from "../src/queries/apps";
import { chartMovement } from "../src/queries/charts";
import { pairCoverage } from "../src/queries/coverage";
import type { Coverage } from "../src/queries/coverage";
import { pairHistory } from "../src/queries/rankings";
import { buildReport } from "../src/report";
import {
	APP_ID,
	USER_ID,
	isoDay,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedTrackedApp,
	trackEveryActivePair,
} from "./fixtures";
import {
	callTool,
	fetchMcp,
	issueCredential,
	mcpRequest,
	toolPayload,
} from "./mcp-fixtures";

const D1_MAX_BOUND_PARAMETERS = 100;
const WORKERS_FREE_QUERIES_PER_INVOCATION = 50;

/**
 * A database that counts statements prepared and the parameters each binds,
 * while passing every call through to the real one.
 */
function counting(db: D1Database) {
	const binds: number[] = [];
	let prepared = 0;
	const proxy = new Proxy(db, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					prepared += 1;
					const stmt = target.prepare(sql);
					const bind = stmt.bind.bind(stmt);
					stmt.bind = (...values: unknown[]) => {
						binds.push(values.length);
						return bind(...values);
					};
					return stmt;
				};
			}
			const value: unknown = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { binds, db: proxy, prepared: () => prepared };
}

/** A year of daily observations for one pair, in one statement. */
async function seedYear(pairId: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
     WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 364)
     SELECT ?1, date('now', '-' || i || ' day'), 0, 200, 0, '[]', 'test', 1 FROM n`
	)
		.bind(pairId)
		.run();
}

/** Another operator's keyword with a long history in three storefronts. */
async function seedSomeoneElsesHistory(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO keyword (id, text, normalized, language) VALUES (50, 'theirs', 'theirs', 'fr')"
		),
		...[50, 51, 52].map((id, i) =>
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (?1, 50, ?2, ?3, 1, 1, 0)`
			).bind(id, ["fr", "us", "de"][i], ["fr-FR", "en-US", "fr-FR"][i])
		),
	]);
	for (const pairId of [50, 51, 52]) {
		await seedYear(pairId);
	}
}

beforeEach(async () => {
	await resetDb();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM mcp_tool_call"),
		env.DB.prepare("DELETE FROM mcp_credential"),
		env.DB.prepare("DELETE FROM chart_ranking"),
	]);
	clearReferenceCache();
	await seedCatalog();
	await seedTrackedApp();
	await seedKeywords();
});

describe("latest rank per pair", () => {
	// Our three pairs hold at most 91 days each inside the window. Grouping the
	// whole ranking index by pair before bounding it read every operator's whole
	// history: here three other pairs at 365 days each, so over 1,000 rows.
	const OUR_PAIRS = 3;
	const WINDOW_DAYS = 91;
	const BUDGET = OUR_PAIRS * WINDOW_DAYS + 50;

	it("reads the caller's pairs within the window, not everyone's history", async () => {
		await seedYear(1);
		await seedSomeoneElsesHistory();
		const result = await appKeywords(env.DB, USER_ID, APP_ID);
		expect(result.results).toHaveLength(3);
		expect(result.meta.rows_read).toBeLessThan(BUDGET);
	});

	it("bounds the MCP tool's query the same way", async () => {
		await seedYear(1);
		await seedSomeoneElsesHistory();
		const result = await currentRankings(env.DB, {
			appId: APP_ID,
			limit: 10,
			storefront: null,
			userId: USER_ID,
		});
		expect(result.results).toHaveLength(3);
		expect(result.results.find((r) => r.pair_id === 1)?.observed_date).toBe(
			isoDay(0)
		);
		expect(result.meta.rows_read).toBeLessThan(BUDGET);
	});
});

describe("an app's rank read off the stored page", () => {
	it("costs no more rows than reading the index did", async () => {
		// The position of an app the index never held comes from the page the
		// observation kept. Unpacked with json_each, D1 billed every element as a
		// row: 35,910 for these ninety observations, against ninety.
		const page = Array.from({ length: 199 }, (_, i) => 7_000_000 + i);
		await env.DB.prepare(
			`INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
       WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 89)
       SELECT 1, date('now', '-' || i || ' day'), 0, 200, 200, ?1, 'test', 1 FROM n`
		)
			.bind(JSON.stringify([...page, APP_ID]))
			.run();

		const history = await pairHistory(env.DB, 1, isoDay(120), APP_ID);
		expect([history.results.length, history.results[0]]).toMatchObject([
			90,
			{ app_id: APP_ID, position: 200 },
		]);
		expect(history.meta.rows_read).toBeLessThan(2 * 90 + 20);

		const grid = await appKeywords(env.DB, USER_ID, APP_ID);
		expect(grid.results.find((r) => r.pair_id === 1)).toMatchObject({
			rank: 200,
		});
		expect(grid.meta.rows_read).toBeLessThan(3 * 91 + 50);

		const report = await buildReport(env as never, {
			appId: APP_ID,
			days: 100,
			storefront: "fr",
			userId: USER_ID,
		});
		const row = report.rows.find((r) => r.pairId === 1);
		expect([row?.points.length, row?.position]).toStrictEqual([90, 200]);
	});
});

describe("chart movement", () => {
	it("names every app across two full boards in one bounded statement", async () => {
		// Two disjoint boards of 150, so the union is 300 apps.
		const before = Array.from({ length: 150 }, (_, i) => 1_000_000 + i);
		const after = Array.from({ length: 150 }, (_, i) => 2_000_000 + i);
		await env.DB.prepare(
			`INSERT INTO app (id, current_name, first_seen_at, last_seen_at)
       SELECT value, 'App ' || value, 0, 0 FROM json_each(?1)`
		)
			.bind(JSON.stringify([...before, ...after]))
			.run();
		await env.DB.batch(
			[before, after].map((ids, i) =>
				env.DB.prepare(
					`INSERT INTO chart_ranking (storefront_code, chart, genre_id, observed_date, result_ids, http_status, source)
           VALUES ('fr', 'free', NULL, ?1, ?2, 200, 'test')`
				).bind(isoDay(1 - i), JSON.stringify(ids))
			)
		);

		const { binds, db } = counting(env.DB);
		const result = await chartMovement(db, {
			chart: "free",
			from: isoDay(5),
			genreId: null,
			storefront: "fr",
			to: isoDay(0),
		});
		expect(result.moves).toHaveLength(300);
		expect(
			result.moves.filter((m) => m.name !== `App ${m.appId}`)
		).toStrictEqual([]);
		expect(Math.max(...binds)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
	});
});

async function mcp(
	db: D1Database,
	name: string,
	args: Record<string, unknown> = {}
) {
	const { token } = await issueCredential({ userId: USER_ID });
	const walled = {
		...env,
		ALLOW_UNAUTHENTICATED: "true",
		DB: db,
		MCP_ENABLED: "true",
	} as never;
	return toolPayload(
		await fetchMcp(mcpRequest(callTool(name, args), token), walled)
	);
}

/** Twenty more keywords for the tracked app, one pair each, in France. */
async function seedTwentyPairs(): Promise<number[]> {
	const ids = Array.from({ length: 20 }, (_, i) => 100 + i);
	await env.DB.batch(
		ids.flatMap((id) => [
			env.DB.prepare(
				"INSERT INTO keyword (id, text, normalized, language) VALUES (?1, ?2, ?2, 'fr')"
			).bind(id, `keyword ${id}`),
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at, interval_hours)
           VALUES (?1, ?1, 'fr', 'fr-FR', 1, 1, 0, ?2)`
			).bind(id, id % 2 === 0 ? 24 : 72),
			env.DB.prepare(
				"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, ?3, 0)"
			).bind(USER_ID, APP_ID, id),
			// A different pattern per pair, so a coverage answer filed under the
			// wrong pair cannot pass for the right one.
			env.DB.prepare(
				`INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
           VALUES (?1, ?2, 0, 200, 0, '[]', 'test', 1)`
			).bind(id, isoDay(id % 7)),
			...(id % 3 === 0
				? [
						env.DB.prepare(
							`INSERT INTO fetch_error (fetched_at, endpoint, error_class, params)
                 VALUES (?1, '/search', 'throttled', ?2)`
						).bind(
							Date.now() - (id % 5) * 86_400_000,
							`keyword ${id}|fr|fr-FR`
						),
					]
				: []),
		])
	);
	await trackEveryActivePair(USER_ID);
	return ids;
}

describe("queries per tool call", () => {
	it("measures coverage for every pair without a query per pair", async () => {
		await seedTwentyPairs();
		const counted = counting(env.DB);
		const { data, isError } = await mcp(counted.db, "get_collection_health", {
			appId: APP_ID,
			from: isoDay(10),
			to: isoDay(0),
		});
		expect(isError).toBeFalsy();
		expect(counted.prepared()).toBeLessThan(
			WORKERS_FREE_QUERIES_PER_INVOCATION
		);
		expect(data.coverage).toHaveLength(23);
	});

	it("files each pair's coverage under that pair", async () => {
		const ids = await seedTwentyPairs();
		const { data } = await mcp(env.DB, "get_collection_health", {
			appId: APP_ID,
			from: isoDay(10),
			to: isoDay(0),
		});
		const coverage = data.coverage as (Coverage & {
			keyword: string;
			pairId: number;
			storefront: string;
		})[];
		const byPair = new Map(coverage.map((c) => [c.pairId, c]));
		for (const id of ids) {
			const { keyword, pairId, storefront, ...rest } = byPair.get(
				id
			) as (typeof coverage)[number];
			expect([keyword, pairId, storefront]).toStrictEqual([
				`keyword ${id}`,
				id,
				"fr",
			]);
			expect(rest).toStrictEqual(
				await pairCoverage(env.DB, id, isoDay(10), isoDay(0))
			);
		}
		// Spot-check the batch against facts seeded above, not only against the
		// single-pair path it shares code with.
		const throttled = byPair.get(102);
		const stretched = byPair.get(101);
		expect([
			throttled?.errors.map((e) => e.errorClass),
			throttled?.intervalHours,
		]).toStrictEqual([["throttled"], 24]);
		expect([stretched?.errors, stretched?.intervalHours]).toStrictEqual([
			[],
			72,
		]);
	});

	it("lists every tracked app's storefronts without a query per app", async () => {
		const apps = Array.from({ length: 60 }, (_, i) => 3_000_000 + i);
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO app (id, current_name, first_seen_at, last_seen_at)
         SELECT value, 'App ' || value, 0, 0 FROM json_each(?1)`
			).bind(JSON.stringify(apps)),
			env.DB.prepare(
				`INSERT INTO tracked_app (user_id, app_id, created_at)
         SELECT ?1, value, 0 FROM json_each(?2)`
			).bind(USER_ID, JSON.stringify(apps)),
			// One of them tracks keyword B, which is crawled in France only.
			env.DB.prepare(
				"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 2, 0)"
			).bind(USER_ID, apps[0]),
		]);
		await trackEveryActivePair(USER_ID);

		const counted = counting(env.DB);
		const { data } = await mcp(counted.db, "list_tracked_apps");
		expect(counted.prepared()).toBeLessThan(
			WORKERS_FREE_QUERIES_PER_INVOCATION
		);
		const listed = data.apps as {
			appId: number;
			storefronts: { code: string; keywords: number }[];
		}[];
		expect(listed).toHaveLength(61);
		expect(listed.find((a) => a.appId === APP_ID)?.storefronts).toStrictEqual([
			{ code: "fr", keywords: 2, name: "France" },
			{ code: "us", keywords: 1, name: "United States" },
		]);
		expect(listed.find((a) => a.appId === apps[0])?.storefronts).toStrictEqual([
			{ code: "fr", keywords: 1, name: "France" },
		]);
		expect(listed.find((a) => a.appId === apps[1])?.storefronts).toStrictEqual(
			[]
		);
	});
});
