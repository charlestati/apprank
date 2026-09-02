/* oxlint-disable vitest/require-top-level-describe, vitest/max-expects -- the daily-cron test asserts the whole
   task fan-out in one place; splitting it would re-run the same cron. */

import {
	createExecutionContext,
	createScheduledController,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import worker from "../src/index";
import { setState } from "../src/lib/state";
import { latestCompleteWeekStart } from "../src/tasks/ads";
import type { Task } from "../src/tasks/types";
import { generateP8Pem } from "./helpers";

const APP_ID = 424_242;

// The scheduler's queue lives in Durable Object storage; inspect it directly
// rather than widening the production RPC surface for tests.
function schedulerStub() {
	return env.SCHEDULER.get(env.SCHEDULER.idFromName("singleton"));
}

function drainQueue(): Promise<Task[]> {
	return runInDurableObject(schedulerStub(), async (_instance, state) => {
		const tasks = (await state.storage.get<Task[]>("queue")) ?? [];
		await state.storage.put("queue", []);
		await state.storage.deleteAlarm();
		return tasks;
	});
}

function alarmAt(): Promise<number | null> {
	return runInDurableObject(schedulerStub(), (_instance, state) =>
		state.storage.getAlarm()
	);
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM collector_state"),
		env.DB.prepare("DELETE FROM fetch_error"),
		env.DB.prepare("DELETE FROM asc_report_instance"),
		env.DB.prepare("DELETE FROM crawl_pair"),
		env.DB.prepare("DELETE FROM app_language"),
		env.DB.prepare("DELETE FROM tracked_app"),
		env.DB.prepare("DELETE FROM app"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront_locale (storefront_code, locale_code, is_default) VALUES ('fr', 'fr-FR', 1)"
		),
	]);
	await drainQueue();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function runCron(cron: string, overrides: Record<string, unknown> = {}) {
	const controller = createScheduledController({
		cron,
		scheduledTime: new Date(),
	});
	const ctx = createExecutionContext();
	await worker.scheduled(controller, { ...env, ...overrides } as never, ctx);
}

describe("scheduled handler", () => {
	it("does nothing for a cron expression it does not own", async () => {
		await runCron("0 0 1 1 *");
		await expect(drainQueue()).resolves.toStrictEqual([]);
	});

	it("queues the nightly compaction on the daily cron", async () => {
		await runCron("0 3 * * *");
		const tasks = await drainQueue();
		const compact = tasks.find((t) => t.type === "compact");
		expect(compact).toBeDefined();
		const yesterday = new Date(Date.now() - 24 * 3_600_000)
			.toISOString()
			.slice(0, 10);
		expect(compact).toMatchObject({ date: yesterday });
	});

	it("skips the Apple API jobs while their secrets are unset", async () => {
		await runCron("0 3 * * *");
		const tasks = await drainQueue();
		expect(tasks.some((t) => t.type === "asc_poll")).toBeFalsy();
		expect(tasks.some((t) => t.type === "ads_pull")).toBeFalsy();
	});

	it("queues the ASC poll once its credentials exist", async () => {
		const { pem } = await generateP8Pem();
		await runCron("0 3 * * *", {
			ASC_ISSUER_ID: "issuer",
			ASC_KEY_ID: "key",
			ASC_PRIVATE_KEY: pem,
		});
		const tasks = await drainQueue();
		expect(tasks.some((t) => t.type === "asc_poll")).toBeTruthy();
	});

	it("derives lookup, review and chart pulls from the tracked apps in D1", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO app (id, current_name, primary_genre_id, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 6013, 0, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO app_language (app_id, language) VALUES (?, 'fr')"
			).bind(APP_ID),
		]);

		await runCron("0 3 * * *");
		const tasks = await drainQueue();

		const lookup = tasks.find((t) => t.type === "lookup_pull");
		expect(lookup).toMatchObject({
			queue: [{ appId: APP_ID, localeCode: "fr-FR", storefront: "fr" }],
		});
		const review = tasks.find((t) => t.type === "review_pull");
		expect(review).toMatchObject({
			queue: [{ appId: APP_ID, storefront: "fr" }],
		});
		const charts = tasks.find((t) => t.type === "chart_pull");
		// Two genre slots (the tracked app's own genre + storefront-wide) × three
		// charts. The genre is not hardcoded: an app in any category gets its own.
		expect((charts as { queue: unknown[] }).queue).toHaveLength(6);
	});

	it("charts storefront-wide only until an app's genre is known", async () => {
		// A fresh deploy has looked nothing up yet, and under
		// COLLECTION_MODE=credentialed that lookup runs from the Actions runner
		// rather than this Worker, so primary_genre_id stays null for a while.
		// Guessing a category would write popularity for terms nobody tracks, so
		// the genre-keyed work is skipped and the storefront-wide chart, which
		// needs no genre, still runs.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 0, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO app_language (app_id, language) VALUES (?, 'fr')"
			).bind(APP_ID),
		]);

		await runCron("0 3 * * *", { ADS_CLIENT_ID: "x" });
		const tasks = await drainQueue();

		expect(tasks.some((t) => t.type === "ads_pull")).toBeFalsy();
		const charts = tasks.find((t) => t.type === "chart_pull");
		// One genre slot (storefront-wide) × three charts.
		expect((charts as { queue: unknown[] }).queue).toHaveLength(3);
	});

	it("queues no app-level pulls when nothing is tracked", async () => {
		await runCron("0 3 * * *");
		const tasks = await drainQueue();
		expect(tasks.some((t) => t.type === "lookup_pull")).toBeFalsy();
		expect(tasks.some((t) => t.type === "chart_pull")).toBeFalsy();
	});

	it("raises the learned crawl rate on a clean day", async () => {
		await env.DB.prepare(
			"INSERT INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, 0)"
		)
			.bind(
				JSON.stringify({
					lastErrorAt: 0,
					lastRaiseDay: "",
					pauseUntil: 0,
					ratePerMin: 4,
					windowErrorCount: 0,
				})
			)
			.run();
		await runCron("0 3 * * *");
		const row = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'pacing'"
		).first<{ value: string }>();
		expect(JSON.parse(row?.value ?? "{}").ratePerMin).toBeCloseTo(4.4, 5);
	});

	it("flags an ASC date Apple never published while running the daily jobs", async () => {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-28', 'i1', 0)`
			),
			env.DB.prepare(
				`INSERT INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, fetched_at) VALUES (${APP_ID}, 'R', 'DAILY', '2026-08-30', 'i2', 0)`
			),
		]);
		await runCron("0 3 * * *");
		const err = await env.DB.prepare(
			"SELECT error_class FROM fetch_error WHERE error_class = 'skipped_processing_date'"
		).first();
		expect(err).not.toBeNull();
	});

	it("arms the work loop from the watchdog cron when a pair is due", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (1, 'kw', 'kw', 'fr')"
			),
			env.DB.prepare(
				"INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, 0)"
			),
		]);
		await runCron("*/10 * * * *");
		await expect(alarmAt()).resolves.not.toBeNull();
	});

	it("leaves the alarm unset when there is no work", async () => {
		await runCron("*/10 * * * *");
		await expect(alarmAt()).resolves.toBeNull();
	});
});

describe("collection mode", () => {
	it("queues no public-endpoint work on a credentialed-only deployment", async () => {
		// Cloudflare's egress is rejected by Apple's public endpoints, so queueing
		// lookups, reviews and charts there produces nothing but throttles, and
		// each one feeds the daily tally that halves the learned rate.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO app (id, current_name, primary_genre_id, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 6013, 0, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO app_language (app_id, language) VALUES (?, 'fr')"
			).bind(APP_ID),
		]);
		await runCron("0 3 * * *", { COLLECTION_MODE: "credentialed" });
		const queued = await drainQueue();
		const types = queued.map((t) => t.type);
		expect(types).not.toContain("lookup_pull");
		expect(types).not.toContain("review_pull");
		expect(types).not.toContain("chart_pull");
		// Compaction is local work and must still run.
		expect(types).toContain("compact");
	});

	it("still queues them when the deployment can reach Apple", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO app (id, current_name, primary_genre_id, first_seen_at, last_seen_at) VALUES (?, 'Tracked App', 6013, 0, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', ?, 0)"
			).bind(APP_ID),
			env.DB.prepare(
				"INSERT INTO app_language (app_id, language) VALUES (?, 'fr')"
			).bind(APP_ID),
		]);
		await runCron("0 3 * * *", { COLLECTION_MODE: "all" });
		const queued = await drainQueue();
		const types = queued.map((t) => t.type);
		expect(types).toContain("lookup_pull");
		expect(types).toContain("chart_pull");
	});
});

describe("ads weekly gate", () => {
	// The Ads pull is Monday-only, so these must run on one or the cron never
	// queues the task and the assertions pass for the wrong reason.
	const MONDAY = new Date("2026-09-07T03:00:00Z");

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(MONDAY);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR IGNORE INTO genre (id, name, parent_id) VALUES (6013, 'Health & Fitness', NULL)"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO app (id, current_name, primary_genre_id, first_seen_at, last_seen_at) VALUES (424242, 'Tracked App', 6013, 0, 0)"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', 424242, 0)"
			),
		]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("queues the pull when the week has not been collected", async () => {
		await runCron("0 3 * * *", { ADS_CLIENT_ID: "x" });
		const queued = await drainQueue();
		expect(queued.find((t) => t.type === "ads_pull")).toBeDefined();
	});

	it("skips a storefront whose week is already held", async () => {
		// Apple publishes WEEKLY_SUN_SAT: a second pull of the same week fetches
		// identical data and re-walks 500 terms per unit for nothing.
		await setState(
			env.DB,
			"ads:pulled:fr:HEALTH_FITNESS",
			latestCompleteWeekStart()
		);
		await runCron("0 3 * * *", { ADS_CLIENT_ID: "x" });
		const queued = await drainQueue();
		expect(queued.find((t) => t.type === "ads_pull")).toBeUndefined();
	});

	it("still pulls once the published week moves on", async () => {
		await setState(env.DB, "ads:pulled:fr:GAMES", "1999-01-03");
		await runCron("0 3 * * *", { ADS_CLIENT_ID: "x" });
		const queued = await drainQueue();
		expect(queued.find((t) => t.type === "ads_pull")).toBeDefined();
	});
});
