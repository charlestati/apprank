/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { Task } from "../src/tasks/types";
import { fakeSearchResponse, stubFetch } from "./helpers";

// Every object a test reached, so the file can leave none of them armed.
const touched = new Set<string>();

function stub(name: string) {
	touched.add(name);
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

afterEach(async () => {
	vi.unstubAllGlobals();
	// An alarm left armed keeps ticking after its test: against the pairs the
	// next test seeds, skewing a throttle tally asserted as exactly one, and
	// against the real network once the stub above is gone.
	for (const name of touched) {
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.deleteAlarm();
			await state.storage.deleteAll();
		});
	}
	touched.clear();
});

function loopFetchesOf(name: string): Promise<number> {
	return runInDurableObject(
		stub(name),
		async (_i, state) => (await state.storage.get<number>("loopFetches")) ?? 0
	);
}

function storedPacing(): Promise<{
	pauseUntil: number;
	windowErrorCount: number;
	lastErrorAt: number;
	ratePerMin: number;
}> {
	return env.DB.prepare(
		"SELECT value FROM collector_state WHERE key = 'pacing'"
	)
		.first<{ value: string }>()
		.then((row) => JSON.parse(row?.value ?? "{}"));
}

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
		const before = Date.now();
		await runDurableObjectAlarm(stub(name));
		// The step consumed the first unit and requeued the rest.
		const remaining = await queueOf(name);
		expect(remaining).toHaveLength(1);
		// The next tick is a whole interval away: 60s over the cold-start 4/min,
		// less the jitter's 25%. Re-arming any sooner is the fetch rate rising
		// (invariant 4).
		const next = await alarmOf(name);
		expect(next).toBeGreaterThanOrEqual(before + (60_000 / 4) * 0.75);
		expect(next).toBeLessThanOrEqual(Date.now() + (60_000 / 4) * 1.25);
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
		expect(row?.next_due_at).toBeGreaterThan(Date.now() + 20 * 3_600_000);
		const err = await env.DB.prepare(
			"SELECT endpoint, params FROM fetch_error ORDER BY id DESC LIMIT 1"
		).first<{ endpoint: string; params: string }>();
		expect(err?.endpoint).toBe("task:crawl");
		// The shape the report and coverage page join on; a bare pair id kept
		// this loss off the chart.
		expect(err?.params).toBe("example keyword|fr|fr-FR");
	});

	it("brings a pair back soon when its search timed out, instead of losing the day", async () => {
		// A hung connection is not a broken pair. Pushed to tomorrow, the pair had
		// no rank for today, and a day nobody recorded cannot be backfilled.
		const name = "crawl-timeout";
		await reset(name);
		await seedDuePair();
		vi.stubGlobal("fetch", () =>
			Promise.reject(
				new DOMException("The operation timed out.", "TimeoutError")
			)
		);
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		const row = await env.DB.prepare(
			"SELECT next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ next_due_at: number }>();
		expect(row?.next_due_at).toBeGreaterThan(Date.now());
		expect(row?.next_due_at).toBeLessThan(Date.now() + 2 * 3_600_000);
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

const ADS_UNIT = { category: "PRODUCTIVITY", genreId: 6007, storefront: "fr" };

describe("SchedulerDO during an Apple Ads refusal", () => {
	it("parks until the refusal lifts when only Ads tasks are queued", async () => {
		const name = "ads-refused-park";
		await reset(name);
		const until = Date.now() + 3_600_000;
		await env.DB.prepare(
			"INSERT INTO collector_state (key, value, updated_at) VALUES ('ads:refused_until', ?, ?)"
		)
			.bind(String(until), Date.now())
			.run();
		const fetched = stubFetch(() => new Response("{}", { status: 500 }));
		await stub(name).enqueue([
			{ queue: [ADS_UNIT], type: "ads_pull", weekStart: "2026-08-23" } as Task,
		]);

		await runDurableObjectAlarm(stub(name));

		expect(fetched).toHaveLength(0);
		await expect(queueOf(name)).resolves.toHaveLength(1);
		const alarm = await alarmOf(name);
		expect(alarm).toBeGreaterThanOrEqual(until);
	});

	it("keeps ticking at pace when something other than Ads is queued", async () => {
		const name = "ads-refused-mixed";
		await reset(name);
		const until = Date.now() + 3_600_000;
		await env.DB.prepare(
			"INSERT INTO collector_state (key, value, updated_at) VALUES ('ads:refused_until', ?, ?)"
		)
			.bind(String(until), Date.now())
			.run();
		stubFetch(() => new Response("{}", { status: 500 }));
		await stub(name).enqueue([
			{ queue: [ADS_UNIT], type: "ads_pull", weekStart: "2026-08-23" } as Task,
			{ date: "2026-08-30", type: "compact" },
		]);

		await runDurableObjectAlarm(stub(name));

		const alarm = await alarmOf(name);
		expect(alarm).toBeLessThan(until);
	});
});

describe("SchedulerDO queue under interleaving", () => {
	it("keeps a task enqueued while a step is awaiting Apple", async () => {
		// The step's fetch opens the input gate, so the 03:00 cron's enqueue can
		// land mid-step. Writing back the queue read before the step erased it.
		const name = "interleave";
		await reset(name);
		let enqueued = false;
		stubFetch(async () => {
			if (!enqueued) {
				enqueued = true;
				await stub(name).enqueue([{ date: "2026-08-30", type: "compact" }]);
			}
			return Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			});
		});
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
		const queue = await queueOf(name);
		expect(queue.map((t) => t.type)).toStrictEqual(["compact", "chart_pull"]);
		expect(new Set(queue.map((t) => t.id)).size).toBe(2);
	});

	it("runs a task queued before ids existed, and removes it once done", async () => {
		const name = "legacy-queue";
		await reset(name);
		stubFetch(() =>
			Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			})
		);
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.put("queue", [
				{
					queue: [{ chart: "free", genreId: null, storefront: "fr" }],
					type: "chart_pull",
				},
			]);
		});
		await stub(name).ensureAlarm();
		await expect(runDurableObjectAlarm(stub(name))).resolves.toBeTruthy();
		await expect(queueOf(name)).resolves.toStrictEqual([]);
	});

	it("puts a task back when a manual step throws, instead of losing the batch", async () => {
		const name = "singleton";
		await reset(name);
		vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
		await stub(name).enqueue([
			{
				queue: [
					{ chart: "free", genreId: null, storefront: "fr" },
					{ chart: "paid", genreId: null, storefront: "fr" },
				],
				type: "chart_pull",
			},
		]);
		const result = await stub(name).stepNow();
		expect(result).toMatchObject({ empty: false, ok: false });
		const [task] = await queueOf(name);
		expect(task).toMatchObject({ threw: 1, type: "chart_pull" });
		expect(task?.type === "chart_pull" && task.queue).toHaveLength(2);
	});

	it("counts throws apart from the throttle retries the step spent", async () => {
		// Two throttles already on the batch: sharing one counter, a single throw
		// took it to the cap and dropped every unit.
		const name = "throw-after-throttles";
		await reset(name);
		vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
		await stub(name).enqueue([
			{
				attempt: 2,
				queue: [
					{ chart: "free", genreId: null, storefront: "fr" },
					{ chart: "paid", genreId: null, storefront: "fr" },
				],
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		await expect(queueOf(name)).resolves.toMatchObject([
			{ attempt: 2, threw: 1, type: "chart_pull" },
		]);
	});

	it("gives up on the unit that keeps throwing and keeps the rest of the batch", async () => {
		const name = "throw-cap";
		await reset(name);
		vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
		await stub(name).enqueue([
			{
				queue: [
					{ chart: "free", genreId: null, storefront: "fr" },
					{ chart: "paid", genreId: null, storefront: "fr" },
				],
				type: "chart_pull",
			},
		]);
		for (let i = 0; i < 3; i += 1) {
			await runDurableObjectAlarm(stub(name));
		}
		await expect(queueOf(name)).resolves.toMatchObject([
			{
				queue: [{ chart: "paid", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		const lost = await env.DB.prepare(
			"SELECT DISTINCT params FROM fetch_error WHERE endpoint = 'task:chart_pull' AND error_class = 'task_threw'"
		).all<{ params: string }>();
		expect(lost.results.map((r) => JSON.parse(r.params))).toStrictEqual([
			{ chart: "free", genreId: null, storefront: "fr" },
		]);
	});

	it("does not count a deploy restart against the task", async () => {
		const name = "restart-uncounted";
		await reset(name);
		vi.stubGlobal("fetch", () =>
			Promise.reject(
				new Error("Durable Object reset because its code was updated.")
			)
		);
		await stub(name).enqueue([
			{
				attempt: 2,
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				threw: 2,
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		await expect(queueOf(name)).resolves.toMatchObject([
			{ attempt: 2, threw: 2, type: "chart_pull" },
		]);
	});
});

describe("SchedulerDO throw cap and settling", () => {
	it("gives up the lookup that keeps throwing, names it, and keeps the rest", async () => {
		const name = "lookup-throw-cap";
		await reset(name);
		vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
		const first = { appId: 1, localeCode: "fr-FR", storefront: "fr" };
		const second = { appId: 2, localeCode: "fr-FR", storefront: "fr" };
		await stub(name).enqueue([{ queue: [first, second], type: "lookup_pull" }]);
		for (let i = 0; i < 3; i += 1) {
			await runDurableObjectAlarm(stub(name));
		}
		await expect(queueOf(name)).resolves.toMatchObject([
			{ queue: [second], type: "lookup_pull" },
		]);
		const lost = await env.DB.prepare(
			"SELECT DISTINCT params FROM fetch_error WHERE endpoint = 'task:lookup_pull' AND error_class = 'task_threw'"
		).all<{ params: string }>();
		expect(lost.results.map((r) => JSON.parse(r.params))).toStrictEqual([
			first,
		]);
	});

	it.each([
		{
			queue: [
				{ appId: 1, localeCode: "fr-FR", storefront: "fr" },
				{ appId: 2, localeCode: "fr-FR", storefront: "fr" },
			],
			type: "lookup_pull",
		},
		{
			queue: [
				{ appId: 1, storefront: "fr" },
				{ appId: 2, storefront: "fr" },
			],
			type: "review_pull",
		},
	] as Task[])(
		"parks the loop on a throttled $type, and a step that returned starts a fresh throw count",
		async (task) => {
			// Two throws already on the batch: the throttle requeue spreads the task,
			// so without the reset the next throw would give up a unit at once.
			const name = `throttled-${task.type}`;
			await reset(name);
			stubFetch(() =>
				Response.json({ resultCount: 0, results: [] }, { status: 403 })
			);
			await stub(name).enqueue([{ ...task, threw: 2 }]);
			await runDurableObjectAlarm(stub(name));
			const [next] = await queueOf(name);
			expect(next).toMatchObject({ attempt: 1, threw: 0, type: task.type });
			const row = await env.DB.prepare(
				"SELECT value FROM collector_state WHERE key = 'pacing'"
			).first<{ value: string }>();
			expect(JSON.parse(row?.value ?? "{}").pauseUntil).toBeGreaterThan(
				Date.now()
			);
		}
	);

	it("does not fetch the head task a second time when a manual step lands mid-alarm", async () => {
		// The alarm's fetch opens the input gate, and the task stays queued while
		// it runs, so a manual step used to read the same head task and fetch its
		// unit from Apple again. It now sees the task is being run and leaves it.
		const name = "settled-elsewhere";
		await reset(name);
		let manual: unknown;
		const calls = stubFetch(async () => {
			if (manual === undefined) {
				manual = "running";
				manual = await stub(name).stepNow();
				// The nightly cron landing in the same window must survive too.
				await stub(name).enqueue([{ date: "2026-08-30", type: "compact" }]);
			}
			return Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			});
		});
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
		expect(manual).toStrictEqual({ empty: true });
		expect(calls).toHaveLength(1);
		await expect(queueOf(name)).resolves.toMatchObject([
			{ date: "2026-08-30", type: "compact" },
			{
				queue: [{ chart: "paid", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
	});

	it("lets a manual step run the next task while the alarm holds the head", async () => {
		const name = "step-past-head";
		await reset(name);
		let manual: unknown;
		stubFetch(async () => {
			if (manual === undefined) {
				manual = "running";
				manual = await stub(name).stepNow();
			}
			return Response.json({
				feed: { entry: [{ id: { attributes: { "im:id": "5" } } }] },
			});
		});
		await stub(name).enqueue([
			{
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
			{
				queue: [{ chart: "paid", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		expect(manual).toMatchObject({ empty: false, ok: true });
		await expect(queueOf(name)).resolves.toStrictEqual([]);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM chart_ranking"
		).first<{ n: number }>();
		expect(rows?.n).toBe(2);
	});

	it("records a deploy mid-step as do_restarted, not as a loss", async () => {
		const name = "restart-class";
		await reset(name);
		vi.stubGlobal("fetch", () =>
			Promise.reject(new Error("Durable Object is no longer active."))
		);
		await stub(name).enqueue([
			{
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		await runDurableObjectAlarm(stub(name));
		const rows = await env.DB.prepare(
			"SELECT error_class, params FROM fetch_error WHERE endpoint = 'task:chart_pull'"
		).all<{ error_class: string; params: string }>();
		expect(rows.results).toStrictEqual([
			{
				error_class: "do_restarted",
				params: JSON.stringify({
					chart: "free",
					genreId: null,
					storefront: "fr",
				}),
			},
		]);
		await expect(queueOf(name)).resolves.toMatchObject([
			{ type: "chart_pull" },
		]);
	});

	it("brings a pair back soon when a deploy interrupted its crawl", async () => {
		const name = "crawl-restart";
		await reset(name);
		await seedDuePair();
		vi.stubGlobal("fetch", () =>
			Promise.reject(
				new Error("Durable Object reset because its code was updated.")
			)
		);
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		const pair = await env.DB.prepare(
			"SELECT next_due_at FROM crawl_pair WHERE id = 1"
		).first<{ next_due_at: number }>();
		expect(pair?.next_due_at).toBeLessThan(Date.now() + 2 * 3_600_000);
		const err = await env.DB.prepare(
			"SELECT error_class FROM fetch_error WHERE endpoint = 'task:crawl'"
		).first<{ error_class: string }>();
		expect(err?.error_class).toBe("do_restarted");
	});

	it("answers a manual crawl with empty when no pair is due", async () => {
		const name = "crawl-now-empty";
		await reset(name);
		await expect(stub(name).crawlNow()).resolves.toStrictEqual({
			empty: true,
		});
	});
});

describe("SchedulerDO pacing under interleaving", () => {
	it("keeps a pause that was saved while a manual step was awaiting Apple", async () => {
		// The lost update. The manual step used to load pacing before its fetch
		// and save a throttle computed from that copy afterwards, which put
		// pauseUntil back to zero one second after the loop had set it: the loop
		// then fetched again while Apple was still refusing.
		const name = "pause-survives";
		await reset(name);
		const pauseUntil = Date.now() + 1_800_000;
		stubFetch(async () => {
			await env.DB.prepare(
				"INSERT OR REPLACE INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, 0)"
			)
				.bind(
					JSON.stringify({
						lastErrorAt: 1,
						lastRollDay: "",
						pauseUntil,
						ratePerMin: 4,
						throttlesPrevDay: 0,
						windowErrorCount: 1,
					})
				)
				.run();
			return Response.json({ resultCount: 0, results: [] }, { status: 403 });
		});
		await stub(name).enqueue([
			{
				queue: [{ chart: "free", genreId: null, storefront: "fr" }],
				type: "chart_pull",
			},
		]);
		await stub(name).stepNow();
		const pacing = await storedPacing();
		expect(pacing.pauseUntil).toBe(pauseUntil);
		expect(pacing.windowErrorCount).toBe(1);
		// The manual throttle is still recorded.
		expect(pacing.lastErrorAt).toBeGreaterThan(1);
	});
});

describe("SchedulerDO loop evidence", () => {
	it("counts a crawl the loop made and Apple answered", async () => {
		const name = "evidence-crawl";
		await reset(name);
		await seedDuePair();
		stubFetch(() => Response.json(fakeSearchResponse(3)));
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		await expect(loopFetchesOf(name)).resolves.toBe(1);
	});

	it("counts a queued public pull the loop made", async () => {
		const name = "evidence-pull";
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
		await expect(loopFetchesOf(name)).resolves.toBe(1);
	});

	it("counts neither a throttled fetch nor a manual one", async () => {
		const name = "evidence-none";
		await reset(name);
		await seedDuePair();
		stubFetch(() => Response.json(fakeSearchResponse(3)));
		await stub(name).crawlNow();
		await env.DB.prepare("UPDATE crawl_pair SET next_due_at = 0").run();
		vi.unstubAllGlobals();
		stubFetch(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);
		await stub(name).ensureAlarm();
		await runDurableObjectAlarm(stub(name));
		await expect(loopFetchesOf(name)).resolves.toBe(0);
	});

	it("raises on the roll only when the loop fetched, and spends the count", async () => {
		const name = "evidence-roll";
		await reset(name);
		await stub(name).rollPacing("2026-09-01");
		await expect(storedPacing()).resolves.toMatchObject({ ratePerMin: 4 });

		await runInDurableObject(stub(name), (_i, state) =>
			state.storage.put("loopFetches", 3)
		);
		await stub(name).rollPacing("2026-09-02");
		const pacing = await storedPacing();
		expect(pacing.ratePerMin).toBeCloseTo(4.4, 5);
		await expect(loopFetchesOf(name)).resolves.toBe(0);
	});

	it("keeps the count when the day was already rolled", async () => {
		const name = "evidence-rerolled";
		await reset(name);
		await stub(name).rollPacing("2026-09-01");
		await runInDurableObject(stub(name), (_i, state) =>
			state.storage.put("loopFetches", 3)
		);
		await stub(name).rollPacing("2026-09-01");
		await expect(loopFetchesOf(name)).resolves.toBe(3);
	});
});

// The runner's generated config sets WORK_LOOP=off. A Durable Object gets
// the deployed env, not a per-call override, so the switch is flipped on the
// instance itself.
function switchOff(name: string) {
	return runInDurableObject(stub(name), (instance) => {
		const holder = instance as unknown as { env: Record<string, unknown> };
		holder.env = { ...holder.env, WORK_LOOP: "off" };
	});
}

describe("SchedulerDO with the work loop off", () => {
	it("arms no alarm when work is enqueued or a pair is due", async () => {
		const name = "loop-off-arm";
		await reset(name);
		await switchOff(name);
		await seedDuePair();
		await stub(name).enqueue([{ date: "2026-08-30", type: "compact" }]);
		await stub(name).ensureAlarm();
		await expect(alarmOf(name)).resolves.toBeNull();
		await expect(stub(name).queueDepth()).resolves.toBe(1);
	});

	it("fetches nothing on an alarm left armed by an earlier cycle, and does not re-arm", async () => {
		// The runner keeps its Durable Object storage between cycles, so an alarm
		// armed before the switch existed is still there. On 2026-11-11 that loop
		// made four crawls beside refresh.sh.
		const name = "loop-off-alarm";
		await reset(name);
		await seedDuePair();
		const calls = stubFetch(() => Response.json(fakeSearchResponse(3)));
		await runInDurableObject(stub(name), async (_i, state) => {
			await state.storage.put("queue", [
				{
					id: "queued-before",
					queue: [{ chart: "free", genreId: null, storefront: "fr" }],
					type: "chart_pull",
				},
			]);
			await state.storage.setAlarm(Date.now() + 1000);
		});
		await switchOff(name);
		await runDurableObjectAlarm(stub(name));
		expect(calls).toHaveLength(0);
		await expect(queueOf(name)).resolves.toHaveLength(1);
		await expect(alarmOf(name)).resolves.toBeNull();
	});

	it("still runs a manual step and a manual crawl", async () => {
		const name = "loop-off-manual";
		await reset(name);
		await switchOff(name);
		await seedDuePair();
		stubFetch((url) =>
			url.includes("/search")
				? Response.json(fakeSearchResponse(3))
				: Response.json({
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
		await expect(stub(name).stepNow()).resolves.toMatchObject({
			empty: false,
			followUps: 1,
			ok: true,
		});
		await expect(stub(name).crawlNow()).resolves.toMatchObject({
			empty: false,
			throttled: false,
		});
		// The follow-up waits for the next manual step, not for an alarm.
		await expect(alarmOf(name)).resolves.toBeNull();
	});
});
