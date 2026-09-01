/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite here, not a per-suite one. */

/* oxlint-disable vitest/max-expects -- the data-health endpoint returns one
   composite object; asserting it field by field is what makes a regression
   readable. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index";
import {
	APP_ID,
	RIVAL_ID,
	apiRequest,
	isoDay,
	resetDb,
	seedCatalog,
	seedTrackedApp,
} from "./fixtures";

beforeEach(resetDb);

interface HealthBody {
	ok: boolean;
	activeStorefronts: number;
}

interface DataHealthBody {
	ascAnomalies: { app_id: number; report_type: string; anomaly: string }[];
	cadence: unknown;
	collectedToday: number;
	date: string;
	errorsLast24h: {
		errorClass: string;
		n: number;
		lastAt: number;
		message: string | null;
	}[];
	pacing: { ratePerMin: number } | null;
	tier1Pairs: number;
	loop: { at: number; queued: number; didWork: boolean } | null;
	lastDailyRun: {
		startedAt: number;
		finishedAt: number | null;
		ok: boolean | null;
		trigger: string;
		queued: number | null;
	} | null;
	overduePairs: number;
}

describe("GET /api/health", () => {
	it("reports zero active storefronts on an empty database", async () => {
		const res = await app.fetch(apiRequest("/health"), env);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual({
			activeStorefronts: 0,
			ok: true,
		});
	});

	it("counts only active storefronts", async () => {
		await seedCatalog();
		const res = await app.fetch(apiRequest("/health"), env);
		const body = (await res.json()) as HealthBody;
		expect(body.ok).toBeTruthy();
		expect(body.activeStorefronts).toBe(2);
	});
});

describe("GET /api/health/data", () => {
	it("returns empty counters and a null pacing state with no data", async () => {
		const res = await app.fetch(apiRequest("/health/data"), env);
		const body = (await res.json()) as DataHealthBody;
		expect(res.status).toBe(200);
		expect(body).toStrictEqual({
			ascAnomalies: [],
			cadence: null,
			collectedToday: 0,
			date: isoDay(),
			errorsLast24h: [],
			// A collector that has never ticked reports null, not a stale-looking
			// zero: "we do not know" and "it ran and did nothing" differ.
			lastDailyRun: null,
			loop: null,
			overduePairs: 0,
			pacing: null,
			tier1Pairs: 0,
		});
	});

	it("summarises tier-1 pairs, today's collection, errors, pacing and anomalies", async () => {
		await seedCatalog();
		await seedTrackedApp();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO keyword (id, text, normalized, language) VALUES (1, 'example keyword', 'example keyword', 'fr')"
			),
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 0)`
			),
			// Tier 2 and unreferenced pairs must not be counted.
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (2, 1, 'us', 'en-US', 2, 1, 0)`
			),
			env.DB.prepare(
				`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
         VALUES (1, 1, ?1, 0, 200, 200, '[]', 'test', 1)`
			).bind(isoDay()),
			// Yesterday and invalid rows are outside today's coverage.
			env.DB.prepare(
				`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
         VALUES (2, 1, ?1, 0, 200, 200, '[]', 'test', 1)`
			).bind(isoDay(1)),
			env.DB.prepare(
				`INSERT INTO ranking (id, pair_id, observed_date, fetched_at, http_status, result_count, result_ids, collector_version, valid)
         VALUES (3, 2, ?1, 0, 500, 0, '[]', 'test', 0)`
			).bind(isoDay()),
			env.DB.prepare(
				"INSERT INTO fetch_error (fetched_at, endpoint, error_class) VALUES (?1, '/search', 'throttled')"
			).bind(Date.now()),
			env.DB.prepare(
				"INSERT INTO fetch_error (fetched_at, endpoint, error_class) VALUES (?1, '/search', 'throttled')"
			).bind(Date.now()),
			env.DB.prepare(
				"INSERT INTO fetch_error (fetched_at, endpoint, error_class, message) VALUES (?1, '/search', 'timeout', 'Invalid genre value.')"
			).bind(Date.now()),
			// Older than 24h: ignored.
			env.DB.prepare(
				"INSERT INTO fetch_error (fetched_at, endpoint, error_class) VALUES (?1, '/search', 'ancient')"
			).bind(Date.now() - 48 * 3_600_000),
			env.DB.prepare(
				"INSERT INTO collector_state (key, value) VALUES ('pacing', '{\"ratePerMin\":12}')"
			),
			env.DB.prepare(
				`INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, anomaly, fetched_at)
         VALUES (?1, 'APP_STORE_DISCOVERY_AND_ENGAGEMENT', 'DAILY', '2026-01-02', 'duplicate', 0)`
			).bind(APP_ID),
			env.DB.prepare(
				`INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, anomaly, fetched_at)
         VALUES (?1, 'APP_STORE_DOWNLOADS', 'DAILY', '2026-01-01', NULL, 0)`
			).bind(APP_ID),
			// Another operator's app: same report type and date, and an anomaly of
			// its own. It must not appear in this caller's health page — first-party
			// analytics is the one part of the collector's output that is not shared.
			env.DB.prepare(
				`INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, anomaly, fetched_at)
         VALUES (?1, 'APP_STORE_DISCOVERY_AND_ENGAGEMENT', 'DAILY', '2026-01-02', 'duplicate', 0)`
			).bind(RIVAL_ID),
		]);

		const res = await app.fetch(apiRequest("/health/data"), env);
		const body = (await res.json()) as DataHealthBody;
		expect(body.tier1Pairs).toBe(1);
		expect(body.collectedToday).toBe(1);
		expect(
			body.errorsLast24h.map((e) => ({ errorClass: e.errorClass, n: e.n }))
		).toStrictEqual([
			{ errorClass: "throttled", n: 2 },
			{ errorClass: "timeout", n: 1 },
		]);
		// Timestamps and the upstream message travel with the group: a class and
		// a count alone are not actionable.
		expect(body.errorsLast24h[0]?.lastAt).toBeGreaterThan(0);
		expect(body.errorsLast24h[1]?.message).toBe("Invalid genre value.");
		expect(body.pacing).toStrictEqual({ ratePerMin: 12 });
		expect(body.ascAnomalies).toStrictEqual([
			{
				anomaly: "duplicate",
				app_id: APP_ID,
				processing_date: "2026-01-02",
				report_type: "APP_STORE_DISCOVERY_AND_ENGAGEMENT",
			},
		]);
	});

	it("reports loop liveness, the last daily run and overdue pairs", async () => {
		await seedCatalog();
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO keyword (id, text, normalized, language) VALUES (1, 'example keyword', 'example keyword', 'fr')"
			),
			// Due 30h ago on a 24h interval: overdue by more than one full interval.
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at)
         VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, ?1)`
			).bind(now - 30 * 3_600_000),
			// Late but within one interval: stretched, not lost. Not counted.
			env.DB.prepare(
				`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at)
         VALUES (2, 1, 'us', 'en-US', 1, 1, 24, ?1)`
			).bind(now - 3_600_000),
			env.DB.prepare(
				"INSERT INTO collector_state (key, value) VALUES ('loop_heartbeat', ?1)"
			).bind(JSON.stringify({ at: now, didWork: true, queued: 2 })),
			env.DB.prepare(
				`INSERT INTO collector_run (job, trigger, started_at, finished_at, ok, detail)
         VALUES ('daily', 'cron', ?1, ?2, 1, '{"queued":7}')`
			).bind(now - 7_200_000, now - 7_100_000),
		]);

		const res = await app.fetch(apiRequest("/health/data"), env);
		const body = (await res.json()) as DataHealthBody;
		expect(body.loop).toStrictEqual({ at: now, didWork: true, queued: 2 });
		expect(body.lastDailyRun?.ok).toBeTruthy();
		expect(body.lastDailyRun?.queued).toBe(7);
		expect(body.lastDailyRun?.trigger).toBe("cron");
		expect(body.overduePairs).toBe(1);
	});

	it("shows the newest daily run, and marks one that never finished", async () => {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO collector_run (job, trigger, started_at, finished_at, ok, detail)
         VALUES ('daily', 'cron', ?1, ?2, 1, '{"queued":7}')`
			).bind(now - 90_000_000, now - 89_000_000),
			// Started and never closed: the crash the observation tables cannot show.
			env.DB.prepare(
				"INSERT INTO collector_run (job, trigger, started_at) VALUES ('daily', 'admin', ?1)"
			).bind(now - 60_000),
		]);

		const res = await app.fetch(apiRequest("/health/data"), env);
		const body = (await res.json()) as DataHealthBody;
		expect(body.lastDailyRun?.trigger).toBe("admin");
		expect(body.lastDailyRun?.finishedAt).toBeNull();
		expect(body.lastDailyRun?.ok).toBeNull();
	});
});
