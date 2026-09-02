import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../api";
import type { KeywordRow, Report, StorefrontOption, TrackedApp } from "../api";
import { AppIcon } from "../components/app-icon";
import { Delta } from "../components/delta";
import { Difficulty } from "../components/difficulty";
import { Meter } from "../components/meter";
import { Opportunities } from "../components/opportunities";
import { RankSeriesChart } from "../components/rank-series-chart";
import type { SeriesStyle } from "../components/rank-series-chart";
import { ResultsDrawer } from "../components/results-drawer";
import { Segmented } from "../components/segmented";
import { Select } from "../components/select";
import { SeriesGlyph } from "../components/series-glyph";
import { SummaryTiles } from "../components/summary-tiles";
import { useFormat } from "../format";
import { fmt, plural, reasonText, useT } from "../i18n";

// Bands carry a dictionary key, not prose: the numbers are the identity, the
// wording is presentation.
const POPULARITY_BANDS = [
	{ key: "anyPopularity", max: 100, min: 0 },
	{ key: "bandVeryHigh", max: 100, min: 85 },
	{ key: "bandHigh", max: 84, min: 60 },
	{ key: "bandMedium", max: 59, min: 20 },
	{ key: "bandLow", max: 19, min: 10 },
	{ key: "bandVeryLow", max: 9, min: 0 },
] as const;

const RANGES = [{ days: 7 }, { days: 30 }, { days: 90, label: "90 days" }];
// Four lines is the readable ceiling for a categorical palette; beyond it the
// hues stop surviving a colour-vision check side by side. The table's toggles
// still allow more, because then the reader picked them.
const CHART_SERIES = 4;
// Enough of the leaderboard to see who owns the keyword, without wrapping the
// row onto a second line.
const TOP_RESULTS_SHOWN = 3;
// Atlassian's categorical chart slots, assigned in a fixed order and never
// cycled. Slots 5 and 6 are deliberately skipped: they are the darker pairs of
// 1 and 3, and sit too close to them on the dark surface to tell apart.
//
// Each slot carries a dash pattern as well as a hue. Colour is never the only
// thing separating two lines, the same rule the status pills follow, and the
// reason the chart stays readable printed in grey.
const SERIES_STYLES: SeriesStyle[] = [
	{ color: "var(--ds-chart-1)", dash: "" },
	{ color: "var(--ds-chart-2)", dash: "7 3" },
	{ color: "var(--ds-chart-3)", dash: "2 3" },
	{ color: "var(--ds-chart-4)", dash: "11 4" },
	{ color: "var(--ds-chart-7)", dash: "7 3 2 3" },
	{ color: "var(--ds-chart-8)", dash: "1 4" },
];
const FALLBACK_STYLE: SeriesStyle = { color: "var(--ds-chart-1)", dash: "" };

function rankBand(position: number | null): string {
	if (position === null) {
		return "rank rank-none";
	}
	if (position <= 10) {
		return "rank rank-top";
	}
	if (position <= 50) {
		return "rank rank-mid";
	}
	return "rank rank-low";
}

export function KeywordPerformance({ app }: { app: TrackedApp | null }) {
	const f = useFormat();
	const t = useT();
	const [storefronts, setStorefronts] = useState<StorefrontOption[]>([]);
	const [storefront, setStorefront] = useState("");
	const [days, setDays] = useState(30);
	const [report, setReport] = useState<Report | null>(null);
	const [filter, setFilter] = useState("");
	const [band, setBand] = useState(0);
	const [selected, setSelected] = useState<number[] | null>(null);
	const [resultsFor, setResultsFor] = useState<KeywordRow | null>(null);
	// The series the reader is pointing at, from either the chart or the table.
	// Everything else greys out: contrast is what carries the story, not eight
	// equally loud lines.
	const [focused, setFocused] = useState<number | null>(null);
	const [loaded, setLoaded] = useState(false);
	const navigate = useNavigate();

	useEffect(() => {
		if (!app) {
			return;
		}
		(async () => {
			try {
				const options = await api.storefronts(app.id);
				setStorefronts(options);
				setStorefront((current) => current || (options[0]?.code ?? ""));
			} catch {
				setStorefronts([]);
			}
		})();
	}, [app]);

	useEffect(() => {
		if (!(app && storefront)) {
			return;
		}
		(async () => {
			// `loaded` distinguishes "still fetching" from "fetched and empty", so a
			// failed request shows the empty state rather than a permanent spinner.
			try {
				setReport(await api.report(app.id, storefront, days));
			} catch {
				setReport(null);
			}
			setLoaded(true);
		})();
	}, [app, storefront, days]);

	const chartSeries = useMemo(() => {
		const ranked = (report?.rows ?? []).filter((r) => r.position !== null);
		if (selected === null) {
			return ranked.slice(0, CHART_SERIES);
		}
		return (report?.rows ?? []).filter((r) => selected.includes(r.pairId));
	}, [report, selected]);

	const toggleSeries = (pairId: number) => {
		setSelected((current) => {
			const base =
				current ??
				(report?.rows ?? [])
					.filter((r) => r.position !== null)
					.slice(0, CHART_SERIES)
					.map((r) => r.pairId);
			return base.includes(pairId)
				? base.filter((id) => id !== pairId)
				: [...base, pairId];
		});
	};

	const styleIndex = useMemo(() => {
		const map = new Map<number, SeriesStyle>();
		for (const [i, row] of chartSeries.entries()) {
			map.set(row.pairId, SERIES_STYLES[i] ?? FALLBACK_STYLE);
		}
		return map;
	}, [chartSeries]);

	const rows = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const range = POPULARITY_BANDS[band] ?? POPULARITY_BANDS[0];
		return (report?.rows ?? []).filter((r) => {
			if (needle && !r.keyword.toLowerCase().includes(needle)) {
				return false;
			}
			if (band === 0) {
				return true;
			}
			// A keyword with no popularity reading cannot be placed in a band.
			return (
				r.popularity !== null &&
				r.popularity >= (range?.min ?? 0) &&
				r.popularity <= (range?.max ?? 100)
			);
		});
	}, [report, filter, band]);

	if (!app) {
		return <p className="empty">{t.noAppTracked}</p>;
	}

	return (
		<>
			<header className="page-header">
				<div>
					<h1>{t.keywordPerformance}</h1>
					<p className="page-sub">
						{fmt(t.pageSub, { app: app.current_name ?? "" })}
					</p>
				</div>
			</header>

			<div className="filter-bar">
				<div className="field">
					<Select
						label={t.storefront}
						onValueChange={setStorefront}
						options={storefronts.map((s) => ({
							label: `${f.region(s.code, s.name)} (${f.number(s.keywords)})`,
							value: s.code,
						}))}
						value={storefront}
					/>
				</div>

				<div className="field">
					<span className="field-label">{t.timePeriod}</span>
					<Segmented
						label={t.timePeriod}
						onValueChange={(next) => setDays(Number(next))}
						options={RANGES.map((r) => ({
							label: fmt(t.rangeDays, { n: r.days }),
							value: String(r.days),
						}))}
						value={String(days)}
					/>
				</div>
			</div>

			{loaded || report ? null : <p className="empty">{t.loading}</p>}
			{loaded && !report ? <p className="empty">{t.reportFailed}</p> : null}

			{report ? (
				<>
					<Opportunities onSelect={setResultsFor} report={report} />

					<SummaryTiles stats={report.stats} />

					<section className="card chart-card">
						<figure className="chart-figure">
							<RankSeriesChart
								describedBy="chart-caption"
								focusedPairId={focused}
								markers={report.metadataChanges}
								onFocus={setFocused}
								series={chartSeries}
								styleOf={(pairId) => styleIndex.get(pairId) ?? FALLBACK_STYLE}
								window={report.window}
							/>
							{/* The prose alternative the graphic points at, and the pointer
                  to the table that carries the numbers themselves. It is not
                  drawn: a sighted reader already has the subject in the page
                  heading, the window on the x axis, rank 1 at the top of the
                  y axis, and both rails labelled where they sit, so on screen
                  the paragraph restated the chart at sixty words. A reader
                  who cannot see any of that still needs every one of them. */}
							<figcaption className="sr-only" id="chart-caption">
								{fmt(t.chartCaption, {
									app: app.current_name ?? "",
									from: report.window.from,
									n: chartSeries.length,
									to: report.window.to,
								})}
							</figcaption>
						</figure>
						<ul className="legend">
							{chartSeries.map((row) => (
								<li key={row.pairId}>
									{/* The chip is the same control as the table's toggle, so
                      pointing at it to highlight a line is an interaction on
                      something that was already interactive. */}
									<button
										aria-label={fmt(t.hideFromChart, { keyword: row.keyword })}
										className={
											focused !== null && focused !== row.pairId
												? "legend-chip legend-muted"
												: "legend-chip"
										}
										onBlur={() => setFocused(null)}
										onClick={() => toggleSeries(row.pairId)}
										onFocus={() => setFocused(row.pairId)}
										onMouseEnter={() => setFocused(row.pairId)}
										onMouseLeave={() => setFocused(null)}
										type="button"
									>
										<SeriesGlyph style={styleIndex.get(row.pairId) ?? null} />
										{row.keyword}
									</button>
								</li>
							))}
						</ul>
						{report.metadataChanges.length > 0 ? (
							<ol className="marker-key">
								{report.metadataChanges.map((change, i) => (
									<li key={change.date}>
										<span className="marker-key-index">{i + 1}</span>
										<span>
											{f.day(change.date)}
											{change.version ? ` · ${change.version}` : ""}
											{change.changed.length > 0
												? ` · ${change.changed.join(", ")}`
												: ""}
										</span>
									</li>
								))}
							</ol>
						) : null}
					</section>

					<section className="card table-card">
						<div className="table-toolbar">
							<input
								aria-label={t.filterKeywords}
								className="search"
								onChange={(e) => setFilter(e.target.value)}
								placeholder={fmt(t.filterNKeywords, { n: report.rows.length })}
								type="search"
								value={filter}
							/>
							<Select
								hiddenLabel
								label={t.filterByPopularity}
								onValueChange={setBand}
								options={POPULARITY_BANDS.map((b, i) => ({
									label: t[b.key],
									value: i,
								}))}
								value={band}
							/>
							<span className="spacer" />
							<span className="toolbar-meta">
								{fmt(t.nOfMShown, {
									n: rows.length,
									total: report.rows.length,
								})}{" "}
								·{" "}
								{plural(t, report.dates.length, "dayObserved", "daysObserved")}
							</span>
							<a
								className="button"
								download
								href={api.reportCsvUrl(app.id, report.storefront, days)}
							>
								{t.export}
							</a>
						</div>

						<div className="table-scroll">
							<table className="report grid">
								{/* The ration the fixed layout hands out. Only the keyword
                    column is left unsized, so every spare pixel goes to the
                    one cell whose content is unbounded. */}
								<colgroup>
									<col />
									<col className="col-position" />
									<col className="col-change" />
									<col className="col-meter" />
									<col className="col-meter" />
									<col className="col-range" />
									<col className="col-results" />
									<col className="col-total" />
								</colgroup>
								<thead>
									<tr className="group-row">
										<th aria-label={t.keyword} />
										<th colSpan={2}>{t.searchRank}</th>
										<th colSpan={3}>{t.keywordInsights}</th>
										<th colSpan={2}>{t.searchResults}</th>
									</tr>
									<tr>
										<th scope="col">{t.keyword}</th>
										<th className="num" scope="col">
											{t.position}
										</th>
										<th className="num" scope="col">
											{t.change}
										</th>
										<th scope="col">{t.popularity}</th>
										<th scope="col">{t.difficulty}</th>
										<th className="num" scope="col">
											{t.bestWorst}
										</th>
										<th scope="col">{t.topResults}</th>
										<th className="num" scope="col">
											{t.total}
										</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((row: KeywordRow) => (
										<tr
											className={
												focused === row.pairId ? "row-focused" : undefined
											}
											key={row.pairId}
											onFocus={() => setFocused(row.pairId)}
											onMouseEnter={() => setFocused(row.pairId)}
											onMouseLeave={() => setFocused(null)}
										>
											<td className="kw">
												<button
													aria-label={
														styleIndex.has(row.pairId)
															? fmt(t.removeFromChart, {
																	keyword: row.keyword,
																})
															: fmt(t.addToChart, { keyword: row.keyword })
													}
													aria-pressed={styleIndex.has(row.pairId)}
													className="swatch-button"
													onClick={() => toggleSeries(row.pairId)}
													type="button"
												>
													<SeriesGlyph
														style={styleIndex.get(row.pairId) ?? null}
													/>
												</button>
												<button
													className="link"
													onClick={() =>
														navigate(`/pairs/${row.pairId}`, {
															state: {
																keyword: row.keyword,
																storefront: report.storefront,
															},
														})
													}
													type="button"
												>
													{row.keyword}
												</button>
											</td>
											<td className="num">
												<span className="rank-cell">
													<span
														className={rankBand(row.position)}
														title={
															row.verdict
																? reasonText(
																		t,
																		row.verdict.reasonKey,
																		row.verdict.reason
																	)
																: undefined
														}
													>
														{row.position ?? "—"}
													</span>
													{row.verdict?.unproven ? (
														<sup className="unproven" title={t.unprovenTitle}>
															~
														</sup>
													) : null}
												</span>
											</td>
											<td className="num">
												<Delta
													change={row.change}
													daysAgo={row.changeDaysAgo}
												/>
											</td>
											<td>
												<Meter label={t.popularity} value={row.popularity} />
											</td>
											<td>
												<Difficulty value={row.difficulty} />
											</td>
											<td className="num subtle">
												{row.best ?? "—"} / {row.worst ?? "—"}
											</td>
											<td>
												<div className="results">
													{row.topResults.length === 0 ? (
														<span className="subtle">—</span>
													) : (
														row.topResults
															.slice(0, TOP_RESULTS_SHOWN)
															.map((r) => (
																<span
																	className="result-app"
																	key={r.appId}
																	title={`${r.position}. ${r.name}`}
																>
																	<AppIcon iconUrl={r.iconUrl} name={r.name} />
																</span>
															))
													)}
													{row.resultCount ? (
														<button
															className="link results-link"
															onClick={() => setResultsFor(row)}
															type="button"
														>
															{t.view}
														</button>
													) : null}
												</div>
											</td>
											<td className="num subtle">
												{row.resultCount ?? "—"}
												{row.resultCountChange && row.resultCountChange > 20 ? (
													<span
														className="contested"
														title={fmt(t.contestedTitle, {
															n: row.resultCountChange,
														})}
													>
														↑
													</span>
												) : null}
											</td>
										</tr>
									))}
									{rows.length === 0 ? (
										<tr>
											<td className="empty" colSpan={8}>
												{fmt(t.noKeywordMatch, { filter })}
											</td>
										</tr>
									) : null}
								</tbody>
							</table>
						</div>
					</section>

					{resultsFor ? (
						<ResultsDrawer
							onClose={() => setResultsFor(null)}
							row={resultsFor}
							storefront={report.storefront}
							trackedAppId={app.id}
						/>
					) : null}
				</>
			) : null}
		</>
	);
}
