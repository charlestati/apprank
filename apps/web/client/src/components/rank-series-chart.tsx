// Multi-series rank history: y inverted (rank 1 at the top), one line per
// keyword, a crosshair that reads every series at the hovered date, and gaps
// left as gaps — a missing observation must never look like a flat rank.

/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role --
   role="img" is the correct semantic for an inline SVG graphic (an <img> tag
   cannot hold one), and the mouse handlers are a pointer-only crosshair layered
   over an already aria-labelled chart. */

import { useMemo, useState } from "react";

import type { KeywordRow } from "../api";

const W = 960;
const H = 320;
const PAD = { bottom: 28, left: 40, right: 16, top: 16 };
const SERIES_COUNT = 8;
// A stable empty default: an inline [] would be a new reference every render.
const NO_MARKERS: string[] = [];

interface Props {
  dates: string[];
  series: KeywordRow[];
  /** Dates the app's metadata changed: the anchors a rank move is read against. */
  markers?: string[];
  /** Series index per pairId, so table dots and chart lines always agree. */
  colorOf: (pairId: number) => string;
}

interface Segment {
  points: { x: number; y: number }[];
}

const GRID_CANDIDATES = [1, 5, 10, 25, 50, 100, 150, 200];
/** Label line-height plus a little air, in viewBox units. */
const MIN_TICK_GAP = 18;

/**
 * Grid ranks that fit, rather than every candidate below the ceiling.
 *
 * The scale is linear but the candidates are not, so on a 200-deep chart 1, 5
 * and 10 land within a few pixels of each other and their labels overlap. The
 * old filter only checked the *value* against the ceiling, which meant the
 * collision was a function of label size — the axis was legible at 11px purely
 * by accident. Rank 1 is always kept: it is the line the whole chart is read
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

export function RankSeriesChart({
  dates,
  series,
  colorOf,
  markers = NO_MARKERS,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const { maxRank, x, y, lines } = useMemo(() => {
    const ranks = series.flatMap((s) =>
      s.points.map((p) => p.position).filter((p): p is number => p !== null)
    );
    const ceiling = Math.max(10, ...ranks);
    const xOf = (i: number) =>
      PAD.left +
      (i * (W - PAD.left - PAD.right)) / Math.max(1, dates.length - 1);
    const yOf = (r: number) =>
      PAD.top +
      ((r - 1) * (H - PAD.top - PAD.bottom)) / Math.max(1, ceiling - 1);

    const byDate = new Map(dates.map((d, i) => [d, i]));
    const built = series.map((s) => {
      const positions = new Map(s.points.map((p) => [p.date, p.position]));
      const segments: Segment[] = [];
      let current: { x: number; y: number }[] = [];
      for (const [date, i] of byDate) {
        const pos = positions.get(date);
        if (pos === undefined || pos === null) {
          if (current.length > 0) {
            segments.push({ points: current });
          }
          current = [];
        } else {
          current.push({ x: xOf(i), y: yOf(pos) });
        }
      }
      if (current.length > 0) {
        segments.push({ points: current });
      }
      return { row: s, segments };
    });

    return { lines: built, maxRank: ceiling, x: xOf, y: yOf };
  }, [dates, series]);

  if (dates.length === 0 || series.length === 0) {
    return (
      <p className="empty">
        No ranked observations in this window yet. The collector fills this in
        daily.
      </p>
    );
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(
      ((px - PAD.left) / (W - PAD.left - PAD.right)) * (dates.length - 1)
    );
    setHover(Math.max(0, Math.min(dates.length - 1, i)));
  }

  const hoveredDate = hover === null ? null : dates[hover];
  const readout =
    hoveredDate === null
      ? []
      : series
          .map((s) => ({
            position:
              s.points.find((p) => p.date === hoveredDate)?.position ?? null,
            row: s,
          }))
          .filter((r) => r.position !== null)
          .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const tickIndexes = [
    0,
    Math.floor((dates.length - 1) / 2),
    dates.length - 1,
  ].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="chart">
      <svg
        aria-label="Keyword rank history"
        onMouseLeave={() => setHover(null)}
        onMouseMove={onMove}
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
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
        {tickIndexes.map((i) => (
          <text
            className="axis-label"
            key={dates[i]}
            textAnchor="middle"
            x={x(i)}
            y={H - 8}
          >
            {dates[i]?.slice(5)}
          </text>
        ))}
        {markers.map((date) => {
          const i = dates.indexOf(date);
          return i === -1 ? null : (
            <g key={date}>
              <line
                className="marker-line"
                x1={x(i)}
                x2={x(i)}
                y1={PAD.top}
                y2={H - PAD.bottom}
              />
              <text className="marker-label" x={x(i) + 4} y={PAD.top + 10}>
                metadata
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
            y2={H - PAD.bottom}
          />
        )}
        {lines.map(({ row, segments }) =>
          segments.map((seg, i) => (
            <g key={`${row.pairId}-${i}`}>
              <polyline
                className="series-line"
                points={seg.points.map((p) => `${p.x},${p.y}`).join(" ")}
                stroke={colorOf(row.pairId)}
              />
              {seg.points.map((p) => (
                <circle
                  className="series-dot"
                  cx={p.x}
                  cy={p.y}
                  fill={colorOf(row.pairId)}
                  key={`${p.x}-${p.y}`}
                  r="3"
                />
              ))}
            </g>
          ))
        )}
      </svg>
      {hoveredDate && readout.length > 0 && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover ?? 0) / W) * 100}%` }}
        >
          <div className="chart-tip-date">{hoveredDate}</div>
          {readout.slice(0, SERIES_COUNT).map((r) => (
            <div className="chart-tip-row" key={r.row.pairId}>
              <span
                className="swatch"
                style={{ background: colorOf(r.row.pairId) }}
              />
              <span className="chart-tip-name">{r.row.keyword}</span>
              <span className="chart-tip-rank">#{r.position}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
