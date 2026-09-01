import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { collectsPublicEndpoints } from "./lib/mode";
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
import { adsPullStep } from "./tasks/ads";
import { ascPollStep, ascFetchInstanceStep } from "./tasks/asc";
import { pickDuePair, crawlPair } from "./tasks/crawl";
import {
  lookupPullStep,
  reviewPullStep,
  chartPullStep,
  compactStep,
} from "./tasks/pulls";
import type { Task } from "./tasks/types";

/**
 * SchedulerDO — the single work loop for all collection.
 *
 * One alarm at a time (a DO invariant). Each alarm() tick does exactly one
 * bounded unit of work — one task step, or one Tier-1 keyword crawl — then
 * reschedules itself at the learned Apple-polite rate. When there is neither
 * queued work nor a due pair, no alarm is set; the watchdog cron re-arms
 * within 10 minutes of work becoming due.
 *
 * Budget hierarchy is structural: the task queue (which includes Tier-1
 * app-level pulls) runs before the keyword crawl; Tier-2 sweep tasks (M6)
 * will only be enqueued when the Tier-1 window is idle.
 *
 * Alarm contract: at-least-once, auto-retry ×6 with backoff on throw — every
 * step is idempotent, and we deliberately never call deleteAlarm().
 */
export class SchedulerDO extends DurableObject<Env> {
  async enqueue(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }
    const queue = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
    queue.push(...tasks);
    await this.ctx.storage.put("queue", queue);
    await this.ensureAlarm();
  }

  /**
   * Re-arm the alarm if work is pending (watchdog path). Also pulls in an
   * alarm parked in the far future — otherwise a stale long-park (old deploy,
   * post-pause) would block newly due work until it fires.
   *
   * A backoff park is the one far-future alarm that is *not* stale. Dragging it
   * forward made the ten-minute watchdog cron wake the loop six times an hour
   * for the whole pause, each wake spending two D1 reads and a write only to
   * conclude it is still paused — up to four hours of that per incident, on a
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
   * Run one task step immediately and report what happened — the manual
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
   * unit cannot wedge the queue — right for the unattended loop, useless for a
   * human checking a credential. So we diff `fetch_error` across the call and
   * hand back whatever appeared.
   */
  async runNow(task: Task): Promise<{
    ok: boolean;
    followUps: number;
    errors: { endpoint: string; errorClass: string | null }[];
    threw?: string;
  }> {
    const pacing = await loadPacing(this.env.DB);
    const before = await this.env.DB.prepare(
      "SELECT COALESCE(MAX(id), 0) AS id FROM fetch_error"
    ).first<{ id: number }>();
    const watermark = before?.id ?? 0;
    let threw: string | undefined;

    try {
      const followUps = await this.#run(task, pacing, "admin");
      await this.enqueue(followUps);
      const recorded = await this.#errorsSince(watermark);
      return {
        errors: recorded,
        followUps: followUps.length,
        ok: recorded.length === 0,
      };
    } catch (error) {
      threw = error instanceof Error ? error.message : "unknown failure";
      await recordFetchError(this.env.DB, {
        endpoint: `admin:${task.type}`,
        errorClass: "task_threw",
        message: threw.slice(0, 1200),
      });
      return {
        errors: await this.#errorsSince(watermark),
        followUps: 0,
        ok: false,
        threw,
      };
    }
  }

  /**
   * Pop the next queued task and run it immediately. Multi-stage jobs (ASC in
   * particular) return follow-ups rather than looping, so verifying one end to
   * end means advancing the queue by hand — otherwise the follow-ups sit
   * behind whatever pause the iTunes crawler is serving.
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
    const queue = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
    const task = queue.shift();
    if (!task) {
      return { empty: true };
    }
    await this.ctx.storage.put("queue", queue);
    const result = await this.runNow(task);
    return { empty: false, task: task.type, ...result };
  }

  /**
   * Crawl one due pair immediately, ignoring the pacing pause.
   *
   * This exists because Apple rate-limits by IP and every Cloudflare Worker
   * shares the same egress, so the deployed collector can be throttled to a
   * standstill while the same request succeeds from an ordinary connection.
   * Driving this from `wrangler dev` with remote D1/R2 bindings runs the real
   * collector code — same normaliser, same provenance, same idempotent
   * writes — from a machine Apple will answer, so the history it produces is
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

  async alarm(): Promise<void> {
    const pacing = await loadPacing(this.env.DB);
    const now = Date.now();
    if (pacing.pauseUntil > now) {
      // Backing off after throttling: park until the pause ends. Still a live
      // tick — a paused loop and a dead one look identical without this.
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

    const queue = (await this.ctx.storage.get<Task[]>("queue")) ?? [];
    const task = queue.shift();
    let didWork = false;

    if (task) {
      didWork = true;
      let followUps: Task[] = [];
      try {
        followUps = await this.#run(task, pacing, "loop");
      } catch (error) {
        const attempt = (task.attempt ?? 0) + 1;
        await recordFetchError(this.env.DB, {
          endpoint: `task:${task.type}`,
          errorClass: "task_threw",
          message:
            error instanceof Error ? error.message.slice(0, 1200) : "unknown",
        });
        if (attempt < 3) {
          followUps = [{ ...task, attempt }];
        }
      }
      queue.push(...followUps);
      await this.ctx.storage.put("queue", queue);
    } else {
      // No queued tasks: one Tier-1 keyword crawl if a pair is due — and only
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
          await recordFetchError(this.env.DB, {
            endpoint: "task:crawl",
            params: String(pair.id),
            errorClass: "task_threw",
            message:
              error instanceof Error ? error.message.slice(0, 1200) : "unknown",
          });
          // Push the pair to tomorrow so one broken pair can't wedge the loop.
          await this.env.DB.prepare(
            "UPDATE crawl_pair SET next_due_at = ? WHERE id = ?"
          )
            .bind(now + 24 * 3_600_000, pair.id)
            .run();
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
    // else: drained — the watchdog re-arms when new work appears.
  }

  async #run(
    task: Task,
    pacing: PacingState,
    source: "loop" | "admin"
  ): Promise<Task[]> {
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
