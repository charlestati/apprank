/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite here, not a per-suite one. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import {
	APP_ID,
	RIVAL_ID,
	apiRequest,
	isoDay,
	resetDb,
	USER_ID,
	seedCatalog,
	seedTrackedApp,
} from "./fixtures";

interface ReviewRow {
	id: string;
	storefront_code: string;
	rating: number | null;
	title: string | null;
}

interface RatingRow {
	storefront_code: string;
	observed_date: string;
	rating_count: number | null;
	rating_avg: number | null;
}

interface LocalizationRow {
	locale_code: string;
	status: string;
	title: string | null;
	captured_at: number;
}

interface SuggestionRow {
	id: number;
	type: string;
	payload: string;
	status: string;
}

async function seedReviews(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO review (id, app_id, storefront_code, rating, title, body, author, app_version, reviewed_at, fetched_at)
       VALUES ('r-fr-1', ?1, 'fr', 5, 'Great', 'Body one', 'Reviewer One', '1.2.0', 2000, 0)`
		).bind(APP_ID),
		env.DB.prepare(
			`INSERT INTO review (id, app_id, storefront_code, rating, title, body, author, app_version, reviewed_at, fetched_at)
       VALUES ('r-fr-2', ?1, 'fr', 3, 'Fine', 'Body two', 'Reviewer Two', '1.1.0', 3000, 0)`
		).bind(APP_ID),
		env.DB.prepare(
			`INSERT INTO review (id, app_id, storefront_code, rating, title, body, author, app_version, reviewed_at, fetched_at)
       VALUES ('r-us-1', ?1, 'us', 4, 'Good', 'Body three', 'Reviewer Three', '1.2.0', 1000, 0)`
		).bind(APP_ID),
		env.DB.prepare(
			`INSERT INTO review (id, app_id, storefront_code, rating, title, body, author, app_version, reviewed_at, fetched_at)
       VALUES ('r-other', ?1, 'fr', 1, 'Not ours', 'Body four', 'Reviewer Four', '2.0.0', 9000, 0)`
		).bind(RIVAL_ID),
	]);
}

beforeEach(async () => {
	await resetDb();
	// These routes are app-scoped now: the caller must track the app to read it.
	await seedCatalog();
	await seedTrackedApp();
});

describe("GET /api/apps/:appId/reviews", () => {
	it("returns an empty list when nothing was collected", async () => {
		await seedCatalog();
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/reviews`), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("returns this app's reviews newest first", async () => {
		await seedCatalog();
		await seedReviews();
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/reviews`), env);
		const rows = (await res.json()) as ReviewRow[];
		expect(rows.map((r) => r.id)).toStrictEqual(["r-fr-2", "r-fr-1", "r-us-1"]);
		expect(rows[0]?.title).toBe("Fine");
	});

	it("filters by the storefront query param", async () => {
		await seedCatalog();
		await seedReviews();
		const res = await app.fetch(
			apiRequest(`/apps/${APP_ID}/reviews?storefront=us`),
			env
		);
		const rows = (await res.json()) as ReviewRow[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.storefront_code).toBe("us");
	});
});

describe("GET /api/apps/:appId/ratings", () => {
	it("returns an empty series with no snapshots", async () => {
		await seedCatalog();
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/ratings`), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("returns snapshots for this app ordered by date", async () => {
		await seedCatalog();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
         VALUES (?1, 'fr', ?2, 120, 4.5)`
			).bind(APP_ID, isoDay()),
			env.DB.prepare(
				`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
         VALUES (?1, 'fr', ?2, 100, 4.4)`
			).bind(APP_ID, isoDay(1)),
			env.DB.prepare(
				`INSERT INTO rating_snapshot (app_id, storefront_code, observed_date, rating_count, rating_avg)
         VALUES (?1, 'fr', ?2, 9, 2.0)`
			).bind(RIVAL_ID, isoDay()),
		]);
		const res = await app.fetch(apiRequest(`/apps/${APP_ID}/ratings`), env);
		const rows = (await res.json()) as RatingRow[];
		expect(rows).toStrictEqual([
			{
				observed_date: isoDay(1),
				rating_avg: 4.4,
				rating_count: 100,
				storefront_code: "fr",
			},
			{
				observed_date: isoDay(),
				rating_avg: 4.5,
				rating_count: 120,
				storefront_code: "fr",
			},
		]);
	});
});

describe("GET /api/apps/:appId/localizations", () => {
	it("returns an empty list when none were captured", async () => {
		await seedCatalog();
		const res = await app.fetch(
			apiRequest(`/apps/${APP_ID}/localizations`),
			env
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("returns the latest capture per locale", async () => {
		await seedCatalog();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO app_localization (app_id, locale_code, status, title, captured_at, content_hash)
         VALUES (?1, 'fr-FR', 'present', 'Ancienne fiche', 100, 'h1')`
			).bind(APP_ID),
			env.DB.prepare(
				`INSERT INTO app_localization (app_id, locale_code, status, title, captured_at, content_hash)
         VALUES (?1, 'fr-FR', 'present', 'Fiche à jour', 200, 'h2')`
			).bind(APP_ID),
			env.DB.prepare(
				`INSERT INTO app_localization (app_id, locale_code, status, title, captured_at, content_hash)
         VALUES (?1, 'en-US', 'missing', NULL, 150, 'h3')`
			).bind(APP_ID),
		]);
		const res = await app.fetch(
			apiRequest(`/apps/${APP_ID}/localizations`),
			env
		);
		const rows = (await res.json()) as LocalizationRow[];
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.locale_code === "fr-FR")).toStrictEqual({
			captured_at: 200,
			locale_code: "fr-FR",
			status: "present",
			title: "Fiche à jour",
		});
		expect(rows.find((r) => r.locale_code === "en-US")?.status).toBe("missing");
	});
});

async function seedSuggestions(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO suggestion (id, user_id, type, payload, status, created_at)
       VALUES (1, '${USER_ID}', 'promote_keyword', '{"keyword":"example keyword"}', 'pending', 100)`
		),
		env.DB.prepare(
			`INSERT INTO suggestion (id, user_id, type, payload, status, created_at)
       VALUES (2, '${USER_ID}', 'promote_keyword', '{"keyword":"another keyword"}', 'pending', 200)`
		),
		env.DB.prepare(
			`INSERT INTO suggestion (id, user_id, type, payload, status, created_at)
       VALUES (3, '${USER_ID}', 'promote_keyword', '{"keyword":"handled"}', 'accepted', 300)`
		),
	]);
}

function patchSuggestion(id: number, body: unknown): Request {
	return apiRequest(`/suggestions/${id}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "PATCH",
	});
}

describe("/api/suggestions", () => {
	it("returns an empty inbox when there is nothing pending", async () => {
		const res = await app.fetch(apiRequest("/suggestions"), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("lists only pending suggestions, newest first", async () => {
		await seedSuggestions();
		const res = await app.fetch(apiRequest("/suggestions"), env);
		const rows = (await res.json()) as SuggestionRow[];
		expect(rows.map((r) => r.id)).toStrictEqual([2, 1]);
		expect(rows[0]?.status).toBe("pending");
	});

	it("accepts a suggestion", async () => {
		await seedSuggestions();
		const res = await app.fetch(
			patchSuggestion(1, { status: "accepted" }),
			env
		);
		await expect(res.json()).resolves.toStrictEqual({ ok: true });
		const row = await env.DB.prepare(
			"SELECT status FROM suggestion WHERE id = 1"
		).first<{ status: string }>();
		expect(row?.status).toBe("accepted");
	});

	it("dismisses a suggestion", async () => {
		await seedSuggestions();
		await app.fetch(patchSuggestion(2, { status: "dismissed" }), env);
		const pending = await app.fetch(apiRequest("/suggestions"), env);
		const rows = (await pending.json()) as SuggestionRow[];
		expect(rows.map((r) => r.id)).toStrictEqual([1]);
	});

	it("rejects an unknown status without touching the row", async () => {
		await seedSuggestions();
		const res = await app.fetch(patchSuggestion(1, { status: "maybe" }), env);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual({
			error: "status must be accepted|dismissed",
		});
		const row = await env.DB.prepare(
			"SELECT status FROM suggestion WHERE id = 1"
		).first<{ status: string }>();
		expect(row?.status).toBe("pending");
	});
});
