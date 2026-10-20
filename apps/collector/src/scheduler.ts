import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { collectsPublicEndpoints, dropsTask } from "./lib/mode";
import {
	loadPacing,
	savePacing,
	onThrottle,
	onAdminThrottle,
	tickMs,
} from "./lib/pacing";
import type { PacingState } from "./lib/pacing";
import { recordHeartbeat } from "./lib/runs";
import { recordFetchError, getStateJson } from "./lib/state";
import { adsPullStep, adsTermsStep, TERM_CHUNK } from "./tasks/ads";
import { ascPollStep, ascFetchInstanceStep } from "./tasks/asc";
import { pickDuePair, crawlPair } from "./tasks/crawl";
import type { DuePair } from "./tasks/crawl";
import { adsDiscoverStep } from "./tasks/discover";
import {
	lookupPullStep,
	reviewPullStep,
	chartPullStep,
	compactStep,
} from "./tasks/pulls";
import type { Task } from "./tasks/types";

/**
 * SchedulerDO: the single work loop for all collection.
 *
 * One alarm at a time (a DO invariant). Each alarm() tick does exactly one
 * bounded unit of work, one task step or one Tier-1 keyword crawl, then
 * reschedules itself at the learned Apple-polite rate. When there is neither
 * queued work nor a due pair, no alarm is set; the watchdog cron re-arms
 * within 10 minutes of work becoming due.
 *
 * Budget hierarchy is structural: the task queue (which includes Tier-1
 * app-level pulls) runs before the keyword crawl; Tier-2 sweep tasks (M6)
 * will only be enqueued when the Tier-1 window is idle.
 *
 * Alarm contract: at-least-once, auto-retry ×6 with backoff on throw, so every
 * step is idempotent, and we deliberately never call deleteAlarm().
 */
/** How soon a crawl that failed for a transient reason is due again. */
const CRAWL_RETRY_MS = 30 * 60_000;

/**
 * Whether a step died because this Durable Object went away underneath it.
 *
 * Every deploy restarts the object, and an in-flight call is dropped with one
 * of Cloudflare's own messages. It is not a failed fetch and it costs no
 * observation: alarms are at-least-once and every step is idempotent, so the
 * task comes round again. Recording it as `task_threw` put "data lost" on the
 * dashboard every time the Worker was deployed, which is the false signal the
 * loss/absorbed split exists to prevent.
 */
export function isRestart(message: string): boolean {
	return (
		message.includes("Durable Object") &&
		(message.includes("no longer active") ||
			message.includes("code was updated") ||
			message.includes("code has been updated"))
	);
}

/** Consecutive throws a task may take before its failing unit is given up. */
const THROW_CAP = 3;

type Queued = Task & { id: string };

function stamp(task: Task): Queued {
	return { ...task, id: crypto.randomUUID() };
}

/**
 * What a step that returned normally queues next. Steps build follow-ups by
 * spreading the task, so a throw count would ride along; `threw` counts
 * consecutive throws, and this step did not throw. `attempt` is left alone
 * because the steps themselves spend it on throttles.
 */
function cleared(followUps: Task[]): Task[] {
	return followUps.map((t) => (t.threw ? { ...t, threw: 0 } : t));
}

/**
 * The batch minus its head unit, for when that unit keeps throwing. Dropping
 * the whole task instead cost every unit behind it the day: eighty lookups
 * lost to one app whose response broke the normaliser. Single-unit tasks have
 * no remainder.
 */
function remainder(task: Task): Task[] {
	switch (task.type) {
		case "lookup_pull": {
			return task.queue.length > 1
				? [{ attempt: 0, queue: task.queue.slice(1), type: task.type }]
				: [];
		}
		case "review_pull": {
			return task.queue.length > 1
				? [{ attempt: 0, queue: task.queue.slice(1), type: task.type }]
				: [];
		}
		case "chart_pull": {
			return task.queue.length > 1
				? [{ attempt: 0, queue: task.queue.slice(1), type: task.type }]
				: [];
		}
		case "ads_pull": {
			return task.queue.length > 1
				? [{ ...task, attempt: 0, queue: task.queue.slice(1) }]
				: [];
		}
		case "ads_terms": {
			const rest = task.terms.slice(TERM_CHUNK);
			return rest.length > 0 ? [{ ...task, attempt: 0, terms: rest }] : [];
		}
		case "ads_discover": {
			const [seed, ...rest] = task.rest;
			return seed === undefined ? [] : [{ ...task, attempt: 0, rest, seed }];
		}
		default: {
			return [];
		}
	}
}

/** Which unit a throw belongs to, so the loss names what was lost. */
export function unitParams(task: Task): { params?: string } {
	switch (task.type) {
		case "lookup_pull":
		case "review_pull":
		case "chart_pull":
		case "ads_pull": {
			return { params: JSON.stringify(task.queue[0] ?? null) };
		}
		case "ads_terms": {
			return {
				params: `${task.storefront}/${Math.min(task.terms.length, TERM_CHUNK)} terms`,
			};
		}
		case "ads_discover": {
			return {
				params: JSON.stringify({
					seed: task.seed,
					storefront: task.storefront,
				}),
			};
		}
		case "compact": {
			return { params: task.date };
		}
		default: {
			return {};
		}
	}
}

/**
 * What goes back on the queue after a step threw.
 *
 * A restart is the platform's doing, not the task's, so it is retried without
 * being counted: counting it let a deploy or two drop a batch while the row
 * said `do_restarted`, which the health page treats as absorbed.
 */
export function retryAfterThrow(task: Task, message: string): Task[] {
	if (isRestart(message)) {
		return [task];
	}
	const threw = (task.threw ?? 0) + 1;
	if (threw < THROW_CAP) {
		return [{ ...task, threw }];
	}
	return cleared(remainder(task));
}

export class SchedulerDO extends DurableObject<Env> {
	async enqueue(tasks: Task[]): Promise<void> {
		if (tasks.length === 0) {
			return;
		}
		const queue = await this.#loadQueue();
		queue.push(...tasks.map(stamp));
		await this.ctx.storage.put("queue", queue);
		await this.ensureAlarm();
	}

	/**
	 * The queue, every task carrying an id. Anything queued before ids existed
	 * is stamped and written back here, so the step that runs it can find it.
	 * Storage calls keep the input gate shut, so nothing interleaves between a
	 * read here and the caller's put, as long as the caller awaits nothing else
	 * in between.
	 */
	async #loadQueue(): Promise<Queued[]> {
		const stored = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
		if (stored.every((t): t is Queued => t.id !== undefined)) {
			return stored;
		}
		const queue = stored.map((t) =>
			t.id === undefined ? { ...t, id: crypto.randomUUID() } : (t as Queued)
		);
		await this.ctx.storage.put("queue", queue);
		return queue;
	}

	/**
	 * Swap a finished task for its follow-ups, against the queue as it is now.
	 *
	 * The step awaited Apple and D1, which opens the input gate, so the queue
	 * read before it may be stale: putting that copy back erased whatever
	 * `enqueue` had added meanwhile, the nightly cron's tasks included. Hence
	 * re-read, remove by id, append. A task already gone was finished by
	 * someone else (a manual step beside the alarm), who queued its follow-ups;
	 * adding ours too would run the remainder twice.
	 */
	async #settle(id: string, followUps: Task[]): Promise<Queued[]> {
		const queue = await this.#loadQueue();
		const at = queue.findIndex((t) => t.id === id);
		if (at === -1) {
			return queue;
		}
		queue.splice(at, 1);
		queue.push(...followUps.map(stamp));
		await this.ctx.storage.put("queue", queue);
		return queue;
	}

	async #recordThrow(
		task: Task,
		endpoint: string,
		message: string
	): Promise<void> {
		await recordFetchError(this.env.DB, {
			endpoint,
			// Where a deploy lands: the task is requeued, so a restart costs
			// nothing and must not read as loss.
			errorClass: isRestart(message) ? "do_restarted" : "task_threw",
			message: message.slice(0, 1200),
			...unitParams(task),
		});
	}

	/**
	 * Re-arm the alarm if work is pending (watchdog path). Also pulls in an
	 * alarm parked in the far future. Otherwise a stale long-park (old deploy,
	 * post-pause) would block newly due work until it fires.
	 *
	 * A backoff park is the one far-future alarm that is *not* stale. Dragging it
	 * forward made the ten-minute watchdog cron wake the loop six times an hour
	 * for the whole pause, each wake spending two D1 reads and a write only to
	 * conclude it is still paused, up to four hours of that per incident, on a
	 * free-tier budget. So the pull-in asks whether the park matches the pause it
	 * would be serving, and leaves that one alone. Pacing is read only on the
	 * far-future branch, which is rare; the common path is unchanged.
	 */
	async ensureAlarm(): Promise<void> {
		const hasWork = await this.#hasWork();
		if (!hasWork) {
			return;
		}
		const now = Date.now();
		const current = await this.ctx.storage.getAlarm();
		if (current !== null && current <= now + 60_000) {
			return;
		}
		if (current !== null) {
			const pacing = await loadPacing(this.env.DB);
			if (pacing.pauseUntil > now && current <= pacing.pauseUntil + 60_000) {
				return;
			}
		}
		await this.ctx.storage.setAlarm(now + 1000);
	}

	async queueDepth(): Promise<number> {
		return ((await this.ctx.storage.get<Task[]>("queue")) ?? []).length;
	}

	async #recordThrottle(
		pacing: PacingState,
		source: "loop" | "admin"
	): Promise<void> {
		await savePacing(
			this.env.DB,
			source === "admin" ? onAdminThrottle(pacing) : onThrottle(pacing)
		);
	}

	static #breakdown(queue: Task[]): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const t of queue) {
			counts[t.type] = (counts[t.type] ?? 0) + 1;
		}
		return counts;
	}

	/**
	 * Run one task step immediately and report what happened. The manual
	 * trigger's engine.
	 *
	 * It deliberately ignores `pauseUntil`. That pause is a backoff against
	 * Apple's *public* iTunes endpoints, which rate-limit by IP and which all
	 * Workers share; it says nothing about App Store Connect or Apple Ads, which
	 * are credentialed, quota'd per account, and reached over different
	 * infrastructure. Blocking a credential check behind an iTunes backoff only
	 * delays the diagnosis without sparing Apple a single request.
	 *
	 * Follow-ups go back on the normal queue, so a multi-stage job continues on
	 * the paced loop rather than running unbounded here.
	 *
	 * `ok` reflects what the step *recorded*, not merely whether it threw. Task
	 * steps deliberately swallow a failed unit into `fetch_error` so one bad
	 * unit cannot wedge the queue: right for the unattended loop, useless for a
	 * human checking a credential. So we diff `fetch_error` across the call and
	 * hand back whatever appeared.
	 */
	async runNow(task: Task): Promise<{
		ok: boolean;
		followUps: number;
		errors: { endpoint: string; errorClass: string | null }[];
		threw?: string;
	}> {
		const { followUps, ...result } = await this.#runReported(task);
		await this.enqueue(followUps);
		return { ...result, followUps: followUps.length };
	}

	/** `runNow` without the enqueue, so `stepNow` can settle in place. */
	async #runReported(task: Task): Promise<{
		ok: boolean;
		followUps: Task[];
		errors: { endpoint: string; errorClass: string | null }[];
		threw?: string;
	}> {
		const pacing = await loadPacing(this.env.DB);
		const before = await this.env.DB.prepare(
			"SELECT COALESCE(MAX(id), 0) AS id FROM fetch_error"
		).first<{ id: number }>();
		const watermark = before?.id ?? 0;

		try {
			const followUps = cleared(await this.#run(task, pacing, "admin"));
			const recorded = await this.#errorsSince(watermark);
			return { errors: recorded, followUps, ok: recorded.length === 0 };
		} catch (error) {
			const threw = error instanceof Error ? error.message : "unknown failure";
			await this.#recordThrow(task, `admin:${task.type}`, threw);
			return {
				errors: await this.#errorsSince(watermark),
				followUps: [],
				ok: false,
				threw,
			};
		}
	}

	/**
	 * Pop the next queued task and run it immediately. Multi-stage jobs (ASC in
	 * particular) return follow-ups rather than looping, so verifying one end to
	 * end means advancing the queue by hand, or the follow-ups sit
	 * behind whatever pause the iTunes crawler is serving.
	 *
	 * The task stays queued while it runs and is settled by id afterwards, as
	 * the alarm does. Removing it first lost it outright when the step threw:
	 * a whole day's lookup batch, or the night's compaction, gone on one error.
	 */
	async stepNow(): Promise<
		| { empty: true }
		| {
				empty: false;
				task: string;
				ok: boolean;
				followUps: number;
				errors: { endpoint: string; errorClass: string | null }[];
				threw?: string;
		  }
	> {
		const [task] = await this.#loadQueue();
		if (!task) {
			return { empty: true };
		}
		const { followUps, ...result } = await this.#runReported(task);
		const next =
			result.threw === undefined
				? followUps
				: retryAfterThrow(task, result.threw);
		await this.#settle(task.id, next);
		if (next.length > 0) {
			await this.ensureAlarm();
		}
		return { empty: false, task: task.type, ...result, followUps: next.length };
	}

	/**
	 * Crawl one due pair immediately, ignoring the pacing pause.
	 *
	 * This exists because Apple rate-limits by IP and every Cloudflare Worker
	 * shares the same egress, so the deployed collector can be throttled to a
	 * standstill while the same request succeeds from an ordinary connection.
	 * Driving this from `wrangler dev` with remote D1/R2 bindings runs the real
	 * collector code, with the same normaliser, provenance and idempotent
	 * writes, from a machine Apple will answer, so the history it produces is
	 * indistinguishable from the scheduler's own.
	 *
	 * Pace it from the caller. Nothing here relaxes invariant 4.
	 */
	async crawlNow(): Promise<
		| { empty: true }
		| { empty: false; pairId: number; keyword: string; throttled: boolean }
	> {
		const pair = await pickDuePair(this.env.DB);
		if (!pair) {
			return { empty: true };
		}
		const windowStartHour =
			(await getStateJson<number>(this.env.DB, "tier1_window_start_hour")) ?? 3;
		const { throttled } = await crawlPair(this.env, pair, windowStartHour);
		if (throttled) {
			await this.#recordThrottle(await loadPacing(this.env.DB), "admin");
		}
		return {
			empty: false,
			keyword: pair.keyword_text,
			pairId: pair.id,
			throttled,
		};
	}

	/**
	 * Record a crawl that threw and decide when its pair is due again.
	 *
	 * A broken pair goes to tomorrow so it cannot wedge the loop. A hung
	 * connection or a deploy is not a broken pair: pushing either a day out lost
	 * that pair's rank for the day, which cannot be backfilled. Those come round
	 * again soon, and the overdue ordering in pickDuePair still lets every other
	 * due pair go first.
	 */
	async #crawlThrew(pair: DuePair, error: unknown, now: number): Promise<void> {
		const message = error instanceof Error ? error.message : "unknown";
		const restarted = isRestart(message);
		await recordFetchError(this.env.DB, {
			endpoint: "task:crawl",
			errorClass: restarted ? "do_restarted" : "task_threw",
			message: message.slice(0, 1200),
			// The shape crawlPair records under: the report and the coverage page
			// join on it, and a bare pair id made these losses invisible there.
			params: `${pair.keyword_text}|${pair.storefront_code}|${pair.locale_code}`,
		});
		const transient =
			restarted ||
			(error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError"));
		await this.env.DB.prepare(
			"UPDATE crawl_pair SET next_due_at = ? WHERE id = ?"
		)
			.bind(now + (transient ? CRAWL_RETRY_MS : 24 * 3_600_000), pair.id)
			.run();
	}

	async #errorsSince(
		id: number
	): Promise<{ endpoint: string; errorClass: string | null }[]> {
		const rows = await this.env.DB.prepare(
			"SELECT endpoint, error_class FROM fetch_error WHERE id > ? ORDER BY id LIMIT 10"
		)
			.bind(id)
			.all<{ endpoint: string; error_class: string | null }>();
		return rows.results.map((r) => ({
			endpoint: r.endpoint,
			errorClass: r.error_class,
		}));
	}

	async #hasWork(): Promise<boolean> {
		const queue = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
		if (queue.length > 0) {
			return true;
		}
		// A due pair is only work if this deployment can actually fetch it.
		// Otherwise the watchdog re-arms the alarm every ten minutes for pairs it
		// will never collect.
		if (!collectsPublicEndpoints(this.env)) {
			return false;
		}
		const due = await pickDuePair(this.env.DB);
		return due !== null;
	}

	override async alarm(): Promise<void> {
		const pacing = await loadPacing(this.env.DB);
		const now = Date.now();
		if (pacing.pauseUntil > now) {
			// Backing off after throttling: park until the pause ends. Still a live
			// tick: a paused loop and a dead one look identical without this.
			const parked = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
			await recordHeartbeat(this.env.DB, {
				at: now,
				didWork: false,
				queued: parked.length,
				tasks: SchedulerDO.#breakdown(parked),
			});
			await this.ctx.storage.setAlarm(pacing.pauseUntil + 1000);
			return;
		}

		let queue = await this.#loadQueue();
		const [task] = queue;
		let didWork = false;

		if (task) {
			didWork = true;
			let followUps: Task[];
			try {
				followUps = cleared(await this.#run(task, pacing, "loop"));
			} catch (error) {
				const message = error instanceof Error ? error.message : "unknown";
				await this.#recordThrow(task, `task:${task.type}`, message);
				followUps = retryAfterThrow(task, message);
			}
			queue = await this.#settle(task.id, followUps);
		} else {
			// No queued tasks: one Tier-1 keyword crawl if a pair is due, and only
			// where the public endpoints are reachable at all.
			const windowStartHour =
				(await getStateJson<number>(this.env.DB, "tier1_window_start_hour")) ??
				3;
			const pair = collectsPublicEndpoints(this.env)
				? await pickDuePair(this.env.DB)
				: null;
			if (pair) {
				didWork = true;
				try {
					const { throttled } = await crawlPair(
						this.env,
						pair,
						windowStartHour
					);
					console.log(`crawled pair ${pair.id} throttled=${throttled}`);
					if (throttled) {
						await this.#recordThrottle(pacing, "loop");
					}
				} catch (error) {
					await this.#crawlThrew(pair, error, now);
				}
			}
		}

		await recordHeartbeat(this.env.DB, {
			at: Date.now(),
			didWork,
			queued: queue.length,
			tasks: SchedulerDO.#breakdown(queue),
		});

		if (didWork || (await this.#hasWork())) {
			const fresh = await loadPacing(this.env.DB);
			const delay =
				fresh.pauseUntil > Date.now()
					? fresh.pauseUntil - Date.now() + 1000
					: tickMs(fresh);
			await this.ctx.storage.setAlarm(Date.now() + delay);
		}
		// else: drained. The watchdog re-arms when new work appears.
	}

	async #run(
		task: Task,
		pacing: PacingState,
		source: "loop" | "admin"
	): Promise<Task[]> {
		if (dropsTask(this.env, task.type, source)) {
			console.log(
				`dropped ${task.type}: this deployment collects credentialed endpoints only`
			);
			return [];
		}

		switch (task.type) {
			case "asc_poll": {
				return ascPollStep(this.env, task);
			}
			case "asc_fetch_instance": {
				return ascFetchInstanceStep(this.env, task);
			}
			case "ads_pull": {
				return adsPullStep(this.env, task);
			}
			case "ads_terms": {
				return adsTermsStep(this.env, task);
			}
			case "ads_discover": {
				return adsDiscoverStep(this.env, task);
			}
			case "compact": {
				return compactStep(this.env, task);
			}
			case "lookup_pull": {
				const r = await lookupPullStep(this.env, task);
				if (r.throttled) {
					await this.#recordThrottle(pacing, source);
				}
				return r.followUps;
			}
			case "review_pull": {
				const r = await reviewPullStep(this.env, task);
				if (r.throttled) {
					await this.#recordThrottle(pacing, source);
				}
				return r.followUps;
			}
			case "chart_pull": {
				const r = await chartPullStep(this.env, task);
				if (r.throttled) {
					await this.#recordThrottle(pacing, source);
				}
				return r.followUps;
			}
			default: {
				// Exhaustive: the Task union has no other members.
				return [];
			}
		}
	}
}
