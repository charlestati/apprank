// The three summary tiles above the chart: where we stand, how the ranks are
// spread, and which way they moved.
//
// Each tile names its own period and its own denominator. A tile that says
// "Ranked 41/129" and nothing else asks the reader to guess both. The period
// is stated in the tile's "?", not in a footnote under it: three footnotes
// were three more sentences between the reader and the numbers.

import type { Report } from "../api";
import { fmt, useT } from "../i18n";
import { TrendArrow } from "./delta";
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

// The spread of ranks drawn as a span on a 1-to-200 scale, the average a dot
// on it. Best and worst printed as two loose numbers beside the average left
// the tile half empty and asked the reader to picture where 57 sits between 1
// and 187; the span shows it.
const RANGE_FLOOR = 200;

function RankRange({
	average,
	best,
	worst,
}: {
	average: number | null;
	best: number | null;
	worst: number | null;
}) {
	const t = useT();
	const scale = Math.max(RANGE_FLOOR, worst ?? 0);
	const at = (rank: number) => ((rank - 1) / (scale - 1)) * 100;
	return (
		<div className="rank-range">
			{best !== null && worst !== null ? (
				<div aria-hidden="true" className="rank-range-track">
					<span
						className="rank-range-band"
						style={{ left: `${at(best)}%`, width: `${at(worst) - at(best)}%` }}
					/>
					{average === null ? null : (
						<span
							className="rank-range-dot"
							style={{ left: `${at(average)}%` }}
						/>
					)}
				</div>
			) : null}
			<dl className="rank-range-ends">
				<div>
					<dt>{t.best}</dt>
					<dd>{best ?? "—"}</dd>
				</div>
				<div>
					<dt>{t.worst}</dt>
					<dd>{worst ?? "—"}</dd>
				</div>
			</dl>
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
		fmt(count === 1 ? t.distributionBucketOne : t.distributionBucket, {
			count,
			label,
		});

	return (
		<div className="tiles summary-tiles">
			<section className="tile">
				<h2 className="tile-title">
					{t.averageRank}
					<InfoTip label={t.averageRank}>
						{fmt(t.helpAverageRank, { n: days })}
					</InfoTip>
				</h2>
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
							<TrendArrow up={stats.averageRankChange > 0} />
							{Math.abs(stats.averageRankChange)}
						</span>
					) : null}
					<dl className="stat-pair stat-aside">
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
				<RankRange
					average={stats.averageRank}
					best={stats.best}
					worst={stats.worst}
				/>
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
			</section>

			<section className="tile">
				<h2 className="tile-title">
					{t.keywordMovement}
					<InfoTip label={t.keywordMovement}>
						{fmt(t.helpMovement, { n: days })}
					</InfoTip>
				</h2>
				<div className="movement">
					<div className="movement-stats">
						<div>
							<span className="delta delta-up">
								<TrendArrow up /> {m.up}
							</span>
							<span className="movement-label">{t.wentUp}</span>
						</div>
						<div>
							<span className="delta delta-down">
								<TrendArrow up={false} /> {m.down}
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
