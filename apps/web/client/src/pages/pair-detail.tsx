import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";

import { api } from "../api";
import type { CompetitorPoint, HistoryPoint, TrackedApp } from "../api";
import { RankSeriesChart } from "../components/rank-series-chart";
import { useT } from "../i18n";

export function PairDetail({ app }: { app: TrackedApp | null }) {
  const t = useT();
  const { pairId } = useParams();
  const location = useLocation() as {
    state?: { keyword?: string; storefront?: string };
  };
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorPoint[]>([]);

  useEffect(() => {
    if (!(pairId && app)) {
      return;
    }
    (async () => {
      try {
        setHistory(await api.history(Number(pairId), app.id));
      } catch {
        setHistory([]);
      }
      try {
        setCompetitors(await api.competitors(Number(pairId)));
      } catch {
        setCompetitors([]);
      }
    })();
  }, [pairId, app]);

  // Latest observed top-10, plus presence count over the window: who owns this keyword.
  const board = useMemo(() => {
    const latestDate = competitors.at(-1)?.observed_date;
    if (!latestDate) {
      return [];
    }
    const latest = competitors.filter((c) => c.observed_date === latestDate);
    const daysSeen = new Map<number, number>();
    for (const c of competitors) {
      daysSeen.set(c.app_id, (daysSeen.get(c.app_id) ?? 0) + 1);
    }
    const totalDays = new Set(competitors.map((c) => c.observed_date)).size;
    return latest
      .toSorted((a, b) => a.position - b.position)
      .map((c) => ({
        ...c,
        presence: Math.round(((daysSeen.get(c.app_id) ?? 0) / totalDays) * 100),
      }));
  }, [competitors]);

  // One keyword, one storefront: the same chart the report uses, single-series.
  const series = useMemo(() => {
    if (!history) {
      return [];
    }
    return [
      {
        best: null,
        change: null,
        changeDaysAgo: null,
        difficulty: null,
        keyword: location.state?.keyword ?? `Pair ${pairId}`,
        keywordId: 0,
        pairId: Number(pairId),
        points: history.map((h) => ({
          date: h.observed_date,
          position: h.position,
        })),
        popularity: null,
        popularityStatus: "unqueried" as const,
        position: history.at(-1)?.position ?? null,
        resultCountChange: null,
        resultCount: history.at(-1)?.result_count ?? null,
        topResults: [],
        worst: null,
      },
    ];
  }, [history, location.state, pairId]);

  const dates = useMemo(
    () => (history ?? []).map((h) => h.observed_date),
    [history]
  );

  const label = location.state?.keyword
    ? `“${location.state.keyword}” · ${location.state.storefront?.toUpperCase()}`
    : `Pair ${pairId}`;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{label}</h1>
          <p className="page-sub">
            Rank of {app?.current_name ?? "the tracked app"} in the top 200,
            daily. Gaps are missing observations, not flat ranks.
          </p>
        </div>
      </header>
      <div className="card chart-card">
        {history === null ? (
          <p className="empty">{t.loading}</p>
        ) : (
          <RankSeriesChart
            colorOf={() => "var(--ds-chart-1)"}
            dates={dates}
            series={series}
          />
        )}
      </div>
      <section className="card table-card">
        <h2 className="section-title">{t.top10Today}</h2>
        <table className="grid">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>{t.app}</th>
              <th className="num" title={t.top10ShareTitle}>
                Top-10 presence
              </th>
            </tr>
          </thead>
          <tbody>
            {board.map((c) => (
              <tr
                className={c.app_id === app?.id ? "row-self" : undefined}
                key={c.app_id}
              >
                <td className="num">
                  <span className="rank rank-top">{c.position}</span>
                </td>
                <td>{c.current_name ?? c.app_id}</td>
                <td className="num subtle">{c.presence}%</td>
              </tr>
            ))}
            {board.length === 0 && (
              <tr>
                <td className="empty" colSpan={3}>
                  No competitor data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
