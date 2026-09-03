import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import app from "../src/index";
import { apiRequest, resetDb } from "./fixtures";

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
