// The three summary tiles above the chart: where we stand, how the ranks are
// spread, and which way they moved.

import type { Report } from "../api";
import { useT } from "../i18n";

function DistributionBar({
  count,
  label,
  max,
}: {
  count: number;
  label: string;
  max: number;
}) {
  const height = max === 0 ? 0 : Math.round((count / max) * 100);
  return (
    <div className="dist-col">
      <div className="dist-count">{count}</div>
      <div className="dist-bar" style={{ height: `${Math.max(height, 4)}%` }} />
      <div className="dist-label">{label}</div>
    </div>
  );
}

export function SummaryTiles({ stats }: { stats: Report["stats"] }) {
  const t = useT();
  const { distribution: d, movement: m } = stats;
  const maxBucket = Math.max(d.top5, d.top25, d.top100, d.beyond, 1);
  const moved = m.up + m.down + m.unchanged || 1;

  return (
    <div className="tiles">
      <section className="tile">
        <h2 className="tile-title">{t.averageRank}</h2>
        <div className="tile-body">
          <div className="stat-hero">
            <span className="stat-value">{stats.averageRank ?? "—"}</span>
            {stats.averageRankChange ? (
              <span
                className={
                  stats.averageRankChange > 0
                    ? "delta delta-up"
                    : "delta delta-down"
                }
              >
                <span aria-hidden="true">
                  {stats.averageRankChange > 0 ? "↑" : "↓"}
                </span>
                {Math.abs(stats.averageRankChange)}
              </span>
            ) : null}
          </div>
          <dl className="stat-pair">
            <div>
              <dt>{t.best}</dt>
              <dd>{stats.best ?? "—"}</dd>
            </div>
            <div>
              <dt>{t.worst}</dt>
              <dd>{stats.worst ?? "—"}</dd>
            </div>
            <div>
              <dt>{t.ranked}</dt>
              <dd>
                {stats.rankedKeywords}
                <span className="stat-of">/{stats.trackedKeywords}</span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="tile">
        <h2 className="tile-title">{t.rankDistribution}</h2>
        <div className="dist">
          <DistributionBar count={d.top5} label={t.top5} max={maxBucket} />
          <DistributionBar count={d.top25} label={t.top25} max={maxBucket} />
          <DistributionBar count={d.top100} label={t.top100} max={maxBucket} />
          <DistributionBar
            count={d.beyond}
            label={t.beyond100}
            max={maxBucket}
          />
        </div>
      </section>

      <section className="tile">
        <h2 className="tile-title">{t.keywordMovement}</h2>
        <div className="movement">
          <div className="movement-stats">
            <div>
              <span className="delta delta-up">
                <span aria-hidden="true">↑</span> {m.up}
              </span>
              <span className="movement-label">{t.wentUp}</span>
            </div>
            <div>
              <span className="delta delta-down">
                <span aria-hidden="true">↓</span> {m.down}
              </span>
              <span className="movement-label">{t.wentDown}</span>
            </div>
            <div>
              <span className="delta delta-flat">{m.unchanged}</span>
              <span className="movement-label">{t.unchanged}</span>
            </div>
          </div>
          <div className="movement-bar">
            <span
              className="movement-seg movement-up"
              style={{ width: `${(m.up / moved) * 100}%` }}
            />
            <span
              className="movement-seg movement-down"
              style={{ width: `${(m.down / moved) * 100}%` }}
            />
            <span
              className="movement-seg movement-flat"
              style={{ width: `${(m.unchanged / moved) * 100}%` }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
