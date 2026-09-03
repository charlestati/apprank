// The three summary tiles above the chart: where we stand, how the ranks are
// spread, and which way they moved.
//
// Each tile names its own period and its own denominator. A tile that says
// "Ranked 41/129" and nothing else asks the reader to guess both.

import { ArrowDown, ArrowUp } from "lucide-react";

import type { Report } from "../api";
import { fmt, useT } from "../i18n";
import { InfoTip } from "./info-tip";

function DistributionBar({
	count,
	label,
	max,
	title,
}: {
	count: number;
	label: string;
	max: number;
	title: string;
}) {
	const height = max === 0 ? 0 : Math.round((count / max) * 100);
	return (
		<div className="dist-col" title={title}>
			<div className="dist-count">{count}</div>
			{/* The bar's percentage needs a box of its own to be a percentage of.
			    Sized against the column, it competed with the count and the label
			    for the same 84px and every bucket shrank to the same stub. */}
			<div className="dist-track">
				<div
					className="dist-bar"
					style={{ height: `${Math.max(height, 4)}%` }}
				/>
			</div>
			<div className="dist-label">{label}</div>
		</div>
	);
}

export function SummaryTiles({
	stats,
	days,
}: {
	stats: Report["stats"];
	days: number;
}) {
	const t = useT();
	const { distribution: d, movement: m } = stats;
	const maxBucket = Math.max(d.top5, d.top25, d.top100, d.beyond, 1);
	const moved = m.up + m.down + m.unchanged || 1;
	const bucketTitle = (label: string, count: number) =>
		fmt(t.distributionBucket, { count, label });

	return (
		<div className="tiles">
			<section className="tile">
				<h2 className="tile-title">
					{t.averageRank}
					<InfoTip label={t.averageRank}>{t.helpAverageRank}</InfoTip>
				</h2>
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
									{stats.averageRankChange > 0 ? (
										<ArrowUp aria-hidden="true" size={12} />
									) : (
										<ArrowDown aria-hidden="true" size={12} />
									)}
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
								{fmt(t.rankedOf, {
									n: stats.rankedKeywords,
									total: stats.trackedKeywords,
								})}
							</dd>
						</div>
					</dl>
				</div>
				<p className="tile-note">{fmt(t.averageRankNote, { n: days })}</p>
			</section>

			<section className="tile">
				<h2 className="tile-title">
					{t.rankDistribution}
					<InfoTip label={t.rankDistribution}>{t.helpDistribution}</InfoTip>
				</h2>
				<div className="dist">
					<DistributionBar
						count={d.top5}
						label={t.top5}
						max={maxBucket}
						title={bucketTitle(t.top5, d.top5)}
					/>
					<DistributionBar
						count={d.top25}
						label={t.top25}
						max={maxBucket}
						title={bucketTitle(t.top25, d.top25)}
					/>
					<DistributionBar
						count={d.top100}
						label={t.top100}
						max={maxBucket}
						title={bucketTitle(t.top100, d.top100)}
					/>
					<DistributionBar
						count={d.beyond}
						label={t.beyond100}
						max={maxBucket}
						title={bucketTitle(t.beyond100, d.beyond)}
					/>
				</div>
				<p className="tile-note">{t.distributionNote}</p>
			</section>

			<section className="tile">
				<h2 className="tile-title">
					{t.keywordMovement}
					<InfoTip label={t.keywordMovement}>{t.helpMovement}</InfoTip>
				</h2>
				<div className="movement">
					<div className="movement-stats">
						<div>
							<span className="delta delta-up">
								<ArrowUp aria-hidden="true" size={12} /> {m.up}
							</span>
							<span className="movement-label">{t.wentUp}</span>
						</div>
						<div>
							<span className="delta delta-down">
								<ArrowDown aria-hidden="true" size={12} /> {m.down}
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
				<p className="tile-note">{fmt(t.movementPeriod, { n: days })}</p>
			</section>
		</div>
	);
}
