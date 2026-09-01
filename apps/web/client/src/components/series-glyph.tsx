// The key that ties a table row to a line on the chart.
//
// It draws the stroke itself, colour *and* dash together, rather than a colour
// dot,
// because a dot leaves colour as the only channel and roughly one man in
// twelve
// cannot use it. The same glyph appears in the legend and on the table's
// toggle,
// so the mapping is learned once.

import type { SeriesStyle } from "./rank-series-chart";

export function SeriesGlyph({
	style,
	muted = false,
}: {
	style: SeriesStyle | null;
	muted?: boolean;
}) {
	return (
		<svg
			aria-hidden="true"
			className="series-glyph"
			focusable="false"
			viewBox="0 0 20 8"
		>
			<line
				stroke={style && !muted ? style.color : "var(--ds-border-bold)"}
				strokeDasharray={style?.dash || undefined}
				strokeLinecap="round"
				strokeWidth="2"
				x1="1"
				x2="19"
				y1="4"
				y2="4"
			/>
		</svg>
	);
}
