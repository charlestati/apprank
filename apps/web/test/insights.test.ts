import { describe, it, expect } from "vitest";

import { classify, isBrandTerm, summarise } from "../src/insights";
import type { KeywordRow } from "../src/report";

function row(over: Partial<KeywordRow> = {}): KeywordRow {
	return {
		best: null,
		brand: false,
		change: null,
		changeDaysAgo: null,
		difficulty: null,
		fetchErrors: [],
		keyword: "example keyword",
		keywordId: 1,
		pairId: 1,
		points: [],
		popularity: 40,
		popularityStatus: "measured",
		position: 30,
		resultCount: 200,
		resultCountChange: null,
		topResults: [],
		worst: null,
		...over,
	};
}

function difficulty(score: number) {
	return {
		entrenchment: 0.5,
		formulaVersion: "v1",
		incumbentStrength: 0.5,
		sampleSize: 10,
		saturation: 1,
		score,
		stability: 1,
	};
}

describe(classify, () => {
	it("calls a top-10 rank on a real term a win", () => {
		const v = classify(row({ popularity: 45, position: 4 }));
		expect(v.opportunity).toBe("winning");
		expect(v.reason).toContain("defend");
	});

	it("calls a top-10 rank on a dead term vanity, not a win", () => {
		// The classic small-app trap: ranking only where nobody searches.
		const v = classify(row({ popularity: 3, position: 2 }));
		expect(v.opportunity).toBe("vanity");
		expect(v.reason).toContain("reclaim");
	});

	it("refuses to call an unmeasured term vanity", () => {
		// Apple lists only the top ~500 terms per country and genre, so a real
		// keyword routinely has no published volume. Reading that silence as
		// "nobody searches this" invents the fact the verdict rests on.
		const v = classify(
			row({ popularity: null, popularityStatus: "absent", position: 2 })
		);
		expect(v.opportunity).toBe("unknown");
		expect(v.reason).toContain("no search volume");
	});

	it("treats never-queried the same as absent — both are silence", () => {
		expect(
			classify(
				row({ popularity: null, popularityStatus: "unqueried", position: 2 })
			).opportunity
		).toBe("unknown");
	});

	it("still calls a striking-distance rank unknown when volume is unpublished", () => {
		const v = classify(
			row({
				difficulty: difficulty(20),
				popularity: null,
				popularityStatus: "absent",
				position: 35,
			})
		);
		expect(v.opportunity).toBe("unknown");
		expect(v.reason).toContain("unmeasured");
	});

	it("never marks an unmeasured term blocked, however entrenched the page", () => {
		// "blocked" asserts real volume; without a measurement there is none to assert.
		expect(
			classify(
				row({
					difficulty: difficulty(95),
					popularity: null,
					popularityStatus: "absent",
					position: 40,
				})
			).opportunity
		).not.toBe("blocked");
	});

	it("keeps calling an unranked keyword dormant regardless of volume data", () => {
		expect(
			classify(
				row({ popularity: null, popularityStatus: "absent", position: null })
			).opportunity
		).toBe("dormant");
	});

	it("marks a head term with an entrenched top ten as blocked", () => {
		const v = classify(
			row({ difficulty: difficulty(88), popularity: 70, position: 35 })
		);
		expect(v.opportunity).toBe("blocked");
		expect(v.reason).toContain("metadata alone");
	});

	it("marks a winnable term inside striking distance as close", () => {
		const v = classify(
			row({ difficulty: difficulty(50), popularity: 40, position: 35 })
		);
		expect(v.opportunity).toBe("close");
	});

	it("treats a measured zero as genuinely low volume, not as missing data", () => {
		// present = 1 with a low number is a real measurement and must still sort
		// to vanity — the fix must not swallow the signal it was meant to protect.
		expect(
			classify(
				row({ popularity: 1, popularityStatus: "measured", position: 2 })
			).opportunity
		).toBe("vanity");
	});

	it("treats a term with no difficulty score as still worth pushing", () => {
		expect(
			classify(row({ difficulty: null, popularity: 40, position: 40 }))
				.opportunity
		).toBe("close");
	});

	it("calls an unranked keyword dormant and says why", () => {
		const v = classify(row({ popularity: 40, position: null }));
		expect(v.opportunity).toBe("dormant");
		expect(v.reason).toContain("Not ranking");
	});

	it("calls a deep rank dormant even on a popular term", () => {
		expect(
			classify(
				row({ difficulty: difficulty(10), popularity: 60, position: 150 })
			).opportunity
		).toBe("dormant");
	});

	it("flags a rank that moved in the last 48h as unproven", () => {
		expect(
			classify(row({ change: 12, changeDaysAgo: 1, position: 8 })).unproven
		).toBeTruthy();
		expect(
			classify(row({ change: 12, changeDaysAgo: 6, position: 8 })).unproven
		).toBeFalsy();
		expect(classify(row({ change: null, position: 8 })).unproven).toBeFalsy();
	});
});

describe(isBrandTerm, () => {
	it("matches the brand token out of a marketing app name", () => {
		expect(isBrandTerm("codex", "Codex - Le jeu de lettres")).toBeTruthy();
		expect(isBrandTerm("codex jeu", "Codex - Le jeu de lettres")).toBeTruthy();
	});

	it("does not treat generic terms from the name tail as brand", () => {
		expect(
			isBrandTerm("jeu de lettres", "Codex - Le jeu de lettres")
		).toBeFalsy();
	});

	it("copes with a missing or too-short app name", () => {
		expect(isBrandTerm("anything", null)).toBeFalsy();
		expect(isBrandTerm("anything", "Go")).toBeFalsy();
	});
});

describe(summarise, () => {
	const rows = [
		row({ pairId: 1, popularity: 50, position: 3 }), // winning
		row({ brand: true, pairId: 2, popularity: 60, position: 1 }), // winning, brand
		row({ pairId: 3, popularity: 2, position: 5 }), // vanity
		row({
			difficulty: difficulty(90),
			pairId: 4,
			popularity: 80,
			position: 40,
		}), // blocked
		row({ pairId: 5, popularity: 40, position: null }), // dormant
	].map((r) => ({ ...r, brand: r.brand ?? false, verdict: classify(r) }));

	it("counts each lane", () => {
		const s = summarise(rows);
		expect(s).toMatchObject({
			blocked: 1,
			dormant: 1,
			vanity: 1,
			winning: 2,
		});
	});

	it("counts how much of the set has no published volume", () => {
		const mixed = [
			row({ pairId: 10, popularityStatus: "measured" }),
			row({ pairId: 11, popularity: null, popularityStatus: "absent" }),
			row({ pairId: 12, popularity: null, popularityStatus: "unqueried" }),
		].map((r) => ({ ...r, brand: false, verdict: classify(r) }));
		expect(summarise(mixed).unmeasuredKeywords).toBe(2);
	});

	it("separates brand demand from generic progress", () => {
		const s = summarise(rows);
		expect(s.brandKeywords).toBe(1);
		expect(s.genericKeywords).toBe(4);
		// Both #3 and #5 are in the tap zone, but only one of them is generic…
		expect(s.inTapZone).toBe(3);
		expect(s.genericInTapZone).toBe(2);
	});
});
