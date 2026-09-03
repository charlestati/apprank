// Data health: visible gaps beat silent garbage.
//
// Everything the daily-run dashboard needs to answer "can I trust today's
// numbers?". Collector pacing, cadence and error classes describe shared
// infrastructure, since `crawl_pair` is deliberately the union of what every
// operator tracks, so they are not scoped to a user. ASC anomalies are the
// exception: they describe first-party analytics for one app, so they are
// joined against `tracked_app` and answer only for apps the caller tracks.

const DAY_MS = 86_400_000;

export interface ErrorClassRow {
	error_class: string;
	endpoint: string;
	n: number;
	last_at: number;
	sample_message: string | null;
}

export interface DataHealth {
	ascAnomalies: unknown[];
	lastDailyRun: {
		finishedAt: number | null;
		ok: boolean | null;
		queued: number | null;
		startedAt: number;
		trigger: string;
	} | null;
	loop: {
		at: number;
		queued: number;
		didWork: boolean;
		tasks?: Record<string, number>;
	} | null;
	overduePairs: number;
	cadence: unknown;
	collectedToday: number;
	date: string;
	errorsLast24h: {
		errorClass: string;
		/** Which Apple endpoint failed. A class on its own names no subject. */
		endpoint: string;
		lastAt: number;
		message: string | null;
		n: number;
	}[];
	pacing: unknown;
	tier1Pairs: number;
}

export async function dataHealth(
	db: D1Database,
	userId: string
): Promise<DataHealth> {
	const today = new Date().toISOString().slice(0, 10);
	const dayAgo = Date.now() - DAY_MS;
	const [
		due,
		collected,
		errors,
		pacing,
		cadence,
		anomalies,
		heartbeat,
		lastDaily,
		overdue,
	] = await Promise.all([
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM crawl_pair WHERE ref_count > 0 AND tier = 1"
			)
			.first<{ n: number }>(),
		// Joined to crawl_pair so the numerator counts the same population as the
		// denominator above. A retired pair keeps its history and can still carry
		// an observation from earlier the same day it was dropped, so counting
		// every ranking row against the active pair count reported 443/387, and a
		// coverage figure over 100% is the one number nobody re-reads.
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM ranking r
           JOIN crawl_pair cp ON cp.id = r.pair_id
          WHERE r.observed_date = ? AND r.valid = 1
            AND cp.ref_count > 0 AND cp.tier = 1`
			)
			.bind(today)
			.first<{ n: number }>(),
		// Grouped by class, but carrying when it last happened and one example
		// message. A class and a count cannot be acted on on their own: the next
		// question is always "when, and what did Apple actually say?".
		db
			.prepare(
				// Grouped by endpoint as well as class. Grouped by class alone, nine
				// throttles read as one number with no subject, and a reader could not
				// tell that the keyword crawl was untouched and the app-level pulls were
				// the problem. That is the first question anyone asks of this table.
				`SELECT error_class, endpoint,
              COUNT(*) AS n,
              MAX(fetched_at) AS last_at,
              (SELECT m.message FROM fetch_error m
                WHERE m.error_class IS fetch_error.error_class
                  AND m.endpoint IS fetch_error.endpoint
                  AND m.fetched_at > ?1 AND m.message IS NOT NULL
                ORDER BY m.fetched_at DESC LIMIT 1) AS sample_message
       FROM fetch_error WHERE fetched_at > ?1
       GROUP BY error_class, endpoint ORDER BY n DESC, last_at DESC`
			)
			.bind(dayAgo)
			.all<ErrorClassRow>(),
		db
			.prepare("SELECT value FROM collector_state WHERE key = 'pacing'")
			.first<{ value: string }>(),
		db
			.prepare("SELECT value FROM collector_state WHERE key = 'cadence_plan'")
			.first<{ value: string }>(),
		// First-party analytics, so it answers only for the caller's own apps.
		db
			.prepare(
				`SELECT ari.app_id, ari.report_type, ari.processing_date, ari.anomaly
       FROM asc_report_instance ari
       JOIN tracked_app ta ON ta.app_id = ari.app_id AND ta.user_id = ?1
       WHERE ari.anomaly IS NOT NULL
       ORDER BY ari.processing_date DESC LIMIT 20`
			)
			.bind(userId)
			.all(),
		// Loop liveness. Absent or stale means the work loop is not ticking,
		// which no observation table can tell you: it looks exactly like a day
		// with nothing due.
		db
			.prepare("SELECT value FROM collector_state WHERE key = 'loop_heartbeat'")
			.first<{ value: string }>(),
		db
			.prepare(
				"SELECT job, trigger, started_at, finished_at, ok, detail FROM collector_run WHERE job = 'daily' ORDER BY started_at DESC LIMIT 1"
			)
			.first<{
				job: string;
				trigger: string;
				started_at: number;
				finished_at: number | null;
				ok: number | null;
				detail: string | null;
			}>(),
		// Pairs past due by more than a full extra interval: the signal that
		// flexing frequency has quietly turned into losing coverage.
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM crawl_pair
         WHERE ref_count > 0 AND tier = 1
           AND next_due_at < ? - (interval_hours * 3600000)`
			)
			.bind(Date.now())
			.first<{ n: number }>(),
	]);

	return {
		ascAnomalies: anomalies.results,
		// NULL finished_at on the newest row means the last daily job started and
		// never completed. No observation table records that: a job that dies
		// before it writes looks the same as a quiet day.
		lastDailyRun: lastDaily
			? {
					finishedAt: lastDaily.finished_at,
					ok: lastDaily.ok === null ? null : lastDaily.ok === 1,
					queued: lastDaily.detail
						? ((JSON.parse(lastDaily.detail) as { queued?: number }).queued ??
							null)
						: null,
					startedAt: lastDaily.started_at,
					trigger: lastDaily.trigger,
				}
			: null,
		loop: heartbeat
			? (JSON.parse(heartbeat.value) as {
					at: number;
					queued: number;
					didWork: boolean;
					tasks?: Record<string, number>;
				})
			: null,
		overduePairs: overdue?.n ?? 0,
		// The budget plan explains today's cadence: how many pairs are checked
		// daily, and how many were stretched to fit the learned Apple rate.
		cadence: cadence ? JSON.parse(cadence.value) : null,
		collectedToday: collected?.n ?? 0,
		date: today,
		errorsLast24h: errors.results.map((e) => ({
			endpoint: e.endpoint,
			errorClass: e.error_class,
			lastAt: e.last_at,
			message: e.sample_message,
			n: e.n,
		})),
		pacing: pacing ? JSON.parse(pacing.value) : null,
		tier1Pairs: due?.n ?? 0,
	};
}
