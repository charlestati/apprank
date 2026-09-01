/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Task } from "../src/tasks/types";
import { fakeSearchResponse, stubFetch } from "./helpers";

function stub(name: string) {
	return env.SCHEDULER.get(env.SCHEDULER.idFromName(name));
}

function queueOf(name: string): Promise<Task[]> {
	return runInDurableObject(
		stub(name),
		async (_i, state) => (await state.storage.get<Task[]>("queue")) ?? []
	);
}

function alarmOf(name: string): Promise<number | null> {
	return runInDurableObject(stub(name), (_i, state) =>
		state.storage.getAlarm()
	);
}

async function reset(name: string) {
	await runInDurableObject(stub(name), async (_i, state) => {
		await state.storage.deleteAll();
	});
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM rank_entry"),
		env.DB.prepare("DELETE FROM ranking"),
		env.DB.prepare("DELETE FROM fetch_error"),
		env.DB.prepare("DELETE FROM collector_state"),
		env.DB.prepare("DELETE FROM chart_ranking"),
		env.DB.prepare("DELETE FROM crawl_pair"),
		env.DB.prepare("DELETE FROM keyword"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
		),
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function seedDuePair() {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (1, 'example keyword', 'example keyword', 'fr')"
		),
		env.DB.prepare(
			"INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (1, 1, 'fr', 'fr-FR', 1, 1, 24, 0)"
		),
	]);
}

describe("SchedulerDO work loop", () => {
	it("reports its queue depth", async () => {
		const name = "depth";
		await reset(name);
		await expect(stub(name).queueDepth()).resolves.toBe(0);
		await stub(name).enqueue([{ date: "2026-08-30", type: "compact" }]);
		await expect(stub(name).queueDepth()).resolves.toBe(1);
	});

	it("ignores an empty enqueue", async () => {
		const name = "empty-enqueue";
		await reset(name);
		await stub(name).enqueue([]);
		await expect(alarmOf(name)).resolves.toBeNull();
	});

	it("arms an alarm as soon as work is queued", async () => {
		const name = "arm";
		await reset(name);
		await stub(name).enqueue([{ date: "2026-08-30", type: "compact" }]);
		await expect(alarmOf(name)).resolves.not.toBeNull();
	});

	it("pulls in a far-future alarm when work becomes due", async () => {
		const name = "stale-alarm";
		await reset(name);
		await runInDurableObject(stub(name), async (_i, state) => {
			// A stale park from a previous deploy: an hour out, with work waiting.
			await state.storage.put("queue", [
				{ date: "2026-08-30", type: "compact" },
			]);
			await state.storage.setAlarm(Date.now() + 3_600_000);
		});
		await stub(name).ensureAlarm();
		const at = await alarmOf(name);
		expect(at).toBeLessThan(Date.now() + 60_000);
	});

	it("leaves a soon alarm alone", async () => {
		const name = "soon-alarm";
		await reset(name);
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.put("queue", [
				{ date: "2026-08-30", type: "compact" },
			]);
			await state.storage.setAlarm(Date.now() + 5000);
		});
		const before = await alarmOf(name);
		await stub(name).ensureAlarm();
		await expect(alarmOf(name)).resolves.toBe(before);
	});

	it("leaves a backoff park alone instead of waking every watchdog tick", async () => {
		// The one far-future alarm that is not stale. Pulling it in made the */10
		// cron wake the loop for the whole pause: two D1 reads and a heartbeat
		// write each time, to conclude it was still paused.
		const name = "paused-park";
		await reset(name);
		const pauseUntil = Date.now() + 4 * 3_600_000;
		await env.DB.prepare(
			"INSERT OR REPLACE INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, ?)"
		)
			.bind(
				JSON.stringify({
					lastErrorAt: Date.now(),
					lastRollDay: "",
					pauseUntil,
					ratePerMin: 1,
					throttlesPrevDay: 0,
					windowErrorCount: 5,
				}),
				Date.now()
			)
			.run();
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.put("queue", [
				{ date: "2026-08-30", type: "compact" },
			]);
			await state.storage.setAlarm(pauseUntil);
		});
		await stub(name).ensureAlarm();
		await expect(alarmOf(name)).resolves.toBe(pauseUntil);
	});

	it("still rescues a park that outlives the pause it was serving", async () => {
		const name = "stale-beyond-pause";
		await reset(name);
		await env.DB.prepare(
			"INSERT OR REPLACE INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, ?)"
		)
			.bind(
				JSON.stringify({
					lastErrorAt: Date.now(),
					lastRollDay: "",
					pauseUntil: Date.now() + 60_000,
					ratePerMin: 1,
					throttlesPrevDay: 0,
					windowErrorCount: 5,
				}),
				Date.now()
			)
			.run();
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.put("queue", [
				{ date: "2026-08-30", type: "compact" },
			]);
			// Parked far past the pause: a stale deploy artefact, not a backoff.
			await state.storage.setAlarm(Date.now() + 6 * 3_600_000);
		});
		await stub(name).ensureAlarm();
		const at = await alarmOf(name);
		expect(at).toBeLessThan(Date.now() + 60_000);
	});

	it("processes one queued task per tick and reschedules while work remains", async () => {
		const name = "one-per-tick";
		await reset(name);
		stubFetch(() =>
			Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			})
		);
		await stub(name).enqueue([
			{
				queue: [
					{ chart: "free", genreId: null, storefront: "fr" },
					{ chart: "paid", genreId: null, storefront: "fr" },
				],
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		// The step consumed the first unit and requeued the rest.
		const remaining = await queueOf(name);
		expect(remaining).toHaveLength(1);
		await expect(alarmOf(name)).resolves.not.toBeNull();
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM chart_ranking"
		).first<{ n: number }>();
		expect(rows?.n).toBe(1);
	});

	it("crawls a due pair when the task queue is empty", async () => {
		const name = "crawl-tick";
		await reset(name);
		await seedDuePair();
		stubFetch(() => Response.json(fakeSearchResponse(3)));
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ranking WHERE pair_id = 1"
		).first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it("parks the alarm until the pause expires after a throttle", async () => {
		const name = "paused";
		await reset(name);
		await seedDuePair();
		const pauseUntil = Date.now() + 1_800_000;
		await env.DB.prepare(
			"INSERT INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, 0)"
		)
			.bind(
				JSON.stringify({
					lastErrorAt: Date.now(),
					lastRaiseDay: "",
					pauseUntil,
					ratePerMin: 2,
					windowErrorCount: 1,
				})
			)
			.run();
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		// No fetch happened, and the alarm now sits just past the pause.
		const rankings = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ranking"
		).first<{ n: number }>();
		expect(rankings?.n).toBe(0);
		await expect(alarmOf(name)).resolves.toBeGreaterThanOrEqual(pauseUntil);
	});

	it("pauses and tallies the hit when a crawl is throttled", async () => {
		const name = "throttle";
		await reset(name);
		await seedDuePair();
		stubFetch(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		const row = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'pacing'"
		).first<{ value: string }>();
		const pacing = JSON.parse(row?.value ?? "{}");
		expect(pacing.pauseUntil).toBeGreaterThan(Date.now());
		expect(pacing.windowErrorCount).toBe(1);
		// The rate answers to the day's tally, not to one hit.
		expect(pacing.ratePerMin).toBe(4);
	});

	it("retries a failing task up to three attempts, then drops it", async () => {
		const name = "retry";
		await reset(name);
		// A network failure inside the step: the task is requeued with attempt+1.
		vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
		await stub(name).enqueue([
			{
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		for (let i = 0; i < 3; i += 1) {
			await runDurableObjectAlarm(stub(name));
		}
		await expect(queueOf(name)).resolves.toStrictEqual([]);
		const errors = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM fetch_error WHERE endpoint = 'task:chart_pull'"
		).first<{ n: number }>();
		expect(errors?.n).toBe(3);
	});

	it("pushes a pair to tomorrow when its crawl throws, so one bad pair cannot wedge the loop", async () => {
		const name = "crawl-throw";
		await reset(name);
		await seedDuePair();
		vi.stubGlobal("fetch", () => Promise.reject(new Error("connection reset")));
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		const row = await env.DB.prepare(
			"SELECT next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ next_due_at: number }>();
		expect(row?.next_due_at).toBeGreaterThan(Date.now());
		const err = await env.DB.prepare(
			"SELECT endpoint FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<{ endpoint: string }>();
		expect(err?.endpoint).toBe("task:crawl");
	});

	it("stops scheduling once the queue drains and nothing is due", async () => {
		const name = "drain";
		await reset(name);
		stubFetch(() =>
			Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			})
		);
		await stub(name).enqueue([
			{
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		// One more tick to observe the drained state.
		await runDurableObjectAlarm(stub(name));
		await expect(queueOf(name)).resolves.toStrictEqual([]);
		await expect(alarmOf(name)).resolves.toBeNull();
	});

	it("keeps an admin-triggered throttle out of the day's tally", async () => {
		const name = "admin-throttle";
		await reset(name);
		await seedDuePair();
		stubFetch(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);
		const before = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'pacing'"
		).first<{ value: string }>();

		const result = await stub(name).crawlNow();
		expect(result).toMatchObject({ throttled: true });

		const row = await env.DB.prepare(
			"SELECT value FROM collector_state WHERE key = 'pacing'"
		).first<{ value: string }>();
		const pacing = JSON.parse(row?.value ?? "{}");
		// Recorded, but it must not steer the rate the loop earned.
		expect(pacing.lastErrorAt).toBeGreaterThan(0);
		expect(pacing.windowErrorCount).toBe(0);
		expect(pacing.pauseUntil).toBe(
			before ? JSON.parse(before.value).pauseUntil : 0
		);
	});
});
