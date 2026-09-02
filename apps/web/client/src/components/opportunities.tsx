// The answer to "what should I do at the next release?", above the table that
// justifies it.
//
// Two ideas drive this panel. First, an average rank across a portfolio of
// keywords is a vanity number. What matters is how many terms sit in the zone
// that earns taps at all. Second, brand searches are demand you already own,
// so counting them alongside generic wins flatters the picture; ASO progress
// is the generic column.

import type { KeywordRow, Report } from "../api";
import { fmt, plural, useT } from "../i18n";
import type { Dictionary } from "../i18n";

// No lane carries a colour. The label already says which lane it is, so a
// tinted panel behind a coloured rule was decoration standing in for a
// distinction the words had already made.
const lanesFor = (t: Dictionary) =>
	[
		{ hint: t.laneWinningHint, key: "winning", label: t.laneWinning },
		{ hint: t.laneCloseHint, key: "close", label: t.laneClose },
		{ hint: t.laneBlockedHint, key: "blocked", label: t.laneBlocked },
		{ hint: t.laneVanityHint, key: "vanity", label: t.laneVanity },
		{ hint: t.laneUnknownHint, key: "unknown", label: t.laneUnknown },
	] as const;

function pickExamples(rows: KeywordRow[], key: string): KeywordRow[] {
	return rows.filter((r) => r.verdict?.opportunity === key).slice(0, 3);
}

export function Opportunities({
	report,
	onSelect,
}: {
	report: Report;
	onSelect: (row: KeywordRow) => void;
}) {
	const t = useT();
	const lanes = lanesFor(t);
	const { insights, rows } = report;
	const counts: Record<string, number> = {
		blocked: insights.blocked,
		close: insights.close,
		unknown: insights.unknown,
		vanity: insights.vanity,
		winning: insights.winning,
	};
	return (
		<section className="card insights">
			<header className="insights-head">
				<h2 className="section-title">{t.whatToWorkOn}</h2>
				{/* One line of counts. The reasoning behind them, why brand terms sit
            apart and why an absent volume is not a zero, is written down once
            in the dashboard rule; repeating it on every visit was fifty words
            of justification above the five numbers that carry it. */}
				<p className="insights-sub">
					{fmt(t.genericProgress, {
						inZone: insights.genericInTapZone,
						total: insights.genericKeywords,
					})}{" "}
					{insights.brandKeywords > 0
						? `${plural(t, insights.brandKeywords, "brandCountedOne", "brandCounted")} `
						: null}
					{insights.unmeasuredKeywords > 0
						? fmt(t.coverageNote, {
								n: insights.unmeasuredKeywords,
								total: insights.brandKeywords + insights.genericKeywords,
							})
						: null}
				</p>
			</header>

			<div className="lanes">
				{lanes.map((lane) => (
					<div className="lane" key={lane.key}>
						<h3 className="lane-head">
							<span className="lane-count">{counts[lane.key] ?? 0}</span>
							<span className="lane-label">{lane.label}</span>
						</h3>
						<p className="lane-hint">{lane.hint}</p>
						<ul className="lane-examples">
							{pickExamples(rows, lane.key).map((row) => (
								<li key={row.pairId}>
									<button
										className="link"
										onClick={() => onSelect(row)}
										type="button"
									>
										{row.keyword}
									</button>
									<span className="lane-rank">
										{row.position === null ? "—" : `#${row.position}`}
										{row.popularity === null
											? ""
											: fmt(t.opportunityPop, { n: row.popularity })}
									</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}
