/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import worker from "../src/index";
import {
	APP_ID,
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

describe("ownership", () => {
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
