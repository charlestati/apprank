import { ArrowUp, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../api";
import type { KeywordRow, Report, StorefrontOption, TrackedApp } from "../api";
import { AppIcon } from "../components/app-icon";
import { Delta } from "../components/delta";
import { Difficulty } from "../components/difficulty";
import { InfoTip } from "../components/info-tip";
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
import {
	cached,
	chartKey,
	loadPreferences,
	savePreference,
	setCached,
} from "../preferences";

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

/** The band a popularity reading falls in, so a bare 40 reads as "Medium". */
function popularityBand(t: ReturnType<typeof useT>, value: number): string {
	const band = POPULARITY_BANDS.slice(1).find(
		(b) => value >= b.min && value <= b.max
	);
	return band ? t[band.key] : "";
}

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

/**
 * A stored selection, or null when there is nothing usable to restore.
 *
 * Null and empty are different answers: null means "never chosen", which lets
 * the chart fall back to the top four, while an empty array is a reader who
 * unticked everything and should get an empty chart back.
 */
function parseSelection(raw: string | null): number[] | null {
	if (raw === null) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((n) => typeof n === "number")
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** A selection stamped with the app-and-storefront key it belongs to. */
interface Keyed {
	key: string;
	ids: number[];
}

/**
 * Which keywords are drawn, and how a change to that is remembered.
 *
 * The selection is per app and per storefront, because a pair id names a
 * keyword in one storefront and means nothing in another.
 *
 * Three sources, in falling order of authority, resolved during render so the
 * selection is never *unknown* while the tick boxes are live. That window is
 * what made the first version wrong in both directions: a click landing in it
 * was computed from the default four and persisted them over a real stored
 * choice, and the value arriving a moment later then overwrote the click.
 *
 *   session  what the reader has done here, which always wins
 *   server   the stored row, the only copy that knows about another browser
 *   cache    localStorage, read synchronously so a reload draws the right lines
 *            on the first frame rather than the default four
 *
 * Both states carry their key, so a stale one stops matching when the app or
 * storefront changes. Clearing them in an effect instead would leave one render
 * where the previous selection still won.
 */
function useChartSelection(key: string | null): {
	effective: number[] | null;
	choose: (ids: number[]) => void;
} {
	const [session, setSession] = useState<Keyed | null>(null);
	const [server, setServer] = useState<Keyed | null>(null);
	const fromCache = useMemo(
		() => (key === null ? null : parseSelection(cached(key))),
		[key]
	);

	useEffect(() => {
		if (key === null) {
			return;
		}
		let live = true;
		(async () => {
			const prefs = await loadPreferences();
			const stored = parseSelection(prefs[key] ?? null);
			if (live && stored !== null) {
				setServer({ ids: stored, key });
				setCached(key, JSON.stringify(stored));
			}
		})();
		return () => {
			live = false;
		};
	}, [key]);

	const choose = useCallback(
		(ids: number[]) => {
			if (key !== null) {
				setSession({ ids, key });
				savePreference(key, JSON.stringify(ids));
			}
		},
		[key]
	);

	return {
		choose,
		effective:
			(session?.key === key ? session.ids : null) ??
			(server?.key === key ? server.ids : null) ??
			fromCache,
	};
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
	// Legend visibility, kept apart from membership above.
	const [hidden, setHidden] = useState<number[]>([]);
	const [resultsFor, setResultsFor] = useState<KeywordRow | null>(null);
	// The series the reader is pointing at, from either the chart or the table.
	// Everything else greys out: contrast is what carries the story, not eight
	// equally loud lines.
	const [focused, setFocused] = useState<number | null>(null);
	/** The release the reader is pointing at, by date; the other pins grey out. */
	const [focusedMarker, setFocusedMarker] = useState<string | null>(null);
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
			// A new report is a new set of pairs; carrying the old ids over would
			// hide a line the reader never touched.
			setHidden([]);
			setLoaded(true);
		})();
	}, [app, storefront, days]);

	const key = app && storefront ? chartKey(app.id, storefront) : null;
	const { effective, choose } = useChartSelection(key);

	// Membership and visibility are two different questions, which is why the
	// table's control says add/remove and the legend's says hide/show. Modelling
	// them as one made the legend chip delete itself: the list was built from the
	// drawn series, so hiding a line took away the only control that could bring
	// it back.
	const members = useMemo(() => {
		const rankedIds = (report?.rows ?? [])
			.filter((r) => r.position !== null)
			.slice(0, CHART_SERIES)
			.map((r) => r.pairId);
		const ids = new Set(effective ?? rankedIds);
		return (report?.rows ?? []).filter((r) => ids.has(r.pairId));
	}, [report, effective]);

	// The chart's palette runs out at four, so the table's tick boxes stop
	// offering a fifth rather than letting one be chosen and then dropped.
	const atCapacity = members.length >= CHART_SERIES;

	const chartSeries = useMemo(
		() => members.filter((r) => !hidden.includes(r.pairId)),
		[members, hidden]
	);

	/**
	 * Table control: puts a keyword on the chart, or takes it off entirely.
	 * The chart is capped, so a full chart refuses rather than quietly drawing a
	 * fifth line in a hue the reader cannot separate from the other four.
	 */
	const toggleMember = (pairId: number) => {
		// `effective`, not the session value alone: before the reader has touched
		// anything this session that is null, and falling back to the drawn
		// members would compute the new list from the default four and persist
		// those over whatever they had stored.
		const base = effective ?? members.map((r) => r.pairId);
		let next = base;
		if (base.includes(pairId)) {
			next = base.filter((id) => id !== pairId);
		} else if (base.length < CHART_SERIES) {
			next = [...base, pairId];
		}
		choose(next);
		// A keyword put back on the chart comes back visible, whatever the legend
		// last did with it.
		setHidden((current) => current.filter((id) => id !== pairId));
	};

	/** Legend control: hides a line without giving up its slot or its colour. */
	const toggleVisible = (pairId: number) => {
		setHidden((current) =>
			current.includes(pairId)
				? current.filter((id) => id !== pairId)
				: [...current, pairId]
		);
	};

	// Keyed to membership, not to what is drawn, so hiding one line does not
	// recolour the others under the reader.
	const styleIndex = useMemo(() => {
		const map = new Map<number, SeriesStyle>();
		for (const [i, row] of members.entries()) {
			map.set(row.pairId, SERIES_STYLES[i] ?? FALLBACK_STYLE);
		}
		return map;
	}, [members]);

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

					<SummaryTiles days={days} stats={report.stats} />

					<section className="card chart-card">
						<figure className="chart-figure">
							{/* Distinguished from "nothing was collected": the chart's own
                  empty state would tell a reader who just hid four lines
                  that the collector had not run. */}
							{members.length > 0 && chartSeries.length === 0 ? (
								<p className="empty">{t.allSeriesHidden}</p>
							) : (
								<RankSeriesChart
									describedBy="chart-caption"
									focusedPairId={focused}
									focusedMarker={focusedMarker}
									markers={report.metadataChanges}
									onFocus={setFocused}
									series={chartSeries}
									styleOf={(pairId) => styleIndex.get(pairId) ?? FALLBACK_STYLE}
									window={report.window}
								/>
							)}
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
							{members.map((row) => {
								const shown = !hidden.includes(row.pairId);
								return (
									<li key={row.pairId}>
										{/* Every member keeps its chip whether or not its line is
                      drawn. A hidden series that took its own control away
                      with it could only be recovered from the table. */}
										<button
											aria-label={
												shown
													? fmt(t.hideFromChart, { keyword: row.keyword })
													: fmt(t.showOnChart, { keyword: row.keyword })
											}
											aria-pressed={shown}
											className={
												(focused !== null && focused !== row.pairId) || !shown
													? "legend-chip legend-muted"
													: "legend-chip"
											}
											onBlur={() => setFocused(null)}
											onClick={() => toggleVisible(row.pairId)}
											onFocus={() => setFocused(row.pairId)}
											onMouseEnter={() => setFocused(row.pairId)}
											onMouseLeave={() => setFocused(null)}
											type="button"
										>
											{/* A hidden series keeps its slot but drops its colour, so
                          it is told apart from a chip merely dimmed because
                          the reader is pointing at another line. */}
											<SeriesGlyph
												muted={!shown}
												style={styleIndex.get(row.pairId) ?? null}
											/>
											{row.keyword}
										</button>
									</li>
								);
							})}
						</ul>
						<p className="legend-note">
							{fmt(t.chartCapacity, {
								max: CHART_SERIES,
								n: members.length,
							})}
							{members.length >= CHART_SERIES
								? ` · ${fmt(t.chartFull, { max: CHART_SERIES })}`
								: ""}
						</p>
						{report.metadataChanges.length > 0 ? (
							<ol className="marker-key">
								{report.metadataChanges.map((change, i) => (
									<li key={change.date}>
										{/* A button, like the series legend, so pointing at a
                        release greys the other pins and works from the keyboard
                        as well as the mouse. The same glyph and numeral as the
                        pin, which is what ties one to the other when several
                        releases fall close together. */}
										<button
											className={
												focusedMarker !== null && focusedMarker !== change.date
													? "marker-key-item marker-key-muted"
													: "marker-key-item"
											}
											onBlur={() => setFocusedMarker(null)}
											onFocus={() => setFocusedMarker(change.date)}
											onMouseEnter={() => setFocusedMarker(change.date)}
											onMouseLeave={() => setFocusedMarker(null)}
											type="button"
										>
											<Tag className="marker-key-icon" size={14} />
											<span className="marker-key-index">{i + 1}</span>
											<span>
												{f.day(change.date)}
												{change.version ? ` · ${change.version}` : ""}
												{change.changed.length > 0
													? ` · ${change.changed.join(", ")}`
													: ""}
											</span>
										</button>
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
									<col className="col-keyword" />
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
									{/* Every derived column carries its own explanation. The
                      header is where a reader asks what a number means, and
                      the answer used to live only in a rule file. */}
									<tr>
										<th scope="col">{t.keyword}</th>
										<th className="num" scope="col">
											{t.position}
											<InfoTip label={t.position}>{t.helpPosition}</InfoTip>
										</th>
										<th className="num" scope="col">
											{t.change}
											<InfoTip label={t.change}>{t.helpChange}</InfoTip>
										</th>
										<th scope="col">
											{t.popularity}
											<InfoTip label={t.popularity}>{t.helpPopularity}</InfoTip>
										</th>
										<th scope="col">
											{t.difficulty}
											<InfoTip label={t.difficulty}>{t.helpDifficulty}</InfoTip>
										</th>
										<th className="num" scope="col">
											{t.bestWorst}
											<InfoTip label={t.bestWorst}>{t.helpBestWorst}</InfoTip>
										</th>
										<th scope="col">
											{t.topResults}
											<InfoTip label={t.topResults}>{t.helpTopResults}</InfoTip>
										</th>
										<th className="num" scope="col">
											{t.total}
											<InfoTip label={t.total}>{t.helpTotalApps}</InfoTip>
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
												{/* A tick box, not a bare swatch: the row has to say
                            whether the keyword is on the chart before it is
                            clicked, and say so when the chart is full. The
                            title sits on the wrapper because a disabled
                            control explains nothing on hover. */}
												<span
													title={
														atCapacity && !styleIndex.has(row.pairId)
															? fmt(t.chartFull, { max: CHART_SERIES })
															: undefined
													}
												>
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
														disabled={atCapacity && !styleIndex.has(row.pairId)}
														onClick={() => toggleMember(row.pairId)}
														type="button"
													>
														<span aria-hidden="true" className="tick" />
														<SeriesGlyph
															style={styleIndex.get(row.pairId) ?? null}
														/>
													</button>
												</span>
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
												<Meter
													label={t.popularity}
													title={
														row.popularity === null
															? t.popularityNone
															: fmt(t.popularityTitle, {
																	band: popularityBand(t, row.popularity),
																	n: row.popularity,
																})
													}
													value={row.popularity}
												/>
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
														<ArrowUp aria-hidden="true" size={12} />
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
