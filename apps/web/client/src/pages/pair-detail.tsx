import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";

import { api } from "../api";
import type { CompetitorPoint, PairHistory, TrackedApp } from "../api";
import { RankSeriesChart } from "../components/rank-series-chart";
import { fmt, useT } from "../i18n";

// One line, so the dash ladder is unused: a solid stroke is the whole legend.
const SINGLE_SERIES = { color: "var(--ds-chart-1)", dash: "" };
const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;

/** The server's window for `days`, in the UTC dates observations carry. */
function requestedWindow(days: number): { from: string; to: string } {
	const now = Date.now();
	return {
		from: new Date(now - days * DAY_MS).toISOString().slice(0, 10),
		to: new Date(now).toISOString().slice(0, 10),
	};
}

/**
 * An answer read back only while it is the one asked for. `failed` is "it
 * answered, with nothing": a request still in flight is neither.
 */
function settled<T>(
	held: { key: string; value: T | null } | null,
	key: string | null
): { value: T | null; failed: boolean } {
	if (held === null || held.key !== key) {
		return { failed: false, value: null };
	}
	return { failed: held.value === null, value: held.value };
}

export function PairDetail({ app }: { app: TrackedApp | null }) {
	const t = useT();
	const { pairId } = useParams();
	const location = useLocation() as {
		state?: { keyword?: string; storefront?: string };
	};
	// Both stamped with the pair and app they answer, so navigating to another
	// pair shows the loading state instead of the previous pair's line, and a
	// slow answer for the previous pair cannot land over the current one.
	// A failed request is held as null, not as an empty history: the chart's
	// empty state says "the collector fills this in daily", which is a claim
	// about the data and not something a 500 or a 404 can support.
	const [fetched, setFetched] = useState<{
		key: string;
		value: PairHistory | null;
	} | null>(null);
	const [rivals, setRivals] = useState<{
		key: string;
		value: CompetitorPoint[] | null;
	} | null>(null);
	const appId = app?.id ?? null;
	const key = pairId && appId !== null ? `${pairId}|${appId}` : null;

	useEffect(() => {
		if (!pairId || appId === null || key === null) {
			return;
		}
		let live = true;
		(async () => {
			let next: PairHistory | null = null;
			try {
				next = await api.history(Number(pairId), appId, HISTORY_DAYS);
			} catch {
				// Shown as a failure, below.
			}
			if (!live) {
				return;
			}
			setFetched({ key, value: next });
			let points: CompetitorPoint[] | null = null;
			try {
				points = await api.competitors(Number(pairId));
			} catch {
				// Shown as a failure, below.
			}
			if (live) {
				setRivals({ key, value: points });
			}
		})();
		return () => {
			live = false;
		};
	}, [pairId, appId, key]);

	const { value: history, failed: historyFailed } = settled(fetched, key);
	const { value: rivalPoints, failed: rivalsFailed } = settled(rivals, key);
	const competitors = useMemo(() => rivalPoints ?? [], [rivalPoints]);
	// The requested window, so the days since the last observation stay on the
	// axis as a gap rather than the line simply ending. The server's own answer
	// when it sends one; otherwise the same arithmetic it applies to `days`.
	// Nothing to draw keeps the chart's empty state, rather than ninety empty
	// slots.
	const span = useMemo(() => {
		if (
			!history ||
			(history.points.length === 0 && history.fetchErrors.length === 0)
		) {
			return null;
		}
		return history.window ?? requestedWindow(HISTORY_DAYS);
	}, [history]);

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
				keyword:
					location.state?.keyword ?? fmt(t.pairFallback, { id: pairId ?? "" }),
				keywordId: 0,
				pairId: Number(pairId),
				points: history.points.map((h) => ({
					date: h.observed_date,
					position: h.position,
				})),
				// Kept apart from never-collected days: a failed fetch is a hatched
				// mark, not a gap a reader could take for a quiet day.
				fetchErrors: history.fetchErrors,
				popularity: null,
				popularityStatus: "unqueried" as const,
				position: history.points.at(-1)?.position ?? null,
				resultCountChange: null,
				resultCount: history.points.at(-1)?.result_count ?? null,
				topResults: [],
				worst: null,
			},
		];
	}, [history, location.state, pairId, t.pairFallback]);

	const label = location.state?.keyword
		? `“${location.state.keyword}” · ${location.state.storefront?.toUpperCase()}`
		: fmt(t.pairFallback, { id: pairId ?? "" });

	return (
		<>
			<header className="page-header">
				<div>
					<h1>{label}</h1>
					<p className="page-sub">
						{fmt(t.pairDetailSub, {
							app: app?.current_name ?? t.theTrackedApp,
						})}
					</p>
				</div>
			</header>
			<div className="card chart-card">
				{history === null ? (
					<p className="empty">{historyFailed ? t.loadFailed : t.loading}</p>
				) : (
					<RankSeriesChart
						series={series}
						styleOf={() => SINGLE_SERIES}
						window={span}
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
								{t.top10Presence}
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
									{rivalsFailed ? t.loadFailed : t.noCompetitorData}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</section>
		</>
	);
}
