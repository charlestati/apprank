// Inline magnitude bar with its value beside it, the table's densest signal.
// The number is always present, so the bar is decoration, not the only
// channel.
//
// Base UI's Meter carries `role="meter"` and the value on the element itself.
// The hand-rolled version wore `role="img"` with the reading baked into an
// aria-label, which announced a picture where there was a measurement.

import { Meter as BaseMeter } from "@base-ui/react/meter";

interface Props {
	value: number | null;
	max?: number;
	label: string;
	/** The reading in words, for the reader who hovers the bar rather than the
	    column header that explains the scale. */
	title?: string;
}

export function Meter({ value, max = 100, label, title }: Props) {
	// A keyword Apple publishes no volume for has no measurement to render, and
	// a meter pinned at zero would claim one.
	if (value === null) {
		return (
			<span
				aria-label={`${label}: no data`}
				className="meter meter-empty"
				title={title}
			>
				<span className="meter-value">—</span>
			</span>
		);
	}
	return (
		<BaseMeter.Root
			aria-label={label}
			className="meter"
			// Left to itself the meter announces "40%": a share of the scale, when
			// the scale is a 0-100 score and 40 is the reading.
			getAriaValueText={(_formatted, current) => String(current)}
			max={max}
			title={title}
			value={value}
		>
			<BaseMeter.Track className="meter-track">
				<BaseMeter.Indicator className="meter-fill" />
			</BaseMeter.Track>
			{/* The reading is the score itself, not its share of the scale: a
			    popularity of 40 is 40, and "40%" would be a different claim. */}
			<BaseMeter.Value className="meter-value">
				{(_formatted, current) => current}
			</BaseMeter.Value>
		</BaseMeter.Root>
	);
}
