import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../api";
import type { DataHealth } from "../api";
import { InfoTip } from "../components/info-tip";
import { useFormat } from "../format";
import type { Dictionary } from "../i18n";
import { fmt, useT } from "../i18n";

/**
 * How a tile reads at a glance. `bad` is the red the page reserves for
 * "today's numbers need a second look"; `warn` is worth knowing but not a
 * loss; `progress` is a day still being collected. Each has its own shape as
 * well as its colour, and a word for a screen reader, so the colour is never
 * the only channel.
 */
type TileStatus = "ok" | "progress" | "warn" | "bad";

function StatusIcon({ status }: { status: TileStatus }) {
	const t = useT();
	const word = {
		bad: t.statusBad,
		ok: t.statusOk,
		progress: t.statusProgress,
		warn: t.statusWarn,
	}[status];
	let icon: ReactNode = <CircleCheck aria-hidden="true" size={18} />;
	if (status === "progress") {
		icon = <Clock aria-hidden="true" size={18} />;
	} else if (status !== "ok") {
		icon = <TriangleAlert aria-hidden="true" size={18} />;
	}
	return (
		<span className={`tile-status tile-status-${status}`}>
			{icon}
			<span className="sr-only">{word}</span>
		</span>
	);
}

/**
 * One health tile: a status mark, a label with its explanation behind "?",
 * the number, and at most a short line of state ("paused until 14:05",
 * "review_pull ×3"). What a tile means lives in the "?", because it is read
 * once; the state line is read every visit.
 */
function HealthTile({
	help,
	label,
	note,
	status,
	value,
}: {
	help: string;
	label: string;
	note?: ReactNode;
	status: TileStatus;
	value: ReactNode;
}) {
	let valueClass = "stat-value";
	if (status === "bad") {
		valueClass = "stat-value stat-bad";
	} else if (status === "warn") {
		valueClass = "stat-value stat-warn";
	}
	return (
		<div className="tile health-tile">
			<div className="tile-title">
				<StatusIcon status={status} />
				<span>{label}</span>
				<InfoTip label={label}>{help}</InfoTip>
			</div>
			<div className={valueClass}>{value}</div>
			{note ? <div className="tile-note">{note}</div> : null}
		</div>
	);
}

/**
 * A wait in words a reader can hold: "13 h 10 min", not "790m". Days past 48
 * hours, because at that point the minutes are noise.
 */
function humanMinutes(t: Dictionary, minutes: number): string {
	if (minutes < 60) {
		return fmt(t.durationMinutes, { m: minutes });
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		const m = minutes % 60;
		return m === 0
			? fmt(t.durationHours, { h: hours })
			: fmt(t.durationHoursMinutes, { h: hours, m });
	}
	return fmt(t.durationDaysHours, {
		d: Math.floor(hours / 24),
		h: hours % 24,
	});
}

/** "chart_pull ×6, review_pull ×2": what the depth is actually made of. */
function queueSummary(tasks?: Record<string, number>): string | null {
	if (!tasks) {
		return null;
	}
	const parts = Object.entries(tasks)
		.toSorted((a, b) => b[1] - a[1])
		.map(([type, n]) => `${type} ×${n}`);
	return parts.length > 0 ? parts.join(", ") : null;
}

/** The watchdog cron re-arms the loop every ten minutes, plus slack. */
const LOOP_STALL_MS = 15 * 60_000;

/**
 * When work has been waiting for the loop, or null when none is.
 *
 * The work loop parks with no alarm once everything due is collected, and on
 * the credentialed Worker that is most of the day: it only ever runs the few
 * App Store Connect and Apple Ads tasks the daily job queues. An old heartbeat
 * is therefore normal, and colouring it red on age alone made the tile red
 * every afternoon. Silence is a fault only against queued work the watchdog
 * should have picked up: either the queue the last tick left behind, or a
 * daily run that queued tasks after that tick and was never followed by one.
 */
function loopWaitingSince(
	loop: NonNullable<DataHealth["loop"]>,
	run: DataHealth["lastDailyRun"]
): number | null {
	if (loop.queued > 0) {
		return loop.at;
	}
	if (run !== null && (run.queued ?? 0) > 0 && run.startedAt > loop.at) {
		return run.startedAt;
	}
	return null;
}

/**
 * A heartbeat that is missing entirely is a different, worse thing than one
 * that is merely old. A backoff pause parks the loop on purpose, with work
 * queued, so it is not a stall either; the crawl-rate tile already says so.
 */
function LoopTile({
	loop,
	now,
	paused,
	run,
}: {
	loop: DataHealth["loop"];
	now: number;
	paused: boolean;
	run: DataHealth["lastDailyRun"];
}) {
	const t = useT();
	if (loop === null) {
		return (
			<HealthTile
				help={t.helpLoop}
				label={t.workLoop}
				note={t.loopNeverTicked}
				status="bad"
				value="–"
			/>
		);
	}
	const ageMin = Math.round((now - loop.at) / 60_000);
	const age = humanMinutes(t, ageMin);
	const waitingSince = loopWaitingSince(loop, run);
	const stalled =
		!paused && waitingSince !== null && now - waitingSince > LOOP_STALL_MS;
	let queue = t.loopIdle;
	let waiting = 0;
	if (loop.queued > 0) {
		waiting = loop.queued;
		queue = queueSummary(loop.tasks) ?? fmt(t.loopQueued, { n: loop.queued });
	} else if (waitingSince !== null) {
		waiting = run?.queued ?? 0;
		queue = fmt(t.loopQueued, { n: waiting });
	}
	// The red explains itself: the "?" on a stalled loop says what is stuck
	// and why that is a fault when an old heartbeat usually is not.
	return (
		<HealthTile
			help={stalled ? fmt(t.helpLoopStalled, { age, n: waiting }) : t.helpLoop}
			label={t.workLoop}
			note={queue}
			status={stalled ? "bad" : "ok"}
			value={age}
		/>
	);
}

function dailyRunNote(
	run: NonNullable<DataHealth["lastDailyRun"]>,
	t: Dictionary
): string {
	if (run.finishedAt === null) {
		return t.dailyUnfinished;
	}
	const queued =
		run.queued === null ? "" : fmt(t.dailyQueuedSuffix, { n: run.queued });
	// The trigger is a machine word, cron or manual, and stays untranslated.
	return `${run.ok ? t.dailyCompleted : t.dailyFailed} · ${run.trigger}${queued}`;
}

/**
 * The daily job is a 03:00 cron, so the newest run is at most a day old plus
 * however long the cron slips. Past this it did not fire.
 */
const DAILY_STALE_MS = 26 * 3_600_000;

function sameLocalDay(a: number, b: number): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

function DailyRunTile({
	now,
	run,
}: {
	now: number;
	run: DataHealth["lastDailyRun"];
}) {
	const f = useFormat();
	const t = useT();
	if (run === null) {
		return (
			<HealthTile
				help={t.helpDailyJob}
				label={t.lastDailyJob}
				note={t.dailyNoRun}
				status="bad"
				value="–"
			/>
		);
	}
	// The server sends the newest run of any age. A clock time alone read as
	// this morning's whether the cron last fired today or three days ago, which
	// is the one failure this tile exists to show.
	const stale = now - run.startedAt > DAILY_STALE_MS;
	// An unfinished row is the crash the observation tables cannot show.
	const bad = stale || run.finishedAt === null || run.ok === false;
	return (
		<HealthTile
			help={t.helpDailyJob}
			label={t.lastDailyJob}
			note={`${stale ? `${t.dailyStale} · ` : ""}${dailyRunNote(run, t)}`}
			status={bad ? "bad" : "ok"}
			value={
				sameLocalDay(run.startedAt, now)
					? f.time(run.startedAt)
					: f.dayTime(run.startedAt)
			}
		/>
	);
}

function OverdueTile({ n }: { n: number }) {
	const f = useFormat();
	const t = useT();
	return (
		<HealthTile
			help={t.helpOverdue}
			label={t.overduePairs}
			status={n > 0 ? "warn" : "ok"}
			value={f.number(n)}
		/>
	);
}

/**
 * `fetch_error.error_class` is a closed vocabulary, chosen so the counts group
 * cleanly. The values are exact and mean nothing to a reader, so each one is
 * shown in words with the raw class kept alongside for grepping the logs.
 */
function classLabel(t: Dictionary, errorClass: string | null): string {
	// Rows older than the closed vocabulary carry no class at all.
	if (errorClass === null) {
		return t.errUnclassified;
	}
	const known: Record<string, string> = {
		app_not_in_storefront: t.errAppNotInStorefront,
		http_error: t.errHttpError,
		invalid_body: t.errInvalidBody,
		pull_abandoned: t.errPullAbandoned,
		rate_limited: t.errRateLimited,
		task_threw: t.errTaskThrew,
		throttled: t.errThrottled,
		do_restarted: t.errDoRestarted,
		duplicate_processing_date: t.errDuplicateProcessingDate,
		skipped_processing_date: t.errSkippedProcessingDate,
		stopped_due_to_inactivity: t.errStoppedDueToInactivity,
		upstream_error: t.errUpstreamError,
	};
	return known[errorClass] ?? errorClass;
}

/**
 * One error class at one endpoint, with when it last happened and what the
 * upstream actually said. The message is collapsed by default: an Apple error
 * body is several hundred characters of JSON, and pasting that into the table
 * cost the page its readable layout: the count column was pushed off-screen
 * entirely.
 */
function ErrorRow({ entry }: { entry: DataHealth["errorsLast24h"][number] }) {
	const f = useFormat();
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<tr>
			<td className="col-when">{f.time(entry.lastAt)}</td>
			<td className="col-class">
				{classLabel(t, entry.errorClass)}
				{/* The server decides, because the status badge counts the same
            classes and two copies of that judgment would drift. */}
				{entry.loss && (
					<span className="lozenge lozenge-removed error-cost">
						{t.errorsCostNote}
					</span>
				)}
				{/* The raw value too: it is what the logs and the vocabulary in
            CLAUDE.md use, so an operator moving between the two needs it. */}
				{entry.errorClass === null ? null : (
					<span className="error-class-raw">{entry.errorClass}</span>
				)}
			</td>
			<td className="col-where">
				<code>{entry.endpoint}</code>
			</td>
			<td className="col-count">{f.number(entry.n)}</td>
			<td>
				{entry.message === null ? (
					<span className="muted">—</span>
				) : (
					<button
						aria-expanded={open}
						className={open ? "error-detail open" : "error-detail"}
						onClick={() => setOpen(!open)}
						title={open ? t.collapse : t.expand}
						type="button"
					>
						{entry.message}
					</button>
				)}
			</td>
		</tr>
	);
}

/**
 * The crawl budget: searches a day the cadence needs, against what the
 * learned rate can make once app pulls have their share. Drawn as a used
 * share of a bar, with both numbers printed, because a bare "3208 / 387" left
 * the reader to guess which was the limit.
 */
function BudgetTile({ cadence }: { cadence: DataHealth["cadence"] }) {
	const f = useFormat();
	const t = useT();
	if (cadence === null) {
		return (
			<HealthTile
				help={t.helpBudgetPending}
				label={t.crawlBudget}
				note={t.budgetPending}
				status="progress"
				value="–"
			/>
		);
	}
	const load = Math.round(cadence.loadPerDay);
	const capacity = cadence.capacity.keywordsPerDay;
	const share = capacity > 0 ? Math.min(load / capacity, 1) : 1;
	return (
		<HealthTile
			help={`${fmt(t.helpBudget, {
				n: f.number(cadence.capacity.overheadPerDay),
			})} ${cadence.summary}`}
			label={t.crawlBudget}
			note={
				<span aria-hidden="true" className="budget-track">
					<span
						className={
							cadence.saturated ? "budget-fill budget-full" : "budget-fill"
						}
						style={{ width: `${Math.round(share * 100)}%` }}
					/>
				</span>
			}
			status={cadence.saturated ? "bad" : "ok"}
			value={
				<>
					{f.number(load)}
					<span className="stat-of">
						{" "}
						{fmt(t.budgetOf, { capacity: f.number(capacity) })}
					</span>
				</>
			}
		/>
	);
}

export function Health({
	onAcknowledge,
	unread,
}: {
	onAcknowledge: () => void;
	unread: number;
}) {
	const f = useFormat();
	const t = useT();
	// "failed" is its own answer. This is the page a reader is sent to when
	// something is wrong, so a request that failed must not look like one that
	// is still on its way.
	const [h, setH] = useState<DataHealth | "failed" | null>(null);
	const [loadedAt, setLoadedAt] = useState(0);
	useEffect(() => {
		(async () => {
			try {
				setH(await api.health());
				setLoadedAt(Date.now());
			} catch {
				setH("failed");
			}
		})();
	}, []);

	if (h === null) {
		return <p className="empty">{t.loading}</p>;
	}
	if (h === "failed") {
		return <p className="empty">{t.loadFailed}</p>;
	}
	const coverage =
		h.tier1Pairs > 0 ? Math.round((h.collectedToday / h.tier1Pairs) * 100) : 0;
	// Rows are grouped by class and endpoint, so one class can be several rows.
	const throttled = h.errorsLast24h
		.filter((e) => e.errorClass === "throttled")
		.reduce((sum, e) => sum + e.n, 0);
	const pauseUntil = h.pacing?.pauseUntil ?? 0;
	const paused = pauseUntil > loadedAt;

	return (
		<>
			<header className="page-header">
				<div className="page-title">
					<h1>{t.dataHealth}</h1>
					<InfoTip label={t.dataHealth}>{t.healthIntro}</InfoTip>
				</div>
			</header>
			<div className="tiles">
				<HealthTile
					help={fmt(t.helpCoverage, { date: f.day(h.date) })}
					label={t.coverageToday}
					note={fmt(t.coveragePct, { pct: coverage })}
					status={
						h.tier1Pairs > 0 && h.collectedToday >= h.tier1Pairs
							? "ok"
							: "progress"
					}
					value={
						<>
							{h.collectedToday}
							<span className="stat-of"> / {h.tier1Pairs}</span>
						</>
					}
				/>
				<HealthTile
					help={t.helpCrawlRate}
					label={t.crawlRate}
					note={
						paused ? fmt(t.crawlPaused, { time: f.time(pauseUntil) }) : null
					}
					status={paused ? "warn" : "ok"}
					value={
						<>
							{h.pacing ? f.decimal(h.pacing.ratePerMin, 1) : "–"}
							<span className="stat-of"> {t.perMinute}</span>
						</>
					}
				/>
				<HealthTile
					help={t.helpThrottle}
					label={t.throttleHits}
					status={throttled > 0 ? "bad" : "ok"}
					value={throttled}
				/>
				<BudgetTile cadence={h.cadence} />
				<LoopTile
					loop={h.loop}
					now={loadedAt}
					paused={paused}
					run={h.lastDailyRun}
				/>
				<DailyRunTile now={loadedAt} run={h.lastDailyRun} />
				<OverdueTile n={h.overduePairs} />
				<HealthTile
					help={t.helpAscAnomalies}
					label={t.ascAnomalies}
					status={h.ascAnomalies.length > 0 ? "warn" : "ok"}
					value={h.ascAnomalies.length}
				/>
			</div>

			{/* The same card, toolbar and scrollport as the report's table, so the
          two read as one component at two sizes rather than as a styled table
          and a bare one. */}
			<section className="card table-card error-log">
				<div className="table-toolbar">
					{/* The count rides with the heading rather than sitting apart: the
              toolbar is space-between, so a third child would push it into the
              middle of the row where it reads as unrelated to either. */}
					<div className="toolbar-title">
						<h2 className="section-title">{t.errorsLast24h}</h2>
						{h.lostLast24h > 0 && (
							<span className="lozenge lozenge-removed">
								{fmt(t.lostCount, { n: h.lostLast24h })}
							</span>
						)}
					</div>
					{/* Clearing is explicit rather than on arrival: a badge that cleared
              because you glanced at the page cannot be returned to, and the
              next loss still has to be able to raise it again. */}
					{unread > 0 && (
						<button className="button" onClick={onAcknowledge} type="button">
							{t.markSeen}
						</button>
					)}
				</div>
				{/* No header row over nothing: an empty table is a state, said as
				    one. */}
				{h.errorsLast24h.length === 0 ? (
					<p className="empty-state">
						<CircleCheck aria-hidden="true" size={18} />
						{t.noErrors}
					</p>
				) : (
					<div className="table-scroll">
						<table className="grid">
							<thead>
								<tr>
									<th className="col-when">{t.lastSeen}</th>
									<th className="col-class">{t.classLabel}</th>
									<th className="col-where">{t.errorsWhere}</th>
									<th className="col-count">{t.count}</th>
									<th>{t.detail}</th>
								</tr>
							</thead>
							<tbody>
								{h.errorsLast24h.map((e) => (
									<ErrorRow entry={e} key={`${e.errorClass}|${e.endpoint}`} />
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}
