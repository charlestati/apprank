// Rank movement: positive change means the app moved towards rank 1.
// Direction is carried by an arrow and a label, never by colour alone.

import { Triangle } from "lucide-react";

import { useT } from "../i18n";

/**
 * The direction marker for any rank delta, in the table and in the tiles.
 *
 * A filled triangle rather than a stroked arrow. These render at 12px beside
 * 14px digits, and at that size an arrow's stem is about one device pixel wide,
 * so it reads as a hairline next to bold tabular numerals and the column loses
 * its scan line. Weight cannot fix that; mass can, which is why this is a solid
 * shape and not a heavier stroke. It is also the convention every ticker uses,
 * so it needs no learning.
 *
 * One component, used in both places, because two definitions of "up" at the
 * same size for the same meaning drift the moment one of them is adjusted.
 */
export function TrendArrow({ up }: { up: boolean }) {
	return (
		<Triangle
			aria-hidden="true"
			className={up ? "trend-arrow" : "trend-arrow trend-arrow-down"}
			fill="currentColor"
			size={9}
			strokeWidth={2}
		/>
	);
}

interface Props {
	change: number | null;
	daysAgo: number | null;
}

export function Delta({ change, daysAgo }: Props) {
	const t = useT();
	if (!change) {
		return (
			<span className="delta delta-flat" title={t.noChangeWindow}>
				—
			</span>
		);
	}
	const improved = change > 0;
	// Direction, then magnitude, then age. The age led before, which put a
	// variable-width token at the start of a right-aligned column and left no
	// two arrows in it sharing an x.
	return (
		<span
			className={
				improved ? "delta delta-cell delta-up" : "delta delta-cell delta-down"
			}
		>
			<TrendArrow up={improved} />
			<span className="sr-only">{improved ? "up " : "down "}</span>
			{Math.abs(change)}
			{daysAgo ? <span className="delta-age">{daysAgo}d</span> : null}
		</span>
	);
}
