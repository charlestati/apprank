import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import app from "../src/index";
import { PREFERENCE_ROW_CAP } from "../src/queries/preferences";
import { apiRequest, resetDb } from "./fixtures";

function store(key: string, value = "[1]") {
	return app.fetch(
		apiRequest(`/preferences/${encodeURIComponent(key)}`, {
			body: JSON.stringify({ value }),
			method: "PUT",
		}),
		env
	);
}

describe("preferences", () => {
	// No seed: a preference is keyed by the caller's user id alone and carries no
	// foreign key, which is what lets it be written before an app is tracked.
	beforeEach(resetDb);

	it("returns an empty object before anything is chosen", async () => {
		const res = await app.fetch(apiRequest("/preferences"), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual({});
	});

	it("stores a choice and gives it back", async () => {
		const put = await app.fetch(
			apiRequest("/preferences/app", {
				body: JSON.stringify({ value: "42" }),
				method: "PUT",
			}),
			env
		);
		expect(put.status).toBe(204);
		const res = await app.fetch(apiRequest("/preferences"), env);
		await expect(res.json()).resolves.toStrictEqual({ app: "42" });
	});

	it("overwrites rather than accumulating", async () => {
		for (const value of ["en", "fr"]) {
			await app.fetch(
				apiRequest("/preferences/lang", {
					body: JSON.stringify({ value }),
					method: "PUT",
				}),
				env
			);
		}
		const res = await app.fetch(apiRequest("/preferences"), env);
		await expect(res.json()).resolves.toStrictEqual({ lang: "fr" });
	});

	it("clears a preference when no value is given", async () => {
		await app.fetch(
			apiRequest("/preferences/lang", {
				body: JSON.stringify({ value: "fr" }),
				method: "PUT",
			}),
			env
		);
		// Absent, not empty string: the reader is going back to the default rather
		// than pinning whichever default they first happened to see.
		await app.fetch(
			apiRequest("/preferences/lang", { body: "{}", method: "PUT" }),
			env
		);
		const res = await app.fetch(apiRequest("/preferences"), env);
		await expect(res.json()).resolves.toStrictEqual({});
	});

	it("stores only the keys the interface writes", async () => {
		// The key is a path segment: without an allow-list it is as good a place
		// to park text as the value the cap was written for.
		for (const key of [
			"anything",
			"x".repeat(500),
			"chart:1",
			"chart:abc:fr",
			"chart:1:fr:extra",
			"app2",
		]) {
			const res = await app.fetch(
				apiRequest(`/preferences/${encodeURIComponent(key)}`, {
					body: JSON.stringify({ value: "1" }),
					method: "PUT",
				}),
				env
			);
			expect([key, res.status]).toStrictEqual([key, 400]);
		}
		for (const key of ["app", "lang", "health:ack", "chart:424242:fr"]) {
			const res = await app.fetch(
				apiRequest(`/preferences/${encodeURIComponent(key)}`, {
					body: JSON.stringify({ value: "1" }),
					method: "PUT",
				}),
				env
			);
			expect([key, res.status]).toStrictEqual([key, 204]);
		}
		const res = await app.fetch(apiRequest("/preferences"), env);
		await expect(res.json()).resolves.toStrictEqual({
			app: "1",
			"chart:424242:fr": "1",
			"health:ack": "1",
			lang: "1",
		});
	});

	it("caps the rows one account can hold, and still updates the ones it has", async () => {
		await env.DB.prepare(
			`INSERT INTO user_preference (user_id, key, value, updated_at)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       SELECT 'admin', 'chart:' || i || ':fr', '[]', 0 FROM n`
		)
			.bind("unused", PREFERENCE_ROW_CAP)
			.run();
		const refused = await store("chart:999999:fr");
		expect(refused.status).toBe(400);
		const updated = await store("chart:1:fr");
		expect(updated.status).toBe(204);

		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n, SUM(value = '[1]') AS changed FROM user_preference WHERE user_id = 'admin'"
		).first<{ n: number; changed: number }>();
		expect(rows).toStrictEqual({ changed: 1, n: PREFERENCE_ROW_CAP });
	});

	it("refuses a value too large to be a preference", async () => {
		const res = await app.fetch(
			apiRequest("/preferences/chart:1:fr", {
				body: JSON.stringify({ value: "x".repeat(2001) }),
				method: "PUT",
			}),
			env
		);
		expect(res.status).toBe(400);
	});
});
