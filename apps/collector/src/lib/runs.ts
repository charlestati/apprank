// Evidence that the machine ran, as distinct from evidence that a fetch ran.
//
// Observation rows only ever prove work that produced data. A daily job that
// threw before enqueueing, a compaction that quietly stopped, an alarm loop
// that was never re-armed: none of those leave a row anywhere, and the first
// symptom is a hole in tomorrow's coverage. These two records close that gap:
//
// collector_run holds one row per scheduled job, opened before the work and
// closed after it. An unfinished row *is* the alarm. loop_heartbeat is the
// work loop's liveness, in collector_state rather than a table because it is
// overwritten every tick and only the newest value has any meaning. A row per
// tick would be pure growth for a value nobody reads twice.

import { setStateJson } from "./state";

export interface Heartbeat {
	at: number;
	queued: number;
	didWork: boolean;
	/**
	 * Queued task types and their counts. A bare depth is ambiguous: batch
	 * tasks re-enqueue their own remainder, so a queue that is draining
	 * normally and one that is spinning on the same task look identical
	 * without knowing what is actually in it.
	 */
	tasks?: Record<string, number>;
}

export const HEARTBEAT_KEY = "loop_heartbeat";

export async function recordHeartbeat(
	db: D1Database,
	beat: Heartbeat
): Promise<void> {
	await setStateJson(db, HEARTBEAT_KEY, beat);
}

/** Opens a run row and returns its id, for `finishRun` to close. */
export async function startRun(
	db: D1Database,
	job: string,
	trigger: "cron" | "admin"
): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO collector_run (job, trigger, started_at) VALUES (?, ?, ?) RETURNING id"
		)
		.bind(job, trigger, Date.now())
		.first<{ id: number }>();
	return row?.id ?? 0;
}

export async function finishRun(
	db: D1Database,
	id: number,
	ok: boolean,
	detail?: unknown
): Promise<void> {
	if (id === 0) {
		return;
	}
	await db
		.prepare(
			"UPDATE collector_run SET finished_at = ?, ok = ?, detail = ? WHERE id = ?"
		)
		.bind(
			Date.now(),
			ok ? 1 : 0,
			detail === undefined ? null : JSON.stringify(detail),
			id
		)
		.run();
}

/**
 * Run `work` bracketed by a run row. The failure path closes the row with
 * `ok = 0` and rethrows: the caller's own error handling is unchanged, but the
 * failure is now visible without reading Worker logs.
 */
export async function tracked<T>(
	db: D1Database,
	job: string,
	trigger: "cron" | "admin",
	work: () => Promise<T>
): Promise<T> {
	const id = await startRun(db, job, trigger);
	try {
		const result = await work();
		await finishRun(db, id, true, result ?? undefined);
		return result;
	} catch (error) {
		await finishRun(db, id, false, {
			error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
		});
		throw error;
	}
}
