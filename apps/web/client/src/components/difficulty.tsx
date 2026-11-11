// Difficulty is our own score, not a vendor's black box, so the cell shows
// the number, the band it falls in, and on hover the inputs that produced it
// and how many of the top ten we actually hold ratings for.
//
// The band leads in words. A bare "62" is a number the reader has to look up;
// "hard" is the reading, and the column header carries the scale itself.

import { Meter as BaseMeter } from "@base-ui/react/meter";

import type { Difficulty as DifficultyValue } from "../api";
import type { Dictionary } from "../i18n";
import { fmt, useT } from "../i18n";
import { Hint } from "./info-tip";

function difficultyBand(t: Dictionary, score: number): string {
	if (score >= 80) {
		return t.diffVeryHard;
	}
	if (score >= 60) {
		return t.diffHard;
	}
	if (score >= 40) {
		return t.diffModerate;
	}
	if (score >= 20) {
		return t.diffReachable;
	}
	return t.diffOpen;
}

function bandClass(score: number): string {
	if (score >= 60) {
		return "meter-fill meter-hard";
	}
	if (score >= 40) {
		return "meter-fill meter-moderate";
	}
	return "meter-fill meter-easy";
}

function pct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

export function Difficulty({ value }: { value: DifficultyValue | null }) {
	const t = useT();
	if (!value) {
		return (
			<span className="subtle" title={t.difficultyUnscored}>
				—
			</span>
		);
	}

	const explanation = [
		fmt(t.difficultyTitle, {
			band: difficultyBand(t, value.score),
			n: value.score,
		}),
		fmt(t.difficultyTop3, { pct: pct(value.entrenchment) }),
		fmt(t.difficultyTop10, { pct: pct(value.incumbentStrength) }),
		fmt(t.difficultyStability, { pct: pct(value.stability) }),
		fmt(t.difficultySaturation, { pct: pct(value.saturation) }),
		fmt(t.difficultySample, { n: value.sampleSize }),
		value.formulaVersion,
	].join(" · ");

	// The footnote trigger sits beside the meter, not inside it: the children of
	// `role="meter"` are presentational, so a button in there has a name
	// assistive tech is free to drop.
	return (
		<span className="meter-cell">
			<BaseMeter.Root
				aria-label={t.difficulty}
				className="meter"
				getAriaValueText={(_formatted, current) => String(current)}
				title={explanation}
				value={value.score}
			>
				<BaseMeter.Track className="meter-track">
					<BaseMeter.Indicator className={bandClass(value.score)} />
				</BaseMeter.Track>
				<BaseMeter.Value className="meter-value">
					{(_formatted, score) => score}
				</BaseMeter.Value>
			</BaseMeter.Root>
			{/* The asterisk used to carry its meaning in a `title` alone, which is
			    to say nowhere a touch or keyboard reader could find it. */}
			{value.sampleSize < 5 ? (
				<Hint
					className="footnote-mark"
					label={t.difficultyFewIncumbents}
					mark="*"
				>
					{t.difficultyFewIncumbents}
				</Hint>
			) : null}
		</span>
	);
}
