/* oxlint-disable vitest/require-top-level-describe -- the row factory is a
   file-wide precondition shared by the suites below. */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KeywordRow } from "../src/api";
import { RankSeriesChart } from "../src/components/rank-series-chart";

function row(over: Partial<KeywordRow> = {}): KeywordRow {
	return {
		best: null,
		change: null,
		changeDaysAgo: null,
		difficulty: null,
		fetchErrors: [],
		keyword: "example keyword",
		keywordId: 1,
		pairId: 1,
		points: [],
		popularity: null,
		popularityStatus: "unqueried",
		position: null,
		resultCount: null,
		resultCountChange: null,
		topResults: [],
		worst: null,
		...over,
	};
}

const solid = () => ({ color: "#357de8", dash: "" });

describe("Rank series chart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("spans every calendar day of the window, not every observed day", () => {
		render(
			<RankSeriesChart
				series={[
					row({
						points: [
							{ date: "2026-01-01", position: 4 },
							{ date: "2026-01-08", position: 6 },
						],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-10" }}
			/>
		);
		// Two observations a week apart occupy ten slots, not two: the axis is the
		// calendar, so a stretched cadence rung draws its gap at its true width.
		expect(screen.getByRole("img", { name: /over 10 days/u })).toBeDefined();
	});

	it("does not start the axis before collection did", () => {
		render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-29", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-30" }}
			/>
		);
		// Twenty-eight empty rungs pack the only observation against the right
		// edge, where a single dot reads as an empty chart rather than as a young
		// one. The window's end is kept: a trailing empty stretch is collection
		// having stopped, which has to stay visible.
		expect(screen.getByRole("img", { name: /over 2 days/u })).toBeDefined();
	});

	it("keeps a failed day inside the axis even before the first rank", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						fetchErrors: [
							{ count: 1, date: "2026-01-20", errorClass: "throttled" },
						],
						points: [{ date: "2026-01-29", position: 4 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-30" }}
			/>
		);
		// A day we tried and failed is an observation. Clamping the axis to the
		// first *rank* would drop it, and a throttled stretch would read as a
		// period nobody had started tracking yet.
		expect(container.querySelectorAll(".error-mark")).toHaveLength(1);
	});

	it("draws a lone observation as a dot, since a one-point line is nothing", () => {
		const { container } = render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		expect(container.querySelectorAll("polyline")).toHaveLength(0);
		expect(container.querySelector(".series-dot")?.getAttribute("r")).toBe("4");
	});

	it("rings series that land on the same point instead of hiding all but one", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({ points: [{ date: "2026-01-01", position: 1 }] }),
					row({
						keyword: "other term",
						pairId: 2,
						points: [{ date: "2026-01-01", position: 1 }],
					}),
					row({
						keyword: "third term",
						pairId: 3,
						points: [{ date: "2026-01-01", position: 1 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		// Three keywords at rank 1 on one day are three concentric marks, not one
		// dot with two invisible ones underneath it.
		const radii = [
			...container.querySelectorAll(".series-dot,.series-dot-ring"),
		]
			.map((c) => c.getAttribute("r"))
			.toSorted();
		expect(radii).toStrictEqual(["10", "4", "7"]);
		expect(
			container.querySelectorAll('.series-dot-ring[fill="none"]')
		).toHaveLength(2);
	});

	it("falls back to the observed extent when no window is given", () => {
		render(
			<RankSeriesChart
				series={[
					row({
						points: [
							{ date: "2026-02-01", position: 3 },
							{ date: "2026-02-03", position: 3 },
						],
					}),
				]}
				styleOf={solid}
			/>
		);
		expect(screen.getByRole("img", { name: /over 3 days/u })).toBeDefined();
	});

	it("puts an observation outside the top 200 on its own rail, not in a gap", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						points: [
							{ date: "2026-01-01", position: 4 },
							{ date: "2026-01-02", position: null },
						],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		const mark = container.querySelector(".unranked-mark title");
		expect(mark?.textContent).toContain("outside the top 200");
		// A day we never collected has no mark at all: absence stays absence.
		expect(container.querySelectorAll(".unranked-mark")).toHaveLength(1);
	});

	it("marks a failed fetch as a failure, never as a rank", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						fetchErrors: [
							{ count: 3, date: "2026-01-02", errorClass: "throttled" },
						],
						points: [{ date: "2026-01-01", position: 4 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		const mark = container.querySelector(".error-mark title");
		expect(mark?.textContent).toContain("throttled");
		expect(mark?.textContent).toContain("not a rank change");
	});

	it("keeps an observed day out of the error rail even if a retry failed", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						fetchErrors: [
							{ count: 1, date: "2026-01-01", errorClass: "throttled" },
						],
						points: [{ date: "2026-01-01", position: 4 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		expect(container.querySelectorAll(".error-mark")).toHaveLength(0);
	});

	it("greys every series but the focused one", () => {
		const { container } = render(
			<RankSeriesChart
				focusedPairId={1}
				series={[
					row({ points: [{ date: "2026-01-01", position: 4 }] }),
					row({
						keyword: "other term",
						pairId: 2,
						points: [{ date: "2026-01-01", position: 9 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		expect(container.querySelectorAll(".series-muted")).toHaveLength(1);
	});

	it("labels each line where it ends, so the legend is not the only key", () => {
		render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		expect(screen.getByText("example keyword")).toBeDefined();
	});

	it("walks the crosshair with the arrow keys, not only the mouse", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						points: [
							{ date: "2026-01-01", position: 4 },
							{ date: "2026-01-02", position: 7 },
						],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		const svg = screen.getByRole("img");
		fireEvent.keyDown(svg, { key: "End" });
		expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
			"2 Jan 2026"
		);
		fireEvent.keyDown(svg, { key: "ArrowLeft" });
		expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
			"1 Jan 2026"
		);
		// The same reading reaches a screen reader, in the same words.
		expect(container.querySelector("[aria-live]")?.textContent).toBe(
			"1 Jan 2026: example keyword rank 4"
		);
		fireEvent.keyDown(svg, { key: "Escape" });
		expect(container.querySelector(".chart-tip-date")).toBeNull();
	});

	it("clears the crosshair when the chart loses focus", () => {
		const { container } = render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		const svg = screen.getByRole("img");
		fireEvent.keyDown(svg, { key: "End" });
		expect(container.querySelector(".crosshair")).not.toBeNull();
		fireEvent.blur(svg);
		expect(container.querySelector(".crosshair")).toBeNull();
		expect(container.querySelector(".chart-tip-date")).toBeNull();
	});

	it("keeps a held crosshair on the plot when the window shrinks", () => {
		const series = [
			row({
				points: [
					{ date: "2026-01-01", position: 4 },
					{ date: "2026-01-02", position: 7 },
				],
			}),
		];
		const { container, rerender } = render(
			<RankSeriesChart
				series={series}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-05" }}
			/>
		);
		fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
		rerender(
			<RankSeriesChart
				series={series}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		// The index pointed past the end; it now reads the last day there is.
		expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
			"2 Jan 2026"
		);
		fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowLeft" });
		expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
			"1 Jan 2026"
		);
	});

	it("announces a failed day as a failure in the live readout", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						fetchErrors: [
							{ count: 2, date: "2026-01-02", errorClass: "throttled" },
						],
						points: [{ date: "2026-01-01", position: 4 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
		expect(container.querySelector("[aria-live]")?.textContent).toContain(
			"no data · throttled"
		);
	});

	it("greys the other release pins when one is pointed at", () => {
		// The same contrast the series legend uses, so the two keys behave alike.
		const markers = [
			{ changed: ["title"], date: "2026-01-02", version: "3.2" },
			{ changed: ["screenshots"], date: "2026-01-03", version: "3.3" },
		];
		const { container } = render(
			<RankSeriesChart
				focusedMarker={0}
				markers={markers}
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		const pins = container.querySelectorAll(".marker-pin");
		expect(pins).toHaveLength(2);
		expect(pins[0]?.classList.contains("marker-muted")).toBeFalsy();
		expect(pins[1]?.classList.contains("marker-muted")).toBeTruthy();
	});

	it("numbers metadata markers and names what each one changed", () => {
		const { container } = render(
			<RankSeriesChart
				markers={[
					{
						changed: ["title", "screenshots"],
						date: "2026-01-02",
						version: "3.2",
					},
				]}
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		// A tag rather than a numeral in a circle, but still numbered: the digit
		// is what keys the pin to its line in the caption when several releases
		// fall close together.
		const pin = container.querySelector(".marker-pin");
		expect(pin?.tagName.toLowerCase()).toBe("svg");
		expect(container.querySelector(".marker-index")?.textContent).toBe("1");
		expect(container.querySelector(".marker-pin title")?.textContent).toBe(
			"2 Jan 2026 · version 3.2 · title, screenshots"
		);
	});

	it("draws in CSS pixels, so the axis type is the size the token asks for", () => {
		// A fixed design-unit viewBox scaled to fit renders every label at
		// 14 * (width / 960): oversized on a wide card, illegible in a narrow one.
		const width = 720;
		// Restored by the afterEach below: restoring inline, after the
		// assertion, left the spy in place for every later test when it failed.
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width,
		} as DOMRect);
		const { container } = render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
			`0 0 ${width} 360`
		);
	});

	it("keeps a drawable width when the box measures nothing", () => {
		// happy-dom, a display:none ancestor and a first paint all report zero;
		// a zero-width viewBox would collapse the whole graphic.
		const { container } = render(
			<RankSeriesChart
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
			"0 0 960 360"
		);
	});

	it("lands on the newest day on the first arrow press, in either direction", () => {
		const points = [
			{ date: "2026-01-01", position: 4 },
			{ date: "2026-01-02", position: 7 },
			{ date: "2026-01-03", position: 9 },
		];
		for (const key of ["ArrowLeft", "ArrowRight"]) {
			const { container, unmount } = render(
				<RankSeriesChart
					series={[row({ points })]}
					styleOf={solid}
					window={{ from: "2026-01-01", to: "2026-01-03" }}
				/>
			);
			// No crosshair yet. Stepping from the default made ArrowLeft skip the
			// newest day, the one most likely to be wanted.
			fireEvent.keyDown(screen.getByRole("img"), { key });
			expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
				"3 Jan 2026"
			);
			unmount();
		}
	});

	it("draws one mark for a day that failed with two classes, and names both", () => {
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						fetchErrors: [
							{ count: 1, date: "2026-01-02", errorClass: "throttled" },
							{ count: 1, date: "2026-01-02", errorClass: "http_error" },
						],
						points: [{ date: "2026-01-01", position: 4 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		// The server groups failures by day and class. Two rects on one slot were
		// two elements under one key and one visible hatch.
		expect(container.querySelectorAll(".error-mark")).toHaveLength(1);
		fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
		expect(container.querySelector("[aria-live]")?.textContent).toContain(
			"no data · throttled, http_error"
		);
	});

	it("rings keywords outside the top 200 on the same day instead of stacking them", () => {
		const points = [
			{ date: "2026-01-01", position: 4 },
			{ date: "2026-01-02", position: null },
		];
		const { container } = render(
			<RankSeriesChart
				series={[
					row({ points }),
					row({ keyword: "other term", pairId: 2, points }),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		// Two 7px squares on one pixel showed only the last one painted.
		expect(container.querySelectorAll(".unranked-mark")).toHaveLength(1);
		const ring = container.querySelector(".unranked-mark-ring");
		expect(ring?.getAttribute("fill")).toBe("none");
		expect(ring?.getAttribute("width")).toBe("13");
	});

	it("keeps a muted series visible when all it has is lone observations", () => {
		const { container } = render(
			<RankSeriesChart
				focusedPairId={1}
				series={[
					row({ points: [{ date: "2026-01-01", position: 4 }] }),
					row({
						keyword: "weekly term",
						pairId: 2,
						points: [{ date: "2026-01-02", position: 9 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		// A pair on a stretched cadence is nothing but isolated dots; dropping the
		// dots of a muted series made it vanish outright.
		const muted = container.querySelector(".series-muted");
		expect(muted?.querySelectorAll(".series-dot")).toHaveLength(1);
		expect(muted?.querySelector(".series-dot")?.getAttribute("fill")).toBe(
			"var(--ds-chart-neutral)"
		);
	});

	it("ignores a focused pair that is not on the chart", () => {
		const { container } = render(
			<RankSeriesChart
				focusedPairId={99}
				series={[
					row({ points: [{ date: "2026-01-01", position: 4 }] }),
					row({
						keyword: "other term",
						pairId: 2,
						points: [{ date: "2026-01-01", position: 9 }],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-02" }}
			/>
		);
		// The table reports any row under the pointer; one that is not drawn
		// here greyed every line without lighting any.
		expect(container.querySelectorAll(".series-muted")).toHaveLength(0);
	});

	it("tells two releases on one day apart, and lights only the one pointed at", () => {
		const { container } = render(
			<RankSeriesChart
				focusedMarker={1}
				markers={[
					{ changed: ["title"], date: "2026-01-02", version: "3.2" },
					{ changed: ["releaseNotes"], date: "2026-01-02", version: "3.3" },
				]}
				series={[row({ points: [{ date: "2026-01-01", position: 4 }] })]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-03" }}
			/>
		);
		const pins = [...container.querySelectorAll(".marker-pin")];
		expect(pins).toHaveLength(2);
		// Keyed by date, both lit together and shared one React key.
		expect(pins[0]?.classList.contains("marker-muted")).toBeTruthy();
		expect(pins[1]?.classList.contains("marker-on")).toBeTruthy();
		expect(pins[0]?.getAttribute("x")).not.toBe(pins[1]?.getAttribute("x"));
		// The field is named in words, not as the server's identifier.
		expect(pins[1]?.querySelector("title")?.textContent).toBe(
			"2 Jan 2026 · version 3.3 · release notes"
		);
	});

	it("keeps the tooltip inside the chart at either edge", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width: 600,
		} as DOMRect);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
		const { container } = render(
			<RankSeriesChart
				series={[
					row({
						points: [
							{ date: "2026-01-01", position: 4 },
							{ date: "2026-01-09", position: 7 },
						],
					}),
				]}
				styleOf={solid}
				window={{ from: "2026-01-01", to: "2026-01-09" }}
			/>
		);
		const left = () =>
			container.querySelector<HTMLElement>(".chart-tip")?.style.left;
		// The first day sits 46px in: centred there, half the box was off-canvas.
		fireEvent.keyDown(screen.getByRole("img"), { key: "Home" });
		expect(left()).toBe("100px");
		fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
		expect(left()).toBe("468px");
	});

	it("says so when there is nothing to draw", () => {
		render(<RankSeriesChart series={[]} styleOf={solid} />);
		expect(
			screen.getByText(/No ranked observations in this window yet/u)
		).toBeDefined();
	});
});
