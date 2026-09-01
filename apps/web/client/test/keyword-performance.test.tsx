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
import { stubFetch, trackedApp } from "./harness";

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
    expect([cells[4], cells[5], cells[7]]).toStrictEqual([
      "62",
      "3 / 12",
      "212",
    ]);
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

    fireEvent.change(screen.getByLabelText("Storefront"), {
      target: { value: "be" },
    });
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
      screen.getByText(/1 of 9 generic keywords are in the top 10/u)
    ).toBeDefined();
    expect(
      screen.getByText(/2 brand terms are counted separately/u)
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
    const lane = document.querySelector(".lane-focus") as HTMLElement;
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
    const cell = document.querySelector<HTMLElement>(".meter[title]");
    expect(cell?.title).toContain("hard (62/100, v1)");
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
    expect(screen.getByTitle("few known incumbents")).toBeDefined();
  });

  it("dashes a keyword that has never been scored", async () => {
    renderPage({
      report: report({ rows: [keywordRow({ difficulty: null })] }),
      storefronts,
    });
    await screen.findAllByText("example keyword");
    expect(
      screen.getByTitle("not scored yet — needs a ranked observation")
    ).toBeDefined();
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

    fireEvent.change(screen.getByLabelText("Filter by popularity"), {
      target: { value: "1" },
    });
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
    render(<SummaryTiles stats={report().stats} />);
    const hero = document.querySelector(".stat-hero") as HTMLElement;
    expect(within(hero).getByText("4")).toBeDefined();
    expect(hero.querySelector(".delta-up")).not.toBeNull();
    // "ranked of tracked" reads as a pair, not two loose numbers.
    expect(document.querySelector(".stat-pair")?.textContent).toContain("1/2");
  });

  it("marks a worsening average as a fall", () => {
    render(
      <SummaryTiles stats={{ ...report().stats, averageRankChange: -9 }} />
    );
    expect(document.querySelector(".stat-hero .delta-down")).not.toBeNull();
  });

  it("dashes an average nobody has measured yet", () => {
    render(
      <SummaryTiles
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
