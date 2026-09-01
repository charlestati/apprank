/* oxlint-disable vitest/require-top-level-describe -- the row factory is a
   file-wide precondition shared by the suites below. */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
    // A day we never collected has no mark at all — absence stays absence.
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
      "2026-01-02"
    );
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(container.querySelector(".chart-tip-date")?.textContent).toBe(
      "2026-01-01"
    );
    // The same reading reaches a screen reader, in the same words.
    expect(container.querySelector("[aria-live]")?.textContent).toBe(
      "2026-01-01: example keyword rank 4"
    );
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(container.querySelector(".chart-tip-date")).toBeNull();
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
    expect(container.querySelector(".marker-index")?.textContent).toBe("1");
    expect(container.querySelector(".marker-pin title")?.textContent).toBe(
      "2026-01-02 · version 3.2 · title, screenshots"
    );
  });

  it("says so when there is nothing to draw", () => {
    render(<RankSeriesChart series={[]} styleOf={solid} />);
    expect(
      screen.getByText(/No ranked observations in this window yet/u)
    ).toBeDefined();
  });
});
