/* oxlint-disable vitest/require-top-level-describe -- the fetch stub is a
   file-wide precondition shared by the suites below. */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KeywordRow, Report } from "../src/api";
import { Delta } from "../src/components/delta";
import { Meter } from "../src/components/meter";
import { SummaryTiles } from "../src/components/summary-tiles";
import { KeywordPerformance } from "../src/pages/keyword-performance";
import { chooseOption, stubFetch, trackedApp } from "./harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

function keywordRow(over: Partial<KeywordRow> = {}): KeywordRow {
	return {
		best: 3,
		change: 2,
		difficulty: {
			entrenchment: 0.6,
			formulaVersion: "v1",
			incumbentStrength: 0.5,
			sampleSize: 8,
			saturation: 1,
			score: 62,
			stability: 0.9,
		},
		changeDaysAgo: 1,
		fetchErrors: [],
		keyword: "example keyword",
		keywordId: 1,
		pairId: 1,
		points: [
			{ date: "2026-08-29", position: 6 },
			{ date: "2026-08-30", position: null },
			{ date: "2026-08-31", position: 4 },
		],
		popularity: 55,
		popularityStatus: "measured" as const,
		position: 4,
		resultCount: 212,
		resultCountChange: 18,
		verdict: {
			opportunity: "close" as const,
			reason: "Within reach of the visible zone.",
			unproven: false,
		},
		topResults: [
			{
				appId: 1,
				iconUrl: "https://example.test/1.png",
				name: "Rival App",
				position: 1,
			},
			{ appId: 2, iconUrl: null, name: "Another App", position: 2 },
			{ appId: 3, iconUrl: null, name: "Third App", position: 3 },
			{ appId: 4, iconUrl: null, name: "Fourth App", position: 4 },
		],
		worst: 12,
		...over,
	};
}

function report(over: Partial<Report> = {}): Report {
	return {
		dates: ["2026-08-29", "2026-08-30", "2026-08-31"],
		days: 30,
		window: { from: "2026-08-29", to: "2026-08-31" },
		rows: [keywordRow()],
		stats: {
			averageRank: 4,
			averageRankChange: 2,
			best: 4,
			distribution: { beyond: 0, top100: 0, top25: 1, top5: 0 },
			movement: { down: 0, unchanged: 0, up: 1 },
			rankedKeywords: 1,
			trackedKeywords: 2,
			worst: 4,
		},
		insights: {
			blocked: 0,
			brandKeywords: 0,
			close: 1,
			dormant: 0,
			genericInTapZone: 1,
			genericKeywords: 1,
			inTapZone: 1,
			unknown: 0,
			unmeasuredKeywords: 0,
			vanity: 0,
			winning: 1,
		},
		metadataChanges: [],
		storefront: "fr",
		...over,
	};
}

function renderPage(routes: Record<string, unknown>) {
	const calls = stubFetch(routes);
	render(
		<MemoryRouter>
			<KeywordPerformance app={trackedApp} />
		</MemoryRouter>
	);
	return calls;
}

const storefronts = [
	{ code: "fr", keywords: 25, name: "France" },
	{ code: "be", keywords: 25, name: "Belgium" },
];

describe("Keyword performance page", () => {
	it("says so when no app is tracked, without fetching", () => {
		const calls = stubFetch({});
		render(
			<MemoryRouter>
				<KeywordPerformance app={null} />
			</MemoryRouter>
		);
		expect(screen.getByText("No app is being tracked yet.")).toBeDefined();
		expect(calls).toStrictEqual([]);
	});

	it("loads the first storefront's report and fills the table", async () => {
		const calls = renderPage({ report: report(), storefronts });

		// The keyword shows up twice: once in the chart legend, once in the table.
		await screen.findAllByText("example keyword");
		expect(calls.some((c) => c.includes("storefront=fr&days=30"))).toBeTruthy();

		const row = screen.getAllByRole("row").at(-1) as HTMLElement;
		const cells = within(row)
			.getAllByRole("cell")
			.map((c) => c.textContent);
		expect(cells[1]).toBe("4");
		expect(cells[2]).toContain("1d");
		expect([cells[5], cells[7]]).toStrictEqual(["3 / 12", "212"]);
		// The two meter cells carry the reading on the element itself, which is
		// what `role="meter"` is for, so the score is read off the value.
		const meters = within(row).getAllByRole("meter");
		expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toStrictEqual([
			"55",
			"62",
		]);
	});

	it("captions the chart and keys the metadata markers", async () => {
		renderPage({
			report: report({
				metadataChanges: [
					{ changed: ["title"], date: "2026-08-30", version: "3.2" },
				],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");

		// The caption is what the graphic points at with aria-describedby, so it
		// has to say what a gap means rather than restate the title.
		const caption = document.querySelector("#chart-caption");
		expect(caption?.textContent).toContain(
			"A gap is a day with no observation"
		);
		expect(
			document.querySelector("svg[role=img]")?.getAttribute("aria-describedby")
		).toBe("chart-caption");
		// Numbered pin, and the key that says what the release actually changed.
		expect(document.querySelector(".marker-key")?.textContent).toContain(
			"30 Aug 2026 · 3.2 · title"
		);
	});

	it("shows the leading competitors as icons, capped at a single line", async () => {
		renderPage({ report: report(), storefronts });
		await expect(screen.findByTitle("1. Rival App")).resolves.toBeDefined();
		// The fourth result is beyond the cap, so it is not rendered.
		expect(screen.queryByTitle("4. Fourth App")).toBeNull();
		// A known icon renders as an image; an app without one falls back to a letter.
		expect(
			document.querySelector<HTMLImageElement>(".result-app img")?.src
		).toContain("1.png");
		expect(document.querySelector(".icon-fallback")).not.toBeNull();
	});

	it("refetches when the storefront changes", async () => {
		const calls = renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");

		chooseOption("Storefront", "Belgium (25)");
		await vi.waitFor(() =>
			expect(calls.some((c) => c.includes("storefront=be"))).toBeTruthy()
		);
	});

	it("refetches when the time period changes", async () => {
		const calls = renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");

		fireEvent.click(screen.getByRole("button", { name: "7 days" }));
		await vi.waitFor(() =>
			expect(calls.some((c) => c.includes("days=7"))).toBeTruthy()
		);
		expect(
			screen
				.getByRole("button", { name: "7 days" })
				.getAttribute("aria-pressed")
		).toBe("true");
	});

	it("filters the table by keyword and says when nothing matches", async () => {
		renderPage({
			report: report({
				rows: [keywordRow(), keywordRow({ keyword: "other term", pairId: 2 })],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");

		const search = screen.getByLabelText("Filter keywords");
		fireEvent.change(search, { target: { value: "other" } });
		expect(
			within(screen.getByRole("table")).queryByText("example keyword")
		).toBeNull();
		expect(
			within(screen.getByRole("table")).getByText("other term")
		).toBeDefined();

		fireEvent.change(search, { target: { value: "zzz" } });
		expect(screen.getByText(/No keywords match/u)).toBeDefined();
	});

	it("renders an unranked keyword as a dash rather than a zero", async () => {
		renderPage({
			report: report({
				rows: [
					keywordRow({
						best: null,
						change: null,
						changeDaysAgo: null,
						points: [],
						popularity: null,
						position: null,
						resultCount: null,
						topResults: [],
						worst: null,
					}),
				],
				stats: { ...report().stats, averageRank: null, rankedKeywords: 0 },
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		const row = screen.getAllByRole("row").at(-1) as HTMLElement;
		const cells = within(row).getAllByRole("cell");
		expect(cells[1]?.textContent).toBe("—");
		expect(cells[5]?.textContent).toBe("— / —");
	});

	it("says the report failed rather than spinning forever", async () => {
		renderPage({
			report: new Response("", { status: 500 }),
			storefronts: [{ code: "fr", keywords: 1, name: "France" }],
		});
		await expect(
			screen.findByText(/report could not be loaded/u)
		).resolves.toBeDefined();
	});
});

describe("Opportunities panel", () => {
	it("leads with generic progress rather than a flattering average", async () => {
		renderPage({
			report: report({
				insights: {
					blocked: 1,
					brandKeywords: 2,
					close: 3,
					dormant: 4,
					genericInTapZone: 1,
					genericKeywords: 9,
					unknown: 0,
					unmeasuredKeywords: 0,
					inTapZone: 3,
					vanity: 2,
					winning: 5,
				},
			}),
			storefronts,
		});
		await screen.findByText("What to work on");
		expect(
			screen.getByText(/top 10 for 1 of your 9 generic keywords/u)
		).toBeDefined();
		expect(
			screen.getByText(/2 brand terms .* are counted separately/u)
		).toBeDefined();
	});

	it("names each lane with its count", async () => {
		renderPage({ report: report(), storefronts });
		await screen.findByText("What to work on");
		for (const lane of ["Winning", "Within reach", "Blocked", "Vanity ranks"]) {
			expect(screen.getByText(lane)).toBeDefined();
		}
	});

	it("lists example keywords in the lane they belong to", async () => {
		renderPage({
			report: report({
				rows: [
					keywordRow({
						keyword: "reachable term",
						verdict: {
							opportunity: "close",
							reason: "Within reach.",
							unproven: false,
						},
					}),
				],
			}),
			storefronts,
		});
		await screen.findByText("What to work on");
		const lane = screen
			.getByRole("heading", { name: /Within reach/u })
			.closest(".lane") as HTMLElement;
		expect(within(lane).getByText("reachable term")).toBeDefined();
	});
});

describe("Rank credibility", () => {
	it("marks a rank that moved in the last 48h as unsettled", async () => {
		renderPage({
			report: report({
				rows: [
					keywordRow({
						verdict: {
							opportunity: "close",
							reason: "Within reach.",
							unproven: true,
						},
					}),
				],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		expect(screen.getByTitle(/moved in the last 48h/u)).toBeDefined();
	});

	it("flags a term whose result page is filling up", async () => {
		renderPage({
			report: report({ rows: [keywordRow({ resultCountChange: 120 })] }),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		expect(screen.getByTitle(/more contested/u)).toBeDefined();
	});
});

describe("Difficulty column", () => {
	it("shows the score with the inputs behind it, not a bare number", async () => {
		renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");
		const cell = document.querySelector<HTMLElement>(
			'.meter[aria-label="Difficulty"]'
		);
		expect(cell?.title).toContain("Difficulty 62 of 100 — hard.");
		expect(cell?.title).toContain("top-3 rating mass 60%");
		expect(cell?.title).toContain("based on 8 of the top 10");
	});

	it("marks a score computed from few known incumbents", async () => {
		renderPage({
			report: report({
				rows: [
					keywordRow({
						difficulty: {
							entrenchment: 0.2,
							formulaVersion: "v1",
							incumbentStrength: 0.2,
							sampleSize: 2,
							saturation: 0.5,
							score: 21,
							stability: 0.5,
						},
					}),
				],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		// The mark explains itself to a keyboard and a touch reader, so it is a
		// labelled trigger rather than a `title` nobody can reach.
		expect(
			screen.getByRole("button", { name: /Fewer than 5 of the top 10/u })
		).toBeDefined();
	});

	it("dashes a keyword that has never been scored", async () => {
		renderPage({
			report: report({ rows: [keywordRow({ difficulty: null })] }),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		expect(
			screen.getByTitle(
				"Not scored yet: this needs a ranked observation first."
			)
		).toBeDefined();
	});
});

describe("Column explanations", () => {
	it("hangs a reachable explanation off every derived column", async () => {
		renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");
		for (const label of [
			"About Position",
			"About Change",
			"About Popularity",
			"About Difficulty",
			"About Best / worst rank",
			"About Total apps",
		]) {
			expect(screen.getByRole("button", { name: label })).toBeDefined();
		}
	});

	it("reads the popularity bar out in words", async () => {
		renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");
		expect(
			document.querySelector<HTMLElement>('.meter[aria-label="Popularity"]')
				?.title
		).toContain("Search popularity 55 of 100 — Medium");
	});
});

describe("Chart series selection", () => {
	it("adds and removes a keyword from the chart", async () => {
		renderPage({
			report: report({
				rows: [keywordRow(), keywordRow({ keyword: "second", pairId: 2 })],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove example keyword from the chart",
			})
		);
		expect(
			screen.getByRole("button", { name: "Add example keyword to the chart" })
		).toBeDefined();
	});

	it("draws the keywords the reader stored, not the top four", async () => {
		// The whole point of storing them: unticking a keyword used to survive
		// only until the next refresh, when the chart went back to the top four.
		// The stored list is per app and per storefront, because a pair id names a
		// keyword in one storefront and means nothing in another.
		renderPage({
			"/api/preferences": { [`chart:${trackedApp.id}:fr`]: "[2]" },
			report: report({
				rows: [
					keywordRow({ position: 1 }),
					keywordRow({ keyword: "second", pairId: 2, position: 2 }),
				],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");

		// "example keyword" outranks "second" and would be drawn by default, so
		// finding it off the chart is only explicable by the stored selection.
		await expect(
			screen.findByRole("button", {
				name: "Add example keyword to the chart",
			})
		).resolves.toBeDefined();
		expect(
			screen.getByRole("button", { name: "Remove second from the chart" })
		).toBeDefined();
	});

	it("draws the cached selection before the stored one arrives", async () => {
		// The tick boxes are live from the first frame, so a click can land before
		// the stored row does. If the selection is unknown at that moment the
		// chart shows the default four and a click is computed from those, which
		// then persists them over whatever the reader actually had. Reading the
		// cache during render is what closes that window.
		stubFetch({
			"/api/preferences": new Response("", { status: 500 }),
			report: report({
				rows: [
					keywordRow({ position: 1 }),
					keywordRow({ keyword: "second", pairId: 2, position: 2 }),
				],
			}),
			storefronts,
		});
		localStorage.setItem(`apprank.chart:${trackedApp.id}:fr`, "[2]");
		render(
			<MemoryRouter>
				<KeywordPerformance app={trackedApp} />
			</MemoryRouter>
		);
		await screen.findAllByText("example keyword");

		// "example keyword" outranks "second" and is drawn by default, so finding
		// it off the chart is only explicable by the cache having been read.
		expect(
			screen.getByRole("button", { name: "Add example keyword to the chart" })
		).toBeDefined();
	});

	it("refuses a fifth keyword and says why", async () => {
		renderPage({
			report: report({
				rows: [1, 2, 3, 4, 5].map((n) =>
					keywordRow({ keyword: `keyword ${n}`, pairId: n, position: n })
				),
			}),
			storefronts,
		});
		await screen.findAllByText("keyword 1");

		const fifth = screen.getByRole("button", {
			name: "Add keyword 5 to the chart",
		});
		expect(fifth.hasAttribute("disabled")).toBeTruthy();
		fireEvent.click(fifth);
		expect(document.querySelectorAll(".series")).toHaveLength(4);
		expect(screen.getByText(/4 of 4 keywords on the chart/u)).toBeDefined();

		// Freeing a slot re-opens the one that was refused.
		fireEvent.click(
			screen.getByRole("button", { name: "Remove keyword 1 from the chart" })
		);
		expect(
			screen
				.getByRole("button", { name: "Add keyword 5 to the chart" })
				.hasAttribute("disabled")
		).toBeFalsy();
	});

	it("keeps a hidden series in the legend, so it can be shown again", async () => {
		renderPage({
			report: report({
				rows: [keywordRow(), keywordRow({ keyword: "second", pairId: 2 })],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		const legend = document.querySelector(".legend") as HTMLElement;
		expect(document.querySelectorAll(".series")).toHaveLength(2);

		fireEvent.click(
			within(legend).getByRole("button", {
				name: "Hide example keyword from the chart",
			})
		);
		expect(document.querySelectorAll(".series")).toHaveLength(1);

		// The chip that hid the line is still there, and it is what brings it
		// back. Built from the drawn series, the legend deleted its own control.
		const restore = within(legend).getByRole("button", {
			name: "Show example keyword on the chart",
		});
		expect(restore.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(restore);
		expect(document.querySelectorAll(".series")).toHaveLength(2);
	});

	it("holds each series' colour when another one is hidden", async () => {
		renderPage({
			report: report({
				rows: [keywordRow(), keywordRow({ keyword: "second", pairId: 2 })],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");
		const legend = document.querySelector(".legend") as HTMLElement;
		const strokeOf = (name: string) =>
			within(legend)
				.getByRole("button", { name })
				.querySelector("line")
				?.getAttribute("stroke");
		const before = strokeOf("Hide second from the chart");

		fireEvent.click(
			within(legend).getByRole("button", {
				name: "Hide example keyword from the chart",
			})
		);
		// Slots follow membership, not what is drawn, so the surviving line keeps
		// the colour the reader had already learned it by.
		expect(strokeOf("Hide second from the chart")).toBe(before);
	});

	it("says the lines are hidden rather than that nothing was collected", async () => {
		renderPage({ report: report(), storefronts });
		await screen.findAllByText("example keyword");

		fireEvent.click(
			screen.getByRole("button", {
				name: "Hide example keyword from the chart",
			})
		);
		expect(screen.getByText(/Every line is hidden/u)).toBeDefined();
		expect(screen.queryByText(/No ranked observations/u)).toBeNull();
	});
});

describe("Popularity filter", () => {
	it("keeps only the keywords inside the chosen band", async () => {
		renderPage({
			report: report({
				rows: [
					keywordRow({ popularity: 90 }),
					keywordRow({ keyword: "quiet term", pairId: 2, popularity: 5 }),
					keywordRow({ keyword: "unmeasured", pairId: 3, popularity: null }),
				],
			}),
			storefronts,
		});
		await screen.findAllByText("example keyword");

		chooseOption("Filter by popularity", "Very high (85–100)");
		const table = screen.getByRole("table");
		expect(within(table).getByText("example keyword")).toBeDefined();
		expect(within(table).queryByText("quiet term")).toBeNull();
		// A keyword Apple gave no reading for cannot be placed in a band.
		expect(within(table).queryByText("unmeasured")).toBeNull();
	});
});

describe("CSV export", () => {
	it("links to the export for the current storefront and window", async () => {
		renderPage({ report: report(), storefronts });
		const link = (await screen.findByText("Export CSV")) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe(
			"/api/apps/424242/report.csv?storefront=fr&days=30"
		);
		expect(link.hasAttribute("download")).toBeTruthy();
	});
});

describe(Delta, () => {
	it("shows a rise towards rank 1 as an up arrow", () => {
		render(<Delta change={4} daysAgo={2} />);
		const el = screen.getByText(/4/u).closest(".delta") as HTMLElement;
		expect(el.className).toContain("delta-up");
		expect(el.textContent).toContain("2d");
	});

	it("shows a fall as a down arrow", () => {
		render(<Delta change={-6} daysAgo={1} />);
		expect(document.querySelector(".delta-down")?.textContent).toContain("6");
	});

	it("renders a dash when nothing moved", () => {
		render(<Delta change={null} daysAgo={null} />);
		expect(screen.getByTitle("no change in this window").textContent).toBe("—");
	});

	it("omits the age when it is unknown", () => {
		render(<Delta change={3} daysAgo={null} />);
		expect(document.querySelector(".delta-age")).toBeNull();
	});

	it("leads with the movement, not with how stale it is", () => {
		// The column is right-aligned on the number. Led by a variable-width age,
		// no two arrows in it shared an x.
		render(<Delta change={-6} daysAgo={12} />);
		const el = document.querySelector(".delta") as HTMLElement;
		expect(el.textContent?.indexOf("6")).toBeLessThan(
			el.textContent?.indexOf("12d") as number
		);
	});
});

describe(Meter, () => {
	it("fills proportionally and always prints the value", () => {
		render(<Meter label="Popularity" value={40} />);
		expect(screen.getByText("40")).toBeDefined();
		const fill = document.querySelector<HTMLElement>(".meter-fill");
		expect(fill?.style.width).toBe("40%");
	});

	it("clamps values beyond the scale", () => {
		render(<Meter label="Popularity" max={50} value={90} />);
		expect(
			document.querySelector<HTMLElement>(".meter-fill")?.style.width
		).toBe("100%");
	});

	it("reads out as no data when the value is missing", () => {
		render(<Meter label="Popularity" value={null} />);
		expect(screen.getByLabelText("Popularity: no data")).toBeDefined();
		expect(screen.getByText("—")).toBeDefined();
	});
});

describe(SummaryTiles, () => {
	it("shows the average with its movement and the extremes", () => {
		render(<SummaryTiles days={30} stats={report().stats} />);
		const hero = document.querySelector(".stat-hero") as HTMLElement;
		expect(within(hero).getByText("4")).toBeDefined();
		expect(hero.querySelector(".delta-up")).not.toBeNull();
		// "ranked of tracked" reads as a pair, not two loose numbers.
		expect(document.querySelector(".stat-pair")?.textContent).toContain(
			"1 of 2"
		);
	});

	it("marks a worsening average as a fall", () => {
		render(
			<SummaryTiles
				days={30}
				stats={{ ...report().stats, averageRankChange: -9 }}
			/>
		);
		expect(document.querySelector(".stat-hero .delta-down")).not.toBeNull();
	});

	it("dashes an average nobody has measured yet", () => {
		render(
			<SummaryTiles
				days={30}
				stats={{
					...report().stats,
					averageRank: null,
					averageRankChange: null,
					best: null,
					worst: null,
				}}
			/>
		);
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
		expect(document.querySelector(".stat-hero .delta")).toBeNull();
	});

	it("sizes the distribution bars against the largest bucket", () => {
		render(
			<SummaryTiles
				days={30}
				stats={{
					...report().stats,
					distribution: { beyond: 1, top100: 4, top25: 2, top5: 0 },
				}}
			/>
		);
		const bars = [...document.querySelectorAll<HTMLElement>(".dist-bar")];
		expect(bars).toHaveLength(4);
		// The empty bucket keeps a visible stub; the biggest fills the tile.
		expect(bars[0]?.style.height).toBe("4%");
		expect(bars[2]?.style.height).toBe("100%");
	});

	it("keeps the movement bar sane when nothing has moved", () => {
		render(
			<SummaryTiles
				days={30}
				stats={{
					...report().stats,
					movement: { down: 0, unchanged: 0, up: 0 },
				}}
			/>
		);
		const segs = [...document.querySelectorAll<HTMLElement>(".movement-seg")];
		expect(segs.every((s) => s.style.width === "0%")).toBeTruthy();
	});
});
