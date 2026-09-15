import type { Env } from "./env";
import { authorize } from "./lib/admin";
import { resolveAdsCategory } from "./lib/ads-genres";
import type { GenreRow } from "./lib/ads-genres";
import { collectsPublicEndpoints } from "./lib/mode";
import { loadPacing, savePacing, maybeRaise } from "./lib/pacing";
import { tracked } from "./lib/runs";
import { getState, getStateJson, recordFetchError } from "./lib/state";
import {
	buildTermsTasks,
	latestCompleteWeekStart,
	recentWeekStarts,
} from "./tasks/ads";
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

/**
 * Run one piece of daily bookkeeping without letting it cancel the day.
 *
 * Pacing, cadence and difficulty all derive from data already held: they
 * change how often a pair is checked, never what is collected today. They are
 * also the first D1 calls of the run, so they meet an outage before anything
 * else does, and a throw here used to abort `runDailyJobs` before `enqueue`,
 * taking every metadata, review and chart pull of the day with it. That is how
 * the 2026-09-11 cycle ended with nothing queued, and a day nobody collected
 * cannot be backfilled (CLAUDE.md, invariant 1). Record the failure and carry
 * on: tomorrow's run recomputes all three from scratch anyway.
 */
async function bestEffort(
	env: Env,
	step: string,
	work: () => Promise<unknown>
): Promise<void> {
	try {
		await work();
	} catch (error) {
		try {
			await recordFetchError(env.DB, {
				endpoint: `daily:${step}`,
				errorClass: "task_threw",
				message:
					error instanceof Error ? error.message.slice(0, 1200) : "unknown",
			});
		} catch {
			// The same outage that broke the step breaks the row that records it.
			// Swallow it: re-throwing here would restore the failure this exists to
			// prevent.
			console.log(`daily:${step} failed, and so did recording it`);
		}
	}
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
	await bestEffort(env, "pacing", async () =>
		savePacing(env.DB, maybeRaise(await loadPacing(env.DB), today))
	);

	// Re-space every tracked pair against the budget the learned rate affords,
	// now that the rate for the day is settled. Growth in apps or keywords costs
	// resolution, never coverage.
	await bestEffort(env, "cadence", () => recomputeCadence(env));

	// Difficulty is derived from observations we already hold, so it costs
	// nothing against the Apple budget and can be re-run whenever the formula
	// changes.
	await bestEffort(env, "difficulty", () => recomputeDifficulty(env));

	// Compact yesterday's staging observations into the permanent archive.
	tasks.push({ date: yesterday, type: "compact" });

	// ASC Analytics poll (secrets arrive via `wrangler secret put`; skip quietly
	// until then rather than filling fetch_error with credential noise).
	if (env.ASC_ISSUER_ID) {
		tasks.push({ type: "asc_poll" });
	}

	if (env.ADS_CLIENT_ID) {
		// Weekly genre pull on Mondays (data posts with ~1 week delay). Its
		// builder reads D1 too, so it gets the same guard as the pass below.
		if (new Date().getUTCDay() === 1) {
			await bestEffort(env, "ads_pull", async () => {
				const adsTask = await buildAdsTask(env);
				if (adsTask) {
					tasks.push(adsTask);
				}
			});
		}
		// The by-name pass, daily, for whatever the latest week still lacks. On
		// most days that is nothing and costs one read per storefront; after a
		// failed chunk or a newly tracked keyword it is exactly the gap. Best
		// effort, like pacing above: it reads D1 before anything is enqueued, and
		// popularity can be asked for again tomorrow while today's lookups cannot.
		await bestEffort(env, "ads_terms", async () => {
			tasks.push(...(await buildTermsTasks(env, [latestCompleteWeekStart()])));
		});
	}

	// Tracked-app pulls: metadata lookup (per storefront × the locale we query it
	// in), reviews, charts. All three hit the public iTunes endpoints, so a
	// deployment that cannot reach them skips queueing work whose only outcome is
	// a throttle and an abandoned batch.
	//
	// Coverage is the union of two sources because neither alone is right.
	// Content language (language ≠ storefront) gives the storefronts Apple
	// cross-localises the app into, which is what an app tracked before it has
	// any keywords should still get. Live crawl pairs give the storefronts
	// somebody actually chose, and they are the only way a storefront indexing
	// nothing in the app's language is reached at all: Spain for a French app
	// indexes Spanish, Catalan and English, so the language join can never
	// produce it, and on its own that storefront yields keyword ranks with no
	// metadata, reviews or charts for as long as it runs.
	//
	// Locale preference, in order: the storefront's own default among the app's
	// languages, then any locale in one of them, then the pair's. The first rung
	// is what makes a multi-language app correct, and app_language is a set with
	// no primary: a French *and* English app indexes both fr-FR and en-GB in
	// France, and picking by name alone would fetch the English listing and store
	// it as France's. Apple honours the lang parameter whenever the app really is
	// localised in that storefront, so that metadata would be wrong, not merely
	// mislabelled. Belgium is why the second rung exists: it indexes French, but
	// its default is English, so a French-only app has no default to match.
	//
	// Every branch is an aggregate rather than a bare column on purpose: SQLite
	// only pins a bare column to the min()/max() row when there is exactly one
	// such aggregate, and on ties it picks among them arbitrarily.
	const targets = await env.DB.prepare(
		`SELECT app_id, code,
            COALESCE(
              MIN(CASE WHEN pref = 0 AND is_default = 1 THEN locale_code END),
              MIN(CASE WHEN pref = 0 THEN locale_code END),
              MIN(CASE WHEN pref = 1 THEN locale_code END)
            ) AS locale_code
       FROM (
         SELECT ta.app_id AS app_id, sl.storefront_code AS code,
                sl.locale_code AS locale_code, sl.is_default AS is_default,
                0 AS pref
           FROM tracked_app ta
           JOIN app_language al ON al.app_id = ta.app_id
           JOIN locale l ON l.language = al.language
           JOIN storefront_locale sl ON sl.locale_code = l.code
           JOIN storefront s ON s.code = sl.storefront_code AND s.active = 1
         UNION ALL
         SELECT tk.app_id AS app_id, cp.storefront_code AS code,
                cp.locale_code AS locale_code, 0 AS is_default, 1 AS pref
           FROM tracked_keyword tk
           JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id AND cp.ref_count > 0
           JOIN storefront s ON s.code = cp.storefront_code AND s.active = 1
       )
      GROUP BY app_id, code`
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
	// Gap *detection*, not collection: it reads what ASC already gave us and
	// writes notes. Nothing downstream waits on it, so it must not be the thing
	// that fails a run whose work is already queued.
	await bestEffort(env, "asc_skipped_dates", () => ascDetectSkippedDates(env));
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
	"ads_backfill",
	"ads_discover",
	"step",
	"crawl",
	"cadence",
	"difficulty",
] as const;

/**
 * How many complete weeks of popularity a backfill reaches for. Thirteen is the
 * report's longest window (90 days) rounded to whole weeks, so the default
 * fills exactly what the dashboard can draw. Overridable through the
 * `ads:backfill_weeks` collector_state key, because how far back Apple still
 * serves is a fact about Apple, not about this code.
 */
const BACKFILL_WEEKS = 13;

/**
 * Queue keyword discovery: one Apple request per tracked keyword per tracked
 * (user, app, storefront).
 *
 * Seeded from the keywords somebody already chose, because that is what makes
 * the answers relevant. Apple scopes suggestions to the promoted app, so no
 * brand classification of our own is needed to keep competitors out of the
 * inbox.
 *
 * Nothing here spends crawl budget. It costs one Ads request per seed, on a
 * credentialed endpoint that has nothing to do with the shared-IP iTunes limit,
 * and it proposes rows an operator then has to accept.
 */
async function buildDiscovery(env: Env): Promise<Task[]> {
	const rows = await env.DB.prepare(
		// Storefronts come from this user's own tracked_keyword_storefront rows.
		// crawl_pair is shared, and joining it on the keyword alone asked each seed
		// in every storefront where anyone collected it, proposing keywords for
		// markets this user never chose. The pair join keeps only live ones.
		`SELECT DISTINCT tk.user_id AS userId, a.id AS appId,
            ts.storefront_code AS storefront, ts.locale_code AS localeCode,
            k.language AS language, k.normalized AS seed
       FROM tracked_keyword tk
       JOIN app a ON a.id = tk.app_id
       JOIN keyword k ON k.id = tk.keyword_id
       JOIN tracked_keyword_storefront ts ON ts.tracked_keyword_id = tk.id
       JOIN crawl_pair cp ON cp.keyword_id = k.id
        AND cp.storefront_code = ts.storefront_code
        AND cp.locale_code = ts.locale_code AND cp.ref_count > 0
      ORDER BY tk.user_id, a.id, ts.storefront_code, k.normalized`
	).all<{
		userId: string;
		appId: number;
		storefront: string;
		localeCode: string;
		language: string;
		seed: string;
	}>();

	// One task per (user, app, storefront, locale, language), carrying its seeds;
	// the step walks them one request at a time so a tick stays bounded. Locale
	// and language belong in the key because the task stamps both onto every
	// proposal: keyed on storefront alone, a Canadian unit took its locale from
	// whichever row came first, and accepting a French seed's variant created an
	// en-CA pair and an English keyword row.
	const byUnit = new Map<string, Task>();
	for (const r of rows.results) {
		const key = `${r.userId}|${r.appId}|${r.storefront}|${r.localeCode}|${r.language}`;
		const existing = byUnit.get(key);
		if (existing?.type === "ads_discover") {
			existing.rest.push(r.seed);
			continue;
		}
		byUnit.set(key, {
			appAdamId: String(r.appId),
			appId: r.appId,
			language: r.language,
			localeCode: r.localeCode,
			rest: [],
			seed: r.seed,
			storefront: r.storefront,
			type: "ads_discover",
			userId: r.userId,
		});
	}
	return [...byUnit.values()];
}

/**
 * Queue the by-name popularity pass for every recent week we hold nothing for.
 *
 * Only the by-name pass. The genre pull exists to fill `seed_term`, which is
 * keyed by month and costs 500 writes a unit; replaying a quarter of it would
 * spend most of a day's row budget re-deriving a discovery list nobody is
 * waiting for. The tracked keywords are what a backfill is for.
 */
async function buildAdsBackfill(env: Env): Promise<Task[]> {
	// Only the keywords each week lacks an answer for: popularity is weekly and
	// settled, so re-asking a held keyword fetches identical data and rewrites
	// its row for nothing.
	return buildTermsTasks(
		env,
		recentWeekStarts(
			Number(await getState(env.DB, "ads:backfill_weeks")) || BACKFILL_WEEKS
		)
	);
}
type Job = (typeof JOBS)[number];

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/**
 * The two Ads jobs that only queue work: build the task list, enqueue it, say
 * how much. Shared because they differ in nothing but the builder and the word
 * for the count, and because writing the shape out twice pushed `runJob` past
 * the complexity ceiling.
 */
async function queueAdsJob(
	env: Env,
	stub: Awaited<ReturnType<Env["SCHEDULER"]["get"]>>,
	job: Job,
	build: (env: Env) => Promise<Task[]>,
	countLabel: string
): Promise<Response> {
	if (!env.ADS_CLIENT_ID) {
		return json({ error: "ADS secrets not configured", job }, 412);
	}
	const tasks = await build(env);
	await stub.enqueue(tasks);
	return json({
		job,
		queued: await stub.queueDepth(),
		[countLabel]: tasks.length,
	});
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
			const verifyOnly = opts.verifyOnly ?? true;
			const byName = await buildTermsTasks(
				env,
				[latestCompleteWeekStart()],
				verifyOnly
			);
			const task = await buildAdsTask(env, true);
			if (!task) {
				if (byName.length > 0) {
					await stub.enqueue(byName);
					return json({ job, queued: await stub.queueDepth() });
				}
				return json(
					{
						error:
							"nothing to pull: needs an active storefront and a tracked app with a known genre or keyword",
						job,
					},
					412
				);
			}
			const result = await stub.runNow({ ...task, verifyOnly });
			await stub.enqueue(byName);
			return json({ job, ...result }, result.ok ? 200 : 502);
		}
		case "ads_backfill": {
			return await queueAdsJob(env, stub, job, buildAdsBackfill, "weeks");
		}
		case "ads_discover": {
			return await queueAdsJob(env, stub, job, buildDiscovery, "units");
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
