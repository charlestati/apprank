// Rank movement: positive change means the app moved towards rank 1.
// Direction is carried by an arrow glyph and a label, never by colour alone.

import { useT } from "../i18n";

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
			<span aria-hidden="true">{improved ? "↑" : "↓"}</span>
			<span className="sr-only">{improved ? "up " : "down "}</span>
			{Math.abs(change)}
			{daysAgo ? <span className="delta-age">{daysAgo}d</span> : null}
		</span>
	);
}
