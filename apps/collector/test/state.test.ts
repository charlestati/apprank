/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import {
	getState,
	getStateJson,
	setState,
	setStateJson,
	recordFetchError,
} from "../src/lib/state";

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM collector_state"),
		env.DB.prepare("DELETE FROM fetch_error"),
	]);
});

describe("collector_state", () => {
	it("returns null for keys that were never written", async () => {
		await expect(getState(env.DB, "missing")).resolves.toBeNull();
		await expect(getStateJson(env.DB, "missing")).resolves.toBeNull();
	});

	it("stores and reads back a scalar", async () => {
		await setState(env.DB, "ads:ad_account_id", "12345");
		await expect(getState(env.DB, "ads:ad_account_id")).resolves.toBe("12345");
	});

	it("overwrites an existing key instead of failing", async () => {
		await setState(env.DB, "k", "one");
		await setState(env.DB, "k", "two");
		await expect(getState(env.DB, "k")).resolves.toBe("two");
	});

	it("round-trips JSON values", async () => {
		await setStateJson(env.DB, "ads:focus_genres", [7019, 7012]);
		await expect(
			getStateJson<number[]>(env.DB, "ads:focus_genres")
		).resolves.toStrictEqual([7019, 7012]);
		await setStateJson(env.DB, "flag", true);
		await expect(getStateJson<boolean>(env.DB, "flag")).resolves.toBeTruthy();
	});
});

describe(recordFetchError, () => {
	it("records full provenance so a gap can be explained later", async () => {
		await recordFetchError(env.DB, {
			endpoint: "itunes:search",
			errorClass: "throttled",
			httpStatus: 429,
			params: "keyword|fr|fr-FR",
			r2Key: "verbatim/2026-09-01/x.json",
			responseMs: 42,
		});
		const row = await env.DB.prepare(
			"SELECT * FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<Record<string, unknown>>();
		expect(row?.endpoint).toBe("itunes:search");
		expect(row?.http_status).toBe(429);
		expect(row?.response_ms).toBe(42);
		expect(row?.error_class).toBe("throttled");
		expect(row?.r2_key).toBe("verbatim/2026-09-01/x.json");
	});

	it("accepts the minimal shape when there is no HTTP exchange to describe", async () => {
		await recordFetchError(env.DB, {
			endpoint: "task:crawl",
			errorClass: "unknown",
		});
		const row = await env.DB.prepare(
			"SELECT * FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<Record<string, unknown>>();
		expect(row?.http_status).toBeNull();
		expect(row?.params).toBeNull();
	});
});
