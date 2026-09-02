/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import worker from "../src/index";
import { authorize, bearer } from "../src/lib/admin";
import type { Task } from "../src/tasks/types";
import { stubFetch } from "./helpers";

const TOKEN = "correct-horse-battery-staple";

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

/** An env with the trigger configured; per-test overrides on top. */
function configured(extra: Record<string, unknown> = {}) {
	return { ...env, ADMIN_TOKEN: TOKEN, ...extra } as never;
}

function post(job: string, token: string | null = TOKEN): Request {
	return new Request(`https://collector/admin/run?job=${job}`, {
		headers: token === null ? {} : { Authorization: `Bearer ${token}` },
		method: "POST",
	});
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM collector_state"),
		env.DB.prepare("DELETE FROM fetch_error"),
		env.DB.prepare("DELETE FROM popularity"),
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
		// The genres worked in are the tracked apps' own, resolved up to their
		// Apple Ads category, so both the genre row and a tracked app carrying it
		// are preconditions for the ads job existing at all. Health & Fitness
		// rather than Games: nothing here may assume the operator's category.
		env.DB.prepare(
			"INSERT OR IGNORE INTO genre (id, name, parent_id) VALUES (6013, 'Health & Fitness', NULL)"
		),
		env.DB.prepare(
			"INSERT INTO app (id, current_name, primary_genre_id, first_seen_at, last_seen_at) VALUES (424242, 'Tracked App', 6013, 0, 0)"
		),
		env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('admin', 424242, 0)"
		),
	]);
	await drainQueue();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe(bearer, () => {
	it("reads a well-formed bearer token", () => {
		expect(bearer("Bearer abc123")).toBe("abc123");
	});

	it("refuses anything that is not a non-empty Bearer", () => {
		expect(bearer(null)).toBeNull();
		expect(bearer("Basic abc123")).toBeNull();
		expect(bearer("Bearer   ")).toBeNull();
	});
});

describe(authorize, () => {
	it("accepts the configured token", async () => {
		await expect(authorize(`Bearer ${TOKEN}`, TOKEN)).resolves.toStrictEqual({
			configured: true,
			ok: true,
		});
	});

	it("rejects a wrong token without claiming to be unconfigured", async () => {
		await expect(authorize("Bearer nope", TOKEN)).resolves.toStrictEqual({
			configured: true,
			ok: false,
		});
	});

	it("reports unconfigured when no token is set, even with a header", async () => {
		await expect(authorize(`Bearer ${TOKEN}`)).resolves.toStrictEqual({
			configured: false,
			ok: false,
		});
	});
});

describe("POST /admin/run", () => {
	it("hides the route entirely when ADMIN_TOKEN is unset", async () => {
		// Not 401: an unconfigured collector must not advertise that a trigger
		// would otherwise live here.
		const res = await worker.fetch(post("daily"), {
			...env,
			ADMIN_TOKEN: undefined,
		} as never);
		expect(res.status).toBe(404);
	});

	it("rejects a missing or wrong token", async () => {
		for (const token of [null, "wrong-token"]) {
			const res = await worker.fetch(post("daily", token), configured());
			expect(res.status).toBe(401);
		}
	});

	it("refuses a job name it does not own", async () => {
		const res = await worker.fetch(post("rm-rf"), configured());
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ error: "unknown job" });
	});

	it("refuses anything but POST, so a stray GET cannot fire a job", async () => {
		const res = await worker.fetch(
			new Request("https://collector/admin/run?job=daily", {
				headers: { Authorization: `Bearer ${TOKEN}` },
			}),
			configured()
		);
		expect(res.status).toBe(405);
	});

	it("404s an authenticated request to any other path", async () => {
		const res = await worker.fetch(
			new Request("https://collector/", {
				headers: { Authorization: `Bearer ${TOKEN}` },
				method: "POST",
			}),
			configured()
		);
		expect(res.status).toBe(404);
	});

	it("queues the daily fan-out and reports the depth", async () => {
		const res = await worker.fetch(post("daily"), configured());
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ job: "daily" });
		const tasks = await drainQueue();
		expect(tasks.some((t) => t.type === "compact")).toBeTruthy();
	});

	it("says so when the credentials for a job are absent", async () => {
		for (const [job, unset] of [
			["asc", "ASC_ISSUER_ID"],
			["ads", "ADS_CLIENT_ID"],
		] as const) {
			const res = await worker.fetch(
				post(job),
				configured({ [unset]: undefined })
			);
			expect(res.status).toBe(412);
		}
	});

	// A Durable Object receives the Worker's deployed env, not the per-call
	// overrides handed to worker.fetch, so a DO-executed job cannot be given a
	// synthetic Apple key here. What matters, and what is asserted, is that a
	// credential the DO cannot use surfaces as a 502 naming the recorded error
	// rather than a cheerful 200.
	it("surfaces a bad credential as 502 with the error the step recorded", async () => {
		stubFetch(() => new Response("nope", { status: 401 }));
		const res = await worker.fetch(
			post("ads"),
			configured({ ADS_CLIENT_ID: "client" })
		);
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			ok: boolean;
			errors: { endpoint: string }[];
		};
		expect(body.ok).toBeFalsy();
		expect(body.errors[0]?.endpoint).toBe("ads:popularity");
	});

	it("verifies the ads credential without writing rows", async () => {
		// A credential check that rewrote 500 terms per unit spent a real slice of
		// the daily write budget to learn only that Apple answered, which the R2
		// archive already proves.
		stubFetch((url) => {
			if (url.includes("appleid.apple.com")) {
				return Response.json({ access_token: "tok", expires_in: 3600 });
			}
			if (url.includes("/v1/acls")) {
				return Response.json({ data: { acls: [{ adAccount: { id: 1 } }] } });
			}
			return Response.json({
				result: { rows: [{ rankInGenre: 1, searchTerm: "terme un" }] },
			});
		});
		await worker.fetch(post("ads"), configured({ ADS_CLIENT_ID: "client" }));
		const seeded = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM seed_term"
		).first<{ n: number }>();
		expect(seeded?.n).toBe(0);
	});

	it("advances the queue one task at a time, and says when it is empty", async () => {
		stubFetch(() => Response.json({ resultCount: 0, results: [] }));
		await expect(
			worker.fetch(post("step"), configured()).then((r) => r.json())
		).resolves.toMatchObject({ empty: true });

		await worker.fetch(post("daily"), configured());
		const res = await worker.fetch(post("step"), configured());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { empty: boolean; task: string };
		expect(body.empty).toBeFalsy();
		expect(body.task).toBe("compact");
	});

	it("runs the pure-compute jobs without touching Apple", async () => {
		stubFetch(() => {
			throw new Error("no network expected");
		});
		for (const job of ["cadence", "difficulty"]) {
			const res = await worker.fetch(post(job), configured());
			expect(res.status).toBe(200);
		}
	});
});

describe("runNow", () => {
	it("runs while the pacing loop is paused", async () => {
		// The iTunes backoff must not gate a credentialed ASC/Ads check.
		await env.DB.prepare(
			"INSERT OR REPLACE INTO collector_state (key, value, updated_at) VALUES ('pacing', ?, ?)"
		)
			.bind(
				JSON.stringify({
					lastErrorAt: Date.now(),
					lastRaiseDay: "",
					pauseUntil: Date.now() + 4 * 3_600_000,
					ratePerMin: 1,
					windowErrorCount: 3,
				}),
				Date.now()
			)
			.run();

		stubFetch(() => Response.json({ results: [] }));
		const result = await schedulerStub().runNow({
			date: "2026-09-01",
			type: "compact",
		});
		expect(result.ok).toBeTruthy();
	});

	it("reports an error the step swallowed, not just one that threw", async () => {
		// Task steps record a failed unit and keep the queue moving; a human
		// checking a credential still needs to be told it failed.
		await env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (1, 'X', 0, 0)"
		).run();
		await env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES ('u', 1, 0)"
		).run();
		stubFetch(() => new Response("unauthorized", { status: 401 }));

		const result = await schedulerStub().runNow({
			appId: "1",
			stage: "init",
			type: "asc_poll",
		});
		expect(result.ok).toBeFalsy();
		expect(result.errors.length).toBeGreaterThan(0);
	});
});
