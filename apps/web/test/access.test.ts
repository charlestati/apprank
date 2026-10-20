/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import worker from "../src/index";
import { clearReferenceCache } from "../src/mcp/reference";
import {
	APP_ID,
	KEYWORD_A,
	RIVAL_ID,
	USER_ID,
	apiRequest,
	isoDay,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedRanking,
	seedTrackedApp,
} from "./fixtures";
import {
	callTool,
	fetchMcp,
	issueCredential,
	mcpRequest,
	toolPayload,
} from "./mcp-fixtures";

const OTHER_USER = "someone-else";
const OTHER_APP = 707_070;

beforeEach(async () => {
	await resetDb();
	await seedCatalog();
	await seedTrackedApp();
	await seedKeywords();
});

/** Every route that answers about a specific app or pair. */
const SCOPED_ROUTES = [
	`/apps/${APP_ID}/storefronts`,
	`/apps/${APP_ID}/report?storefront=fr`,
	`/apps/${APP_ID}/report.csv?storefront=fr`,
	`/apps/${APP_ID}/keywords`,
	`/apps/${APP_ID}/reviews`,
	`/apps/${APP_ID}/ratings`,
	`/apps/${APP_ID}/localizations`,
	"/pairs/1/history",
	"/pairs/1/competitors",
	"/pairs/1/results",
];

describe("the session gate", () => {
	it("serves nothing at all when no auth secret is configured", async () => {
		const res = await worker.fetch(apiRequest("/apps"), {
			...env,
			ALLOW_UNAUTHENTICATED: undefined,
			BASIC_AUTH_ACCOUNTS: undefined,
		} as never);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			error: "auth not configured",
		});
	});

	it("refuses every data route while unconfigured, not just the first", async () => {
		const unconfigured = {
			...env,
			ALLOW_UNAUTHENTICATED: undefined,
			BASIC_AUTH_ACCOUNTS: undefined,
		} as never;
		for (const path of SCOPED_ROUTES) {
			const res = await worker.fetch(apiRequest(path), unconfigured);
			expect([path, res.status]).toStrictEqual([path, 503]);
		}
	});

	it("401s a caller with no credentials once accounts exist", async () => {
		const res = await worker.fetch(apiRequest("/apps"), {
			...env,
			ALLOW_UNAUTHENTICATED: undefined,
			BASIC_AUTH_ACCOUNTS: '[{"username":"a","password":"b"}]',
		} as never);
		expect(res.status).toBe(401);
	});

	it("only opens up when the local development escape hatch is explicit", async () => {
		const res = await worker.fetch(apiRequest("/apps"), {
			...env,
			ALLOW_UNAUTHENTICATED: "true",
			BASIC_AUTH_ACCOUNTS: undefined,
		} as never);
		expect(res.status).toBe(200);
	});

	it("keeps the liveness probe public", async () => {
		const closed = {
			...env,
			ALLOW_UNAUTHENTICATED: undefined,
			BASIC_AUTH_ACCOUNTS: undefined,
		} as never;
		const health = await worker.fetch(apiRequest("/health"), closed);
		expect(health.status).toBe(200);
	});
});

/** A second operator with their own app, keyword and crawl pair. */
async function seedOtherOperator() {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, 'Their App', 0, 0)"
		).bind(OTHER_APP),
		env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES (?1, ?2, 0)"
		).bind(OTHER_USER, OTHER_APP),
		env.DB.prepare(
			"INSERT INTO keyword (id, text, normalized, language) VALUES (9, 'their keyword', 'their keyword', 'fr')"
		),
		env.DB.prepare(
			`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (9, 9, 'fr', 'fr-FR', 1, 1, 0)`
		),
		env.DB.prepare(
			"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 9, 0)"
		).bind(OTHER_USER, OTHER_APP),
	]);
}

describe("ownership", () => {
	it("hides another operator's app behind a 404, not a 403", async () => {
		await seedOtherOperator();
		// 403 would confirm the id exists, which is itself information.
		for (const path of [
			`/apps/${OTHER_APP}/report?storefront=fr`,
			`/apps/${OTHER_APP}/keywords`,
			`/apps/${OTHER_APP}/reviews`,
			`/apps/${OTHER_APP}/ratings`,
			`/apps/${OTHER_APP}/localizations`,
			`/apps/${OTHER_APP}/storefronts`,
			`/apps/${OTHER_APP}/report.csv`,
		]) {
			const res = await worker.fetch(apiRequest(path), env);
			expect([path, res.status]).toStrictEqual([path, 404]);
		}
	});

	it("hides a pair whose keyword the caller does not track", async () => {
		await seedOtherOperator();
		await seedRanking({
			date: isoDay(0),
			entries: [[1, RIVAL_ID]],
			id: 5,
			pairId: 9,
		});
		for (const path of [
			"/pairs/9/history",
			"/pairs/9/competitors",
			"/pairs/9/results",
		]) {
			const res = await worker.fetch(apiRequest(path), env);
			expect([path, res.status]).toStrictEqual([path, 404]);
		}
	});

	it("still serves the caller's own app and pairs", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [[3, APP_ID]],
			id: 1,
			pairId: 1,
		});
		for (const path of SCOPED_ROUTES) {
			const res = await worker.fetch(apiRequest(path), env);
			expect([path, res.status]).toStrictEqual([path, 200]);
		}
	});

	it("lists only the caller's own apps", async () => {
		await seedOtherOperator();
		const res = await worker.fetch(apiRequest("/apps"), env);
		const rows = (await res.json()) as { id: number }[];
		expect(rows.map((r) => r.id)).toStrictEqual([APP_ID]);
	});
});

/**
 * The second operator tracks keyword A too, but in Germany, where the caller
 * does not. The pair is theirs alone even though the keyword is shared.
 */
async function seedSharedKeywordElsewhere() {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('de-DE', 'de')"
		),
		// Active, so the MCP storefront schema accepts it as an argument.
		env.DB.prepare("UPDATE storefront SET active = 1 WHERE code = 'de'"),
		env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, 'Their App', 0, 0)"
		).bind(OTHER_APP),
		env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES (?1, ?2, 0)"
		).bind(OTHER_USER, OTHER_APP),
		env.DB.prepare(
			`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (10, 1, 'de', 'de-DE', 1, 1, 0)`
		),
		env.DB.prepare(
			"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 1, 0)"
		).bind(OTHER_USER, OTHER_APP),
		env.DB.prepare(
			`INSERT INTO tracked_keyword_storefront (tracked_keyword_id, storefront_code, locale_code, created_at)
         SELECT id, 'de', 'de-DE', 0 FROM tracked_keyword WHERE user_id = ?1`
		).bind(OTHER_USER),
	]);
	await seedRanking({
		date: isoDay(0),
		entries: [
			[1, OTHER_APP],
			[2, APP_ID],
		],
		id: 10,
		pairId: 10,
	});
}

async function read<T>(path: string): Promise<T> {
	const res = await worker.fetch(apiRequest(path), env);
	return (await res.json()) as T;
}

describe("a keyword two operators share in different storefronts", () => {
	beforeEach(seedSharedKeywordElsewhere);

	it("hides the other operator's storefront pair behind a 404", async () => {
		for (const path of [
			"/pairs/10/history",
			"/pairs/10/competitors",
			"/pairs/10/results",
		]) {
			const res = await worker.fetch(apiRequest(path), env);
			expect([path, res.status]).toStrictEqual([path, 404]);
		}
	});

	it("still lets the operator who tracks it there read it", async () => {
		const theirs = { ...env, DEV_USER_ID: OTHER_USER } as never;
		const res = await worker.fetch(apiRequest("/pairs/10/results"), theirs);
		expect(res.status).toBe(200);
		const grid = await worker.fetch(
			apiRequest(`/apps/${OTHER_APP}/keywords`),
			theirs
		);
		const pairs = (await grid.json()) as { pair_id: number }[];
		expect(pairs.map((p) => p.pair_id)).toStrictEqual([10]);
	});

	it("leaves it out of the caller's storefronts, grid and report", async () => {
		const storefronts = await read<{ code: string }[]>(
			`/apps/${APP_ID}/storefronts`
		);
		expect(storefronts.map((s) => s.code)).toStrictEqual(["fr", "us"]);

		const grid = await read<{ pair_id: number }[]>(`/apps/${APP_ID}/keywords`);
		expect(grid.map((r) => r.pair_id).toSorted()).toStrictEqual([1, 2, 3]);

		const report = await read<{ rows: unknown[] }>(
			`/apps/${APP_ID}/report?storefront=de`
		);
		expect(report.rows).toStrictEqual([]);
	});

	it("leaves it out of the MCP tools too", async () => {
		await env.DB.prepare("DELETE FROM mcp_credential").run();
		clearReferenceCache();
		const { token } = await issueCredential({ userId: USER_ID });
		const walled = { ...env, MCP_ENABLED: "true" } as never;
		const call = async (name: string, args: Record<string, unknown>) =>
			toolPayload(
				await fetchMcp(mcpRequest(callTool(name, args), token), walled)
			);

		const current = await call("get_current_rankings", { appId: APP_ID });
		const rankings = current.data.rankings as { pairId: number }[];
		expect(rankings.map((r) => r.pairId).toSorted()).toStrictEqual([1, 2, 3]);

		const health = await call("get_collection_health", { appId: APP_ID });
		const coverage = health.data.coverage as { pairId: number }[];
		expect(coverage.map((c) => c.pairId).toSorted()).toStrictEqual([1, 2, 3]);

		const listed = await call("list_tracked_apps", {});
		const apps = listed.data.apps as {
			storefronts: { code: string }[];
		}[];
		expect(apps[0]?.storefronts.map((s) => s.code)).toStrictEqual(["fr", "us"]);

		for (const args of [
			{ pairId: 10 },
			{ keyword: KEYWORD_A, storefront: "de" },
		]) {
			const history = await call("get_rank_history", args);
			expect([args, history.isError]).toStrictEqual([args, true]);
		}
	});
});

describe("suggestions", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO suggestion (id, user_id, type, payload, status, created_at) VALUES (1, ?1, 'promote_pair', '{}', 'pending', 0)"
			).bind(USER_ID),
			env.DB.prepare(
				"INSERT INTO suggestion (id, user_id, type, payload, status, created_at) VALUES (2, ?1, 'promote_pair', '{}', 'pending', 0)"
			).bind(OTHER_USER),
		]);
	});

	it("lists only the caller's suggestions", async () => {
		const res = await worker.fetch(apiRequest("/suggestions"), env);
		const rows = (await res.json()) as { id: number }[];
		expect(rows.map((r) => r.id)).toStrictEqual([1]);
	});

	it("refuses to act on someone else's suggestion", async () => {
		const res = await worker.fetch(
			apiRequest("/suggestions/2", {
				body: JSON.stringify({ status: "dismissed" }),
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			}),
			env
		);
		expect(res.status).toBe(404);
		const row = await env.DB.prepare(
			"SELECT status FROM suggestion WHERE id = 2"
		).first<{ status: string }>();
		expect(row?.status).toBe("pending");
	});

	it("accepts the caller's own suggestion", async () => {
		const res = await worker.fetch(
			apiRequest("/suggestions/1", {
				body: JSON.stringify({ status: "accepted" }),
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			}),
			env
		);
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT status FROM suggestion WHERE id = 1"
		).first<{ status: string }>();
		expect(row?.status).toBe("accepted");
	});
});
