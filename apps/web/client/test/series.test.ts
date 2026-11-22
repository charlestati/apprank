/// <reference types="node" />
// The client tsconfig types the browser only; this test reads the stylesheets
// from disk, under Node.
import { readFileSync } from "node:fs";
import path from "node:path";

import { createColor, deltaE, simulateCvd } from "category-colors";
import type { State } from "category-colors";
import { describe, expect, it } from "vitest";

import { CHART_SERIES, SERIES_STYLES } from "../src/pages/keyword-performance";

// Read from disk, from the web workspace Vitest runs in: a stylesheet import
// comes back empty, and under happy-dom import.meta.url is not a file URL.
const source = (name: string): string =>
	readFileSync(path.join(process.cwd(), "client/src", name), "utf-8");
const appfigures = source("theme-appfigures.css");
const atlassian = source("theme.css");

// What a reader of the rank chart must be able to tell apart: the series the
// cap lets it draw, in every skin and theme, against the surface the chart
// card sits on. Measured as CIEDE2000 between the colours as a dichromat sees
// them (Machado, Oliveira and Fernandes 2009, through category-colors), and as
// the WCAG 2 contrast ratio a graphical object needs (SC 1.4.11).

const DICHROMACIES = ["protanopia", "deuteranopia", "tritanopia"] as const;

// Each skin declares every slot twice, light first, then dark.
const slotsOf = (css: string, theme: 0 | 1): Map<number, string> => {
	const seen = new Map<number, string[]>();
	for (const { groups } of css.matchAll(
		/--ds-chart-(?<slot>\d):\s*(?<hex>#[0-9a-f]{6});/giu
	)) {
		const slot = Number(groups?.slot);
		const list = seen.get(slot) ?? [];
		list.push(groups?.hex ?? "");
		seen.set(slot, list);
	}
	return new Map([...seen].map(([slot, list]) => [slot, list[theme] ?? ""]));
};

const surfacesOf = (css: string, theme: 0 | 1): string[] =>
	["surface", "surface-raised"].map((name) => {
		const all = [
			...css.matchAll(
				new RegExp(`--ds-${name}:\\s*(?<hex>#[0-9a-f]{6});`, "giu")
			),
		];
		return all[theme]?.groups?.hex ?? "";
	});

const drawn = (slots: Map<number, string>): string[] =>
	SERIES_STYLES.slice(0, CHART_SERIES).map((style) => {
		const slot = Number(
			/--ds-chart-(?<slot>\d)/u.exec(style.color)?.groups?.slot
		);
		return slots.get(slot) ?? "";
	});

const least = (
	colours: string[],
	seen?: (typeof DICHROMACIES)[number]
): number => {
	const state: State = {
		colors: colours.map((colour) => createColor(colour)),
		cost: 0,
		iterations: 0,
		temperature: 0,
	};
	const shown =
		seen === undefined ? state.colors : simulateCvd(state, seen, 1).colors;
	let min = Number.POSITIVE_INFINITY;
	for (const [i, a] of shown.entries()) {
		for (const b of shown.slice(i + 1)) {
			min = Math.min(min, deltaE(a, b));
		}
	}
	return min;
};

const luminance = (hex: string): number => {
	const [r, g, b] = [1, 3, 5].map((at) => {
		const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const ratio = (a: string, b: string): number => {
	const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const CASES = [
	["Appfigures", "light", appfigures, 0],
	["Appfigures", "dark", appfigures, 1],
	["Atlassian", "light", atlassian, 0],
	["Atlassian", "dark", atlassian, 1],
] as const;

describe.each(CASES)(
	"the rank chart's series, %s skin, %s",
	(_skin, _theme, css, theme) => {
		const colours = drawn(slotsOf(css, theme));

		it("finds a colour for every series the cap allows", () => {
			expect(colours).toHaveLength(CHART_SERIES);
			for (const colour of colours) {
				expect(colour).toMatch(/^#[0-9a-f]{6}$/iu);
			}
		});

		it("keeps every line at 3:1 against the chart's surfaces", () => {
			for (const colour of colours) {
				for (const surface of surfacesOf(css, theme)) {
					expect(ratio(colour, surface)).toBeGreaterThanOrEqual(3);
				}
			}
		});

		it("keeps the series apart for normal vision", () => {
			expect(least(colours)).toBeGreaterThanOrEqual(15);
		});

		it.each(DICHROMACIES)("keeps the series apart with %s", (seen) => {
			// The former order drew the light violet beside the blue: 1.8 to 3.0.
			expect(least(colours, seen)).toBeGreaterThanOrEqual(5);
		});
	}
);
