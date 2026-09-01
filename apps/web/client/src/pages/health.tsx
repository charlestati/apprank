import { useEffect, useState } from "react";

import { api } from "../api";
import type { DataHealth } from "../api";
import { useFormat } from "../format";
import { useT } from "../i18n";

/** "chart_pull ×6, review_pull ×2" — what the depth is actually made of. */
function queueSummary(tasks?: Record<string, number>): string | null {
  if (!tasks) {
    return null;
  }
  const parts = Object.entries(tasks)
    .toSorted((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ×${n}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The work loop parks with no alarm once everything due is collected, so
 * silence is only alarming against the 10-minute watchdog cron's promise to
 * re-arm it. A heartbeat that is missing entirely is a different, worse thing
 * than one that is merely old.
 */
function LoopTile({ loop, now }: { loop: DataHealth["loop"]; now: number }) {
  if (loop === null) {
    return (
      <div className="tile">
        <div className="tile-title">Work loop</div>
        <div className="stat-value stat-bad">–</div>
        <div className="tile-note">
          never ticked — the collector has not run
        </div>
      </div>
    );
  }
  const ageMin = Math.round((now - loop.at) / 60_000);
  return (
    <div className="tile">
      <div className="tile-title">Work loop</div>
      <div className={ageMin > 15 ? "stat-value stat-bad" : "stat-value"}>
        {ageMin}m
      </div>
      <div className="tile-note">
        since last tick ·{" "}
        {loop.queued === 0
          ? "queue empty"
          : (queueSummary(loop.tasks) ?? `${loop.queued} queued`)}
      </div>
    </div>
  );
}

function dailyRunNote(run: NonNullable<DataHealth["lastDailyRun"]>): string {
  if (run.finishedAt === null) {
    return "started and never finished";
  }
  const queued = run.queued === null ? "" : ` · queued ${run.queued}`;
  return `${run.ok ? "completed" : "failed"} · ${run.trigger}${queued}`;
}

function DailyRunTile({ run }: { run: DataHealth["lastDailyRun"] }) {
  const f = useFormat();
  if (run === null) {
    return (
      <div className="tile">
        <div className="tile-title">Last daily job</div>
        <div className="stat-value stat-bad">–</div>
        <div className="tile-note">no run recorded yet</div>
      </div>
    );
  }
  // An unfinished row is the crash the observation tables cannot show.
  const bad = run.finishedAt === null || run.ok === false;
  return (
    <div className="tile">
      <div className="tile-title">Last daily job</div>
      <div className={bad ? "stat-value stat-bad" : "stat-value"}>
        {f.time(run.startedAt)}
      </div>
      <div className="tile-note">{dailyRunNote(run)}</div>
    </div>
  );
}

function OverdueTile({ n }: { n: number }) {
  const f = useFormat();
  return (
    <div className="tile">
      <div className="tile-title">Overdue pairs</div>
      <div className={n > 0 ? "stat-value stat-warn" : "stat-value"}>
        {f.number(n)}
      </div>
      <div className="tile-note">past due by more than one interval</div>
    </div>
  );
}

/**
 * One error class, with when it last happened and what the upstream actually
 * said. The message is collapsed by default: an Apple error body is several
 * hundred characters of JSON, and pasting that into the table cost the page
 * its readable layout — the count column was pushed off-screen entirely.
 */
function ErrorRow({ entry }: { entry: DataHealth["errorsLast24h"][number] }) {
  const f = useFormat();
  const [open, setOpen] = useState(false);
  return (
    <tr>
      <td className="col-when">{f.time(entry.lastAt)}</td>
      <td className="col-class">{entry.errorClass}</td>
      <td className="col-count">{f.number(entry.n)}</td>
      <td>
        {entry.message === null ? (
          <span className="muted">—</span>
        ) : (
          <button
            className={open ? "error-detail open" : "error-detail"}
            onClick={() => setOpen(!open)}
            title={open ? "Collapse" : "Expand"}
            type="button"
          >
            {entry.message}
          </button>
        )}
      </td>
    </tr>
  );
}

export function Health() {
  const f = useFormat();
  const t = useT();
  const [h, setH] = useState<DataHealth | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        setH(await api.health());
        setLoadedAt(Date.now());
      } catch {
        setH(null);
      }
    })();
  }, []);

  if (!h) {
    return <p className="empty">Loading…</p>;
  }
  const coverage =
    h.tier1Pairs > 0 ? Math.round((h.collectedToday / h.tier1Pairs) * 100) : 0;
  const throttled =
    h.errorsLast24h.find((e) => e.errorClass === "throttled")?.n ?? 0;
  const pauseUntil = h.pacing?.pauseUntil ?? 0;
  const paused = pauseUntil > loadedAt;

  return (
    <>
      <h1>{t.dataHealth}</h1>
      <p className="page-sub">
        Visible gaps beat silent garbage. Anything red here means today&apos;s
        numbers need a second look.
      </p>
      <div className="tiles">
        <div className="tile">
          <div className="tile-title">Coverage today</div>
          <div className="stat-value">
            {h.collectedToday}
            <span className="stat-of"> / {h.tier1Pairs}</span>
          </div>
          <div className="tile-note">
            {coverage}% of Tier-1 pairs observed ({f.day(h.date)})
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">Crawl rate</div>
          <div className="stat-value">
            {h.pacing ? f.decimal(h.pacing.ratePerMin, 1) : "–"}
          </div>
          <div className="tile-note">
            {paused
              ? `paused until ${f.time(pauseUntil)}`
              : "fetches/min, learned"}
          </div>
        </div>
        <div className="tile">
          <div className="tile-title">Throttle hits (24h)</div>
          <div className={throttled > 0 ? "stat-value stat-bad" : "stat-value"}>
            {throttled}
          </div>
          <div className="tile-note">403/429 from Apple</div>
        </div>
        <div className="tile">
          <div className="tile-title">Crawl budget</div>
          <div
            className={
              h.cadence?.saturated ? "stat-value stat-bad" : "stat-value"
            }
          >
            {h.cadence ? h.cadence.capacity.keywordsPerDay : "–"}
            <span className="stat-of">
              {" "}
              / {h.cadence ? Math.round(h.cadence.loadPerDay) : "–"}
            </span>
          </div>
          <div className="tile-note">
            {h.cadence
              ? `${h.cadence.summary} ${h.cadence.capacity.overheadPerDay} fetches/day reserved for app pulls.`
              : "not computed yet — runs with the daily jobs"}
          </div>
        </div>
        <LoopTile loop={h.loop} now={loadedAt} />
        <DailyRunTile run={h.lastDailyRun} />
        <OverdueTile n={h.overduePairs} />
        <div className="tile">
          <div className="tile-title">ASC anomalies</div>
          <div
            className={
              h.ascAnomalies.length > 0 ? "stat-value stat-warn" : "stat-value"
            }
          >
            {h.ascAnomalies.length}
          </div>
          <div className="tile-note">duplicate / skipped report dates</div>
        </div>
      </div>

      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Errors, last 24h</h2>
      <div className="error-log">
        <table className="grid">
          <thead>
            <tr>
              <th className="col-when">{t.lastSeen}</th>
              <th className="col-class">{t.classLabel}</th>
              <th className="col-count">{t.count}</th>
              <th>{t.detail}</th>
            </tr>
          </thead>
          <tbody>
            {h.errorsLast24h.map((e) => (
              <ErrorRow entry={e} key={e.errorClass} />
            ))}
            {h.errorsLast24h.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--good-text)" }}>
                  {t.noErrors}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
