// The answer to "what should I do at the next release?", above the table that
// justifies it.
//
// Two ideas drive this panel. First, an average rank across a portfolio of
// keywords is a vanity number. What matters is how many terms sit in the zone
// that earns taps at all. Second, brand searches are demand you already own,
// so counting them alongside generic wins flatters the picture; ASO progress
// is the generic column.

import {
	CircleHelp,
	Ghost,
	Hourglass,
	Lock,
	SearchX,
	Tag,
	Target,
	Trophy,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { KeywordRow, Report } from "../api";
import { fmt, plural, useT } from "../i18n";
import type { Dictionary } from "../i18n";
import { Hint, InfoTip } from "./info-tip";

// No lane carries a colour. The label already says which lane it is, so a
// tinted panel behind a coloured rule was decoration standing in for a
// distinction the words had already made. Each lane has a shape instead, so
// the five columns are told apart at a glance and the sentence that defines a
// lane waits behind its "?" rather than being read five times a visit.
const lanesFor = (t: Dictionary) =>
	[
		{
			hint: t.laneWinningHint,
			icon: Trophy,
			key: "winning",
			label: t.laneWinning,
		},
		{ hint: t.laneCloseHint, icon: Target, key: "close", label: t.laneClose },
		{
			hint: t.laneBlockedHint,
			icon: Lock,
			key: "blocked",
			label: t.laneBlocked,
		},
		{ hint: t.laneVanityHint, icon: Ghost, key: "vanity", label: t.laneVanity },
		{
			hint: t.laneUnknownHint,
			icon: CircleHelp,
			key: "unknown",
			label: t.laneUnknown,
		},
	] as const;

/**
 * A caveat as a chip: an icon and a count, with the sentence that qualifies
 * the headline one hover, tap or Enter away. The visible text is the trigger's
 * name too, so what a voice user reads is what they can say.
 */
function NoteChip({
	icon: Icon,
	label,
	children,
}: {
	icon: LucideIcon;
	label: string;
	children: string;
}): ReactNode {
	return (
		<li>
			<Hint
				className="note-chip"
				label={label}
				mark={
					<>
						<Icon size={14} />
						{label}
					</>
				}
			>
				{children}
			</Hint>
		</li>
	);
}

// Brand terms are excluded here for the same reason they are excluded from the
// counts: a lane that reads 15 while listing three brand keywords under it is
// describing two different sets.
function pickExamples(rows: KeywordRow[], key: string): KeywordRow[] {
	// Nor a keyword with no observation in the window: it has no rank to put
	// in a lane, whatever lane its verdict names.
	return rows
		.filter(
			(r) => !r.brand && r.points.length > 0 && r.verdict?.opportunity === key
		)
		.slice(0, 3);
}

type Lane = ReturnType<typeof lanesFor>[number];

function LaneHead({ lane, count }: { lane: Lane; count: number }) {
	const Icon = lane.icon;
	return (
		<h3 className="lane-head">
			<Icon aria-hidden="true" className="lane-icon" size={18} />
			<span className="lane-count">{count}</span>
			{/* The "?" inside the label, so a label that wraps keeps it beside its
			    last word rather than parked at the far edge. */}
			<span className="lane-label">
				{lane.label}
				<InfoTip label={lane.label}>{lane.hint}</InfoTip>
			</span>
		</h3>
	);
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
	const filled = lanes.filter((lane) => (counts[lane.key] ?? 0) > 0);
	const empty = lanes.filter((lane) => (counts[lane.key] ?? 0) === 0);
	return (
		<section className="card insights">
			<header className="insights-head">
				<h2 className="section-title">{t.whatToWorkOn}</h2>
				{/* The headline first, in a sentence, then the caveats that qualify
				    it as chips. Run together in one paragraph, the three read as a
				    single statistic nobody could parse; as bullets, they were two
				    more paragraphs to read before the lanes. */}
				<p className="insights-lede">
					{fmt(t.genericProgress, {
						inZone: insights.genericInTapZone,
						total: insights.genericKeywords,
					})}
				</p>
				{insights.brandKeywords > 0 ||
				insights.unmeasuredKeywords > 0 ||
				insights.unqueriedKeywords > 0 ? (
					<ul className="note-chips">
						{insights.brandKeywords > 0 ? (
							<NoteChip
								icon={Tag}
								label={plural(
									t,
									insights.brandKeywords,
									"brandChipOne",
									"brandChip"
								)}
							>
								{plural(
									t,
									insights.brandKeywords,
									"brandCountedOne",
									"brandCounted"
								)}
							</NoteChip>
						) : null}
						{insights.unmeasuredKeywords > 0 ? (
							<NoteChip
								icon={SearchX}
								label={fmt(t.noVolumeChip, {
									n: insights.unmeasuredKeywords,
								})}
							>
								{fmt(t.coverageNote, {
									n: insights.unmeasuredKeywords,
									total: insights.brandKeywords + insights.genericKeywords,
								})}
							</NoteChip>
						) : null}
						{/* Two separate notes on purpose. Merging them under one count
						    reported a gap in our own collection as a fact about Apple's
						    data. */}
						{insights.unqueriedKeywords > 0 ? (
							<NoteChip
								icon={Hourglass}
								label={fmt(t.pendingVolumeChip, {
									n: insights.unqueriedKeywords,
								})}
							>
								{fmt(t.coveragePending, {
									n: insights.unqueriedKeywords,
									total: insights.brandKeywords + insights.genericKeywords,
								})}
							</NoteChip>
						) : null}
					</ul>
				) : null}
			</header>

			{filled.length > 0 ? (
				<div className="lanes">
					{filled.map((lane) => (
						<div className="lane" key={lane.key}>
							<LaneHead count={counts[lane.key] ?? 0} lane={lane} />
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
			) : null}
			{/* Empty lanes fold into one slim row under the others. As full
			    columns they were boxes with nothing in them; dropped, "nothing is
			    winning" would go unsaid, and that is an answer too. */}
			{empty.length > 0 ? (
				<div className="lanes-empty">
					{empty.map((lane) => (
						<div className="lane lane-empty" key={lane.key}>
							<LaneHead count={0} lane={lane} />
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}
