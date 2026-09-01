// Difficulty is our own score, not a vendor's black box, so the cell shows
// the number, the band it falls in, and on hover the inputs that produced it
// and how many of the top ten we actually hold ratings for.

import type { Difficulty as DifficultyValue } from "../api";
import { fmt, useT } from "../i18n";

export function difficultyBand(score: number): string {
	if (score >= 80) {
		return "very hard";
	}
	if (score >= 60) {
		return "hard";
	}
	if (score >= 40) {
		return "moderate";
	}
	if (score >= 20) {
		return "reachable";
	}
	return "open";
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
		`${difficultyBand(value.score)} (${value.score}/100, ${value.formulaVersion})`,
		fmt(t.difficultyTop3, { pct: pct(value.entrenchment) }),
		fmt(t.difficultyTop10, { pct: pct(value.incumbentStrength) }),
		fmt(t.difficultyStability, { pct: pct(value.stability) }),
		fmt(t.difficultySaturation, { pct: pct(value.saturation) }),
		fmt(t.difficultySample, { n: value.sampleSize }),
	].join(" · ");

	return (
		<span className="meter" title={explanation}>
			<span className="meter-track">
				<span
					className={bandClass(value.score)}
					style={{ width: `${value.score}%` }}
				/>
			</span>
			<span className="meter-value">
				{value.score}
				{value.sampleSize < 5 ? (
					<sup title={t.difficultyFewIncumbents}>*</sup>
				) : null}
			</span>
		</span>
	);
}
