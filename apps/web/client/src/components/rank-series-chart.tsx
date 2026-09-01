// Multi-series rank history on a calendar axis: y inverted (rank 1 at the
// top),
// one line per keyword, and four states kept visually distinct: ranked, ranked
// outside the top 200, never collected, and collected and failed.
//
// The axis is one slot per calendar day, not one slot per observed day. Pairs
// sit on a stretched cadence rung (1, 2, 3 or 7 days), so packing observations
// side by side drew a six-day step at the same width as an overnight one:
// every
// slope across a stretched stretch was wrong, and the gap the cadence created
// disappeared exactly where it had to be visible.

/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-tabindex --
   role="img" is the correct semantic for an inline SVG graphic (an <img> tag
   cannot hold one), and the pointer and key handlers drive the same crosshair
   over an already aria-labelled graphic: the arrow keys exist precisely so the
   readout is not mouse-only. The graphic is deliberately in the tab order for
   the same reason: a value a sighted mouse user can read has to be reachable
   without a mouse, and there is no interactive element to hang that on. */

import { useId, useMemo, useState } from "react";

import type { KeywordRow, MetadataMarker } from "../api";
import { useFormat } from "../format";
import { fmt, useT } from "../i18n";
import type { Dictionary } from "../i18n";

const W = 960;
const H = 360;
// The right pad holds the direct labels: a reader should not have to travel to
// a legend to name a line.
const PAD = { bottom: 26, left: 46, right: 132, top: 16 };
// Rails below the plot floor, in viewBox units: one for observations that
// landed outside the top 200, one for days the fetch failed.
const RAIL_UNRANKED = 20;
const RAIL_ERROR = 38;
const PLOT_BOTTOM = H - PAD.bottom - 46;
const DAY_MS = 86_400_000;
const READOUT_LIMIT = 8;
/** Label line-height plus a little air, in viewBox units. */
const MIN_TICK_GAP = 18;
const MIN_LABEL_GAP = 13;
const LABEL_MAX_CHARS = 16;
const GRID_CANDIDATES = [1, 5, 10, 25, 50, 100, 150, 200];

/** A stable empty default: an inline [] would be a new reference every render. */
const NO_MARKERS: MetadataMarker[] = [];

export interface SeriesStyle {
	color: string;
	/** SVG dash pattern; "" is solid. Colour alone fails a colour-vision check. */
	dash: string;
}

interface Props {
	series: KeywordRow[];
	/** Inclusive calendar window to span. Defaults to the observed extent. */
	window?: { from: string; to: string } | null;
	/** Releases in the window: the anchors a rank move is read against. */
	markers?: MetadataMarker[];
	/** Id of an element describing the chart in prose, usually its caption. */
	describedBy?: string;
	styleOf: (pairId: number) => SeriesStyle;
	/** Series the rest of the page is pointing at; everything else greys out. */
	focusedPairId?: number | null;
	onFocus?: (pairId: number | null) => void;
}

interface Segment {
	points: { x: number; y: number }[];
}

function isoDay(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

/** Every calendar day in the window, so a slot's width is always one day. */
function calendarDays(from: string, to: string): string[] {
	const start = Date.parse(from);
	const end = Date.parse(to);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
		return [];
	}
	const days: string[] = [];
	for (let t = start; t <= end; t += DAY_MS) {
		days.push(isoDay(t));
	}
	return days;
}

/**
 * Grid ranks that fit, rather than every candidate below the ceiling.
 *
 * The scale is linear but the candidates are not, so on a 200-deep chart 1, 5
 * and 10 land within a few pixels of each other and their labels overlap. The
 * old filter only checked the *value* against the ceiling, which meant the
 * collision was a function of label size, and the axis was legible at 11px
 * purely by accident. Rank 1 is always kept: it is the line the whole chart is
 * read
 * against.
 */
function gridRanksFor(maxRank: number, yOf: (r: number) => number): number[] {
	const kept: number[] = [];
	for (const r of GRID_CANDIDATES) {
		if (r > Math.max(10, maxRank)) {
			break;
		}
		const last = kept.at(-1);
		if (last === undefined || Math.abs(yOf(r) - yOf(last)) >= MIN_TICK_GAP) {
			kept.push(r);
		}
	}
	return kept;
}

/** Push direct labels apart so a tight cluster of ranks stays readable. */
function spreadLabels(
	wanted: { pairId: number; text: string; y: number; color: string }[]
): { pairId: number; text: string; y: number; color: string }[] {
	const sorted = wanted.toSorted((a, b) => a.y - b.y);
	let previous = Number.NEGATIVE_INFINITY;
	for (const label of sorted) {
		label.y = Math.max(label.y, previous + MIN_LABEL_GAP);
		previous = label.y;
	}
	// Anything pushed past the floor comes back up, keeping the same order.
	const overflow = (sorted.at(-1)?.y ?? 0) - PLOT_BOTTOM;
	if (overflow > 0) {
		for (const label of sorted) {
			label.y -= overflow;
		}
	}
	return sorted;
}

/** One series' value on the hovered day, in the same words in both readouts. */
function readoutValue(
	entry: {
		state: "ranked" | "unranked" | "failed";
		position: number | null;
		errorClass?: string;
	},
	t: Dictionary
): string {
	if (entry.state === "ranked") {
		return fmt(t.chartRank, { n: entry.position ?? "" });
	}
	// The error class is a closed vocabulary the data-health page groups on, so
	// it stays in its own words rather than being translated per language.
	return entry.state === "unranked"
		? t.notInTop200
		: fmt(t.chartNoData, { errorClass: entry.errorClass ?? "" });
}

function markerTitle(
	marker: MetadataMarker,
	t: Dictionary,
	day: (iso: string) => string
): string {
	const what =
		marker.changed.length > 0 ? marker.changed.join(", ") : t.noFieldDiff;
	const version = marker.version
		? fmt(t.chartVersion, { version: marker.version })
		: "";
	return `${day(marker.date)}${version} · ${what}`;
}

function truncate(text: string): string {
	return text.length > LABEL_MAX_CHARS
		? `${text.slice(0, LABEL_MAX_CHARS - 1)}…`
		: text;
}

export function RankSeriesChart({
	series,
	styleOf,
	window: bounds = null,
	markers = NO_MARKERS,
	focusedPairId = null,
	onFocus,
	describedBy,
}: Props) {
	const t = useT();
	const f = useFormat();
	const [hover, setHover] = useState<number | null>(null);
	const [hoverSeries, setHoverSeries] = useState<number | null>(null);
	const hatchId = useId();
	const active = focusedPairId ?? hoverSeries;

	const dates = useMemo(() => {
		const observed = series.flatMap((s) => [
			...s.points.map((p) => p.date),
			...s.fetchErrors.map((e) => e.date),
		]);
		if (bounds) {
			return calendarDays(bounds.from, bounds.to);
		}
		if (observed.length === 0) {
			return [];
		}
		const sorted = observed.toSorted();
		return calendarDays(sorted[0] as string, sorted.at(-1) as string);
	}, [series, bounds]);

	const { maxRank, x, y, lines } = useMemo(() => {
		const ranks = series.flatMap((s) =>
			s.points.map((p) => p.position).filter((p): p is number => p !== null)
		);
		const ceiling = Math.max(10, ...ranks);
		const xOf = (i: number) =>
			PAD.left +
			(i * (W - PAD.left - PAD.right)) / Math.max(1, dates.length - 1);
		const yOf = (r: number) =>
			PAD.top + ((r - 1) * (PLOT_BOTTOM - PAD.top)) / Math.max(1, ceiling - 1);

		const byDate = new Map(dates.map((d, i) => [d, i]));
		const built = series.map((s) => {
			const positions = new Map(s.points.map((p) => [p.date, p.position]));
			const segments: Segment[] = [];
			// Observed, but nowhere in the top 200. Data, not a hole, so it gets a
			// slot of its own instead of being drawn as an absence.
			const unranked: number[] = [];
			const failures: { i: number; errorClass: string }[] = [];
			let current: { x: number; y: number }[] = [];
			for (const [date, i] of byDate) {
				const pos = positions.get(date);
				if (pos === undefined || pos === null) {
					if (current.length > 0) {
						segments.push({ points: current });
					}
					current = [];
					if (pos === null) {
						unranked.push(i);
					}
				} else {
					current.push({ x: xOf(i), y: yOf(pos) });
				}
			}
			if (current.length > 0) {
				segments.push({ points: current });
			}
			for (const e of s.fetchErrors) {
				const i = byDate.get(e.date);
				if (i !== undefined && !positions.has(e.date)) {
					failures.push({ errorClass: e.errorClass, i });
				}
			}
			return { failures, row: s, segments, unranked };
		});

		return { lines: built, maxRank: ceiling, x: xOf, y: yOf };
	}, [dates, series]);

	const labels = useMemo(() => {
		const wanted = lines.flatMap(({ row, segments }) => {
			const last = segments.at(-1)?.points.at(-1);
			return last
				? [
						{
							color: styleOf(row.pairId).color,
							pairId: row.pairId,
							text: truncate(row.keyword),
							y: last.y,
						},
					]
				: [];
		});
		return spreadLabels(wanted);
	}, [lines, styleOf]);

	if (dates.length === 0 || series.length === 0) {
		return <p className="empty">{t.noRankedObservations}</p>;
	}

	function onMove(e: React.MouseEvent<SVGSVGElement>) {
		const rect = e.currentTarget.getBoundingClientRect();
		const px = ((e.clientX - rect.left) / rect.width) * W;
		const i = Math.round(
			((px - PAD.left) / (W - PAD.left - PAD.right)) * (dates.length - 1)
		);
		setHover(Math.max(0, Math.min(dates.length - 1, i)));
	}

	function focus(pairId: number | null) {
		setHoverSeries(pairId);
		onFocus?.(pairId);
	}

	// The crosshair is the only way to read an exact value off the chart, so it
	// cannot be mouse-only: the arrow keys walk the same index, and the readout
	// is mirrored into a live region for anyone who cannot see the tooltip.
	function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
		const last = dates.length - 1;
		let step = 0;
		if (e.key === "ArrowLeft") {
			step = -1;
		} else if (e.key === "ArrowRight") {
			step = 1;
		}
		if (step !== 0) {
			e.preventDefault();
			setHover((current) =>
				Math.max(0, Math.min(last, (current ?? last) + step))
			);
			return;
		}
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			setHover(e.key === "Home" ? 0 : last);
			return;
		}
		if (e.key === "Escape") {
			setHover(null);
		}
	}

	const hoveredDate = hover === null ? null : dates[hover];
	// Every state the hovered day can be in, named. A day with no row at all is
	// omitted: nothing was scheduled, and inventing "0" for it is the lie the
	// whole component exists to avoid.
	const readout =
		hoveredDate === null
			? []
			: series
					.map((s) => {
						const point = s.points.find((p) => p.date === hoveredDate);
						const failed = s.fetchErrors.find((e) => e.date === hoveredDate);
						if (point) {
							return {
								position: point.position,
								row: s,
								state: point.position === null ? "unranked" : "ranked",
							} as const;
						}
						return failed
							? ({
									errorClass: failed.errorClass,
									position: null,
									row: s,
									state: "failed",
								} as const)
							: null;
					})
					.filter((r) => r !== null)
					.toSorted(
						(a, b) =>
							(a.position ?? Number.POSITIVE_INFINITY) -
							(b.position ?? Number.POSITIVE_INFINITY)
					);

	const tickIndexes = [
		0,
		Math.floor((dates.length - 1) / 2),
		dates.length - 1,
	].filter((v, i, a) => a.indexOf(v) === i);

	const errorRailY = PLOT_BOTTOM + RAIL_ERROR;
	const unrankedRailY = PLOT_BOTTOM + RAIL_UNRANKED;
	const slot = Math.max(3, (W - PAD.left - PAD.right) / dates.length);

	return (
		<div className="chart">
			<svg
				aria-label={`Rank history for ${series.length} ${
					series.length === 1 ? "keyword" : "keywords"
				} over ${dates.length} days, ${dates[0]} to ${dates.at(-1)}. Rank 1 is at the top; gaps are days with no observation.`}
				onMouseLeave={() => {
					setHover(null);
					focus(null);
				}}
				aria-describedby={describedBy}
				onKeyDown={onKeyDown}
				onMouseMove={onMove}
				role="img"
				tabIndex={0}
				viewBox={`0 0 ${W} ${H}`}
			>
				<defs>
					<pattern
						height="6"
						id={hatchId}
						patternTransform="rotate(45)"
						patternUnits="userSpaceOnUse"
						width="6"
					>
						<line className="hatch-line" x1="0" x2="0" y1="0" y2="6" />
					</pattern>
				</defs>
				{gridRanksFor(maxRank, y).map((r) => (
					<g key={r}>
						<line
							className="grid-line"
							x1={PAD.left}
							x2={W - PAD.right}
							y1={y(r)}
							y2={y(r)}
						/>
						<text
							className="axis-label"
							textAnchor="end"
							x={PAD.left - 8}
							y={y(r) + 4}
						>
							{r}
						</text>
					</g>
				))}
				{/* The two rails are always drawn, labelled, even when empty: a reader
            has to be able to tell "nothing failed" from "failures not shown". */}
				<line
					className="rail-line"
					x1={PAD.left}
					x2={W - PAD.right}
					y1={unrankedRailY}
					y2={unrankedRailY}
				/>
				<text
					className="axis-label"
					textAnchor="end"
					x={PAD.left - 8}
					y={unrankedRailY + 4}
				>
					&gt;200
				</text>
				<text
					className="axis-label"
					textAnchor="end"
					x={PAD.left - 8}
					y={errorRailY + 4}
				>
					error
				</text>
				{tickIndexes.map((i) => (
					<text
						className="axis-label"
						key={dates[i]}
						textAnchor="middle"
						x={x(i)}
						y={H - 6}
					>
						{dates[i]?.slice(5)}
					</text>
				))}
				{markers.map((marker, n) => {
					const i = dates.indexOf(marker.date);
					// Numbered, not labelled "metadata": three releases in a fortnight
					// all read the same otherwise, and the caption below carries what
					// each one actually changed.
					return i === -1 ? null : (
						<g key={marker.date}>
							<line
								className="marker-line"
								x1={x(i)}
								x2={x(i)}
								y1={PAD.top + 8}
								y2={PLOT_BOTTOM}
							/>
							<circle className="marker-pin" cx={x(i)} cy={PAD.top} r="7">
								<title>{markerTitle(marker, t, f.day)}</title>
							</circle>
							<text
								className="marker-index"
								textAnchor="middle"
								x={x(i)}
								y={PAD.top + 3.5}
							>
								{n + 1}
							</text>
						</g>
					);
				})}
				{hover !== null && (
					<line
						className="crosshair"
						x1={x(hover)}
						x2={x(hover)}
						y1={PAD.top}
						y2={PLOT_BOTTOM}
					/>
				)}
				{lines.map(({ row, segments, unranked, failures }) => {
					const style = styleOf(row.pairId);
					const muted = active !== null && active !== row.pairId;
					const stroke = muted ? "var(--ds-chart-neutral)" : style.color;
					return (
						<g
							className={muted ? "series series-muted" : "series"}
							key={row.pairId}
							onMouseEnter={() => focus(row.pairId)}
						>
							{segments.map((seg, i) => (
								<g key={`${row.pairId}-${i}`}>
									<polyline
										className="series-line"
										points={seg.points.map((p) => `${p.x},${p.y}`).join(" ")}
										stroke={stroke}
										strokeDasharray={style.dash || undefined}
									/>
									{muted
										? null
										: seg.points.map((p) => (
												<circle
													className="series-dot"
													cx={p.x}
													cy={p.y}
													fill={stroke}
													key={`${p.x}-${p.y}`}
													r="3"
												/>
											))}
								</g>
							))}
							{unranked.map((i) => (
								<rect
									className="unranked-mark"
									fill={stroke}
									height="7"
									key={`u-${i}`}
									width="7"
									x={x(i) - 3.5}
									y={unrankedRailY - 3.5}
								>
									<title>{`${dates[i]}: ${row.keyword} observed, outside the top 200`}</title>
								</rect>
							))}
							{failures.map(({ i, errorClass }) => (
								<rect
									className="error-mark"
									fill={`url(#${hatchId})`}
									height="9"
									key={`e-${i}`}
									width={slot}
									x={x(i) - slot / 2}
									y={errorRailY - 4.5}
								>
									<title>{`${dates[i]}: ${row.keyword} fetch failed (${errorClass}), not a rank change`}</title>
								</rect>
							))}
						</g>
					);
				})}
				{labels.map((label) => (
					<text
						className={
							active !== null && active !== label.pairId
								? "series-label series-label-muted"
								: "series-label"
						}
						dominantBaseline="middle"
						fill={
							active !== null && active !== label.pairId
								? "var(--ds-text-subtlest)"
								: label.color
						}
						key={label.pairId}
						x={W - PAD.right + 8}
						y={label.y}
					>
						{label.text}
					</text>
				))}
			</svg>
			{/* The same readout as the tooltip, for a reader who cannot see it. It is
          polite, not assertive: walking the axis with the arrow keys should not
          interrupt whatever is already being announced. */}
			<div aria-live="polite" className="sr-only">
				{hoveredDate && readout.length > 0
					? `${hoveredDate}: ${readout
							.slice(0, READOUT_LIMIT)
							.map((r) => `${r.row.keyword} ${readoutValue(r, t)}`)
							.join("; ")}`
					: ""}
			</div>
			{hoveredDate && readout.length > 0 && (
				<div
					className="chart-tip"
					style={{ left: `${(x(hover ?? 0) / W) * 100}%` }}
				>
					<div className="chart-tip-date">{hoveredDate}</div>
					{readout.slice(0, READOUT_LIMIT).map((r) => (
						<div className="chart-tip-row" key={r.row.pairId}>
							<span
								className="swatch"
								style={{ background: styleOf(r.row.pairId).color }}
							/>
							<span className="chart-tip-name">{r.row.keyword}</span>
							<span className="chart-tip-rank">{readoutValue(r, t)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
