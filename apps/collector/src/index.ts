import type { Env } from "./env";
import { authorize } from "./lib/admin";
import { resolveAdsCategory } from "./lib/ads-genres";
import type { GenreRow } from "./lib/ads-genres";
import { collectsPublicEndpoints } from "./lib/mode";
import { loadPacing, savePacing, maybeRaise } from "./lib/pacing";
import { tracked } from "./lib/runs";
import { getState, getStateJson } from "./lib/state";
import { latestCompleteWeekStart } from "./tasks/ads";
import { ascDetectSkippedDates } from "./tasks/asc";
import { recomputeCadence } from "./tasks/cadence";
import { recomputeDifficulty } from "./tasks/difficulty";
import type {
	Task,
	AdsPullUnit,
	LookupUnit,
	ReviewUnit,
	ChartUnit,
} from "./tasks/types";

export { SchedulerDO } from "./scheduler";

/**
 * The genres to work in: the distinct primary genre of every tracked app.
 *
 * A hardcoded list here is wrong for every operator whose app is in another
 * category, and invariant 5 keeps reference data in rows. Apple already tells
 * us the answer: primary_genre_id is written on every app the collector sees,
 * so no extra fetch is needed.
 *
 * Empty is a real answer rather than a failure. On a fresh deploy no app has
 * been looked up yet, and under COLLECTION_MODE=credentialed that lookup runs
 * from the Actions runner rather than this Worker, so the column stays null
 * until the first run lands. Guessing a category then would write popularity
 * for terms nobody tracks.
 */
async function trackedGenreIds(env: Env): Promise<number[]> {
	const rows = await env.DB.prepare(
		`SELECT DISTINCT a.primary_genre_id AS id
       FROM tracked_app t
       JOIN app a ON a.id = t.app_id
      WHERE a.primary_genre_id IS NOT NULL`
	).all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/**
 * The week's Ads popularity pull, or null when there is nothing to ask for.
 * Shared by the Monday cron and the manual trigger, which skips the
 * day-of-week gate, which is a scheduling choice, not a correctness one:
 * `popularity` is unique on (keyword, storefront, genre, week_start), so
 * re-pulling the same week is a no-op.
 */
async function buildAdsTask(
	env: Env,
	force = false
): Promise<Extract<Task, { type: "ads_pull" }> | null> {
	const genres =
		(await getStateJson<number[]>(env.DB, "ads:focus_genres")) ??
		(await trackedGenreIds(env));
	if (genres.length === 0) {
		return null;
	}
	const overrides =
		(await getStateJson<Record<number, string>>(
			env.DB,
			"ads:category_by_genre"
		)) ?? {};
	const storefronts = await env.DB.prepare(
		"SELECT code FROM storefront WHERE active = 1"
	).all<{ code: string }>();

	const rows = await env.DB.prepare(
		`SELECT id, parent_id FROM genre WHERE id IN (${genres.map(() => "?").join(",")})`
	)
		.bind(...genres)
		.all<GenreRow>();

	// Ads reports per top-level category, so every sub-genre of one parent
	// resolves to the same ranked list: five tracked Games sub-genres would
	// otherwise fetch it five times. Dedupe on the pair that actually varies
	// the response.
	const weekStart = latestCompleteWeekStart();
	const seen = new Set<string>();
	const queue: AdsPullUnit[] = [];
	for (const s of storefronts.results) {
		for (const row of rows.results) {
			const resolved = resolveAdsCategory(row, overrides);
			if (!resolved) {
				continue;
			}
			const key = `${s.code}:${resolved.category}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			// Apple publishes WEEKLY_SUN_SAT, so a second pull of a week already held
			// fetches identical data and re-walks 500 terms per unit. `force` keeps
			// the manual trigger honest: a credential check that silently skipped the
			// request would report success without having made one.
			if (!force) {
				const pulled = await getState(
					env.DB,
					`ads:pulled:${s.code}:${resolved.category}`
				);
				if (pulled === weekStart) {
					continue;
				}
			}
			queue.push({
				category: resolved.category,
				genreId: resolved.genreId,
				storefront: s.code,
			});
		}
	}
	if (queue.length === 0) {
		return null;
	}
	return { queue, type: "ads_pull", weekStart };
}

async function runDailyJobs(env: Env): Promise<{
	queued: number;
	tasks: string[];
}> {
	const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("singleton"));
	const tasks: Task[] = [];
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 24 * 3_600_000)
		.toISOString()
		.slice(0, 10);

	// Pacing: raise the learned rate after a clean 24h; reset window counters.
	await savePacing(env.DB, maybeRaise(await loadPacing(env.DB), today));

	// Re-space every tracked pair against the budget the learned rate affords,
	// now that the rate for the day is settled. Growth in apps or keywords costs
	// resolution, never coverage.
	await recomputeCadence(env);

	// Difficulty is derived from observations we already hold, so it costs
	// nothing against the Apple budget and can be re-run whenever the formula
	// changes.
	await recomputeDifficulty(env);

	// Compact yesterday's staging observations into the permanent archive.
	tasks.push({ date: yesterday, type: "compact" });

	// ASC Analytics poll (secrets arrive via `wrangler secret put`; skip quietly
	// until then rather than filling fetch_error with credential noise).
	if (env.ASC_ISSUER_ID) {
		tasks.push({ type: "asc_poll" });
	}

	// Weekly Ads popularity pull on Mondays (data posts with ~1 week delay).
	if (env.ADS_CLIENT_ID && new Date().getUTCDay() === 1) {
		const adsTask = await buildAdsTask(env);
		if (adsTask) {
			tasks.push(adsTask);
		}
	}

	// Tracked-app pulls: metadata lookup (per storefront × its default indexed
	// locale for our language), reviews, charts. All three hit the public iTunes
	// endpoints, so a deployment that cannot reach them skips queueing work whose
	// only outcome is a throttle and an abandoned batch.
	// The storefront set follows each app's content language (language ≠
	// storefront).
	const targets = await env.DB.prepare(
		`SELECT ta.app_id, sl.storefront_code AS code, MIN(sl.locale_code) AS locale_code
     FROM tracked_app ta
     JOIN app_language al ON al.app_id = ta.app_id
     JOIN locale l ON l.language = al.language
     JOIN storefront_locale sl ON sl.locale_code = l.code
     JOIN storefront s ON s.code = sl.storefront_code AND s.active = 1
     GROUP BY ta.app_id, sl.storefront_code`
	).all<{ app_id: number; code: string; locale_code: string }>();

	if (targets.results.length > 0 && collectsPublicEndpoints(env)) {
		const lookups: LookupUnit[] = [];
		const reviews: ReviewUnit[] = [];
		const storefrontSet = new Set<string>();
		for (const t of targets.results) {
			lookups.push({
				appId: t.app_id,
				localeCode: t.locale_code,
				storefront: t.code,
			});
			reviews.push({ appId: t.app_id, storefront: t.code });
			storefrontSet.add(t.code);
		}
		tasks.push(
			{ queue: lookups, type: "lookup_pull" },
			{ type: "review_pull", queue: reviews }
		);

		// null is the storefront-wide chart, which needs no genre, so charts still
		// work on day one when no app has been looked up yet.
		const chartGenres = (await getStateJson<(number | null)[]>(
			env.DB,
			"chart_genres"
		)) ?? [...(await trackedGenreIds(env)), null];
		const charts: ChartUnit[] = [];
		for (const code of storefrontSet) {
			for (const g of chartGenres) {
				for (const chart of ["free", "paid", "grossing"] as const) {
					charts.push({ storefront: code, genreId: g, chart });
				}
			}
		}
		tasks.push({ queue: charts, type: "chart_pull" });
	}

	await stub.enqueue(tasks);
	await ascDetectSkippedDates(env);
	return { queued: tasks.length, tasks: tasks.map((t) => t.type) };
}

/**
 * The daily job, bracketed by a `collector_run` row.
 *
 * The bracket is the point: everything below writes observations only when it
 * succeeds, so a throw halfway, before `enqueue` say, would otherwise leave no
 * trace at all and surface a day later as missing coverage.
 */
async function dailyJobs(
	env: Env,
	trigger: "cron" | "admin" = "cron"
): Promise<void> {
	await tracked(env.DB, "daily", trigger, () => runDailyJobs(env));
}

const JOBS = [
	"daily",
	"asc",
	"ads",
	"step",
	"crawl",
	"cadence",
	"difficulty",
] as const;
type Job = (typeof JOBS)[number];

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/**
 * Run one job on demand and report the outcome in the response, so a
 * credential can be verified in seconds instead of waiting for the cron.
 * `asc` and `ads` execute a first step inline; everything it queues afterwards
 * drains on the normal paced loop.
 */
async function runJob(
	env: Env,
	job: Job,
	opts: { verifyOnly?: boolean } = {}
): Promise<Response> {
	const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("singleton"));
	switch (job) {
		case "daily": {
			await dailyJobs(env, "admin");
			return json({ job, queued: await stub.queueDepth() });
		}
		case "asc": {
			if (!env.ASC_ISSUER_ID) {
				return json({ error: "ASC secrets not configured", job }, 412);
			}
			const result = await stub.runNow({ type: "asc_poll" });
			return json({ job, ...result }, result.ok ? 200 : 502);
		}
		case "ads": {
			if (!env.ADS_CLIENT_ID) {
				return json({ error: "ADS secrets not configured", job }, 412);
			}
			const task = await buildAdsTask(env, true);
			if (!task) {
				return json(
					{
						error:
							"nothing to pull: needs an active storefront and a tracked app with a known genre",
						job,
					},
					412
				);
			}
			const result = await stub.runNow({
				...task,
				verifyOnly: opts.verifyOnly ?? true,
			});
			return json({ job, ...result }, result.ok ? 200 : 502);
		}
		case "step": {
			const result = await stub.stepNow();
			const status = result.empty || result.ok ? 200 : 502;
			return json({ job, queued: await stub.queueDepth(), ...result }, status);
		}
		case "crawl": {
			const result = await stub.crawlNow();
			// A throttle is a real outcome, not a transport failure: report it as a
			// 200 carrying `throttled` so a caller can back off deliberately.
			return json({ job, ...result });
		}
		case "cadence": {
			await recomputeCadence(env);
			return json({ job, ok: true });
		}
		default: {
			// Exhaustive: JOBS has no other members.
			await recomputeDifficulty(env);
			return json({ job, ok: true });
		}
	}
}

export default {
	/**
	 * The collector's only public route: POST /admin/run?job=… behind
	 * ADMIN_TOKEN. See lib/admin.ts for why it exists.
	 */
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const auth = await authorize(
			request.headers.get("Authorization"),
			env.ADMIN_TOKEN
		);
		// Unconfigured: the route does not exist, and says so without revealing
		// that a trigger would otherwise be here.
		if (!auth.configured) {
			return new Response("Not Found", { status: 404 });
		}
		if (!auth.ok) {
			return json({ error: "unauthorized" }, 401);
		}
		if (url.pathname !== "/admin/run") {
			return new Response("Not Found", { status: 404 });
		}
		if (request.method !== "POST") {
			return json({ error: "POST required" }, 405);
		}
		const job = url.searchParams.get("job") ?? "";
		if (!JOBS.includes(job as Job)) {
			return json({ error: "unknown job", jobs: JOBS }, 400);
		}
		// A bare `job=ads` only verifies the credential; `?write=1` opts into the
		// full pull, which rewrites 500 terms per unit.
		return runJob(env, job as Job, {
			verifyOnly: url.searchParams.get("write") !== "1",
		});
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext
	): Promise<void> {
		switch (controller.cron) {
			case "*/10 * * * *": {
				// Watchdog: re-arm the work-loop alarm if it was lost (rare DO
				// eviction) or if crawl pairs have newly come due.
				const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("singleton"));
				await stub.ensureAlarm();
				break;
			}
			case "0 3 * * *": {
				await dailyJobs(env);
				break;
			}
			default: {
				// Only the two registered cron expressions reach this handler.
				break;
			}
		}
	},
} satisfies ExportedHandler<Env>;
