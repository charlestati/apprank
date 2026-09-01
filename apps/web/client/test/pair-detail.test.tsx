import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairDetail } from "../src/pages/pair-detail";
import {
  APP_ID,
  RIVAL_ID,
  competitorPoint,
  historyPoint,
  stubFetch,
  trackedApp,
} from "./harness";

function renderPair(
  app: typeof trackedApp | null,
  state?: { keyword: string; storefront: string }
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/pairs/7", state }]}>
      <Routes>
        <Route element={<PairDetail app={app} />} path="/pairs/:pairId" />
      </Routes>
    </MemoryRouter>
  );
}

describe("PairDetail page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the pair id when no keyword came along in router state", async () => {
    stubFetch({ history: [], competitors: [] });
    renderPair(trackedApp);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Pair 7"
    );
    await expect(
      screen.findByText("No competitor data yet.")
    ).resolves.toBeDefined();
  });

  it("titles the page with the keyword and storefront from router state", () => {
    stubFetch({ history: [], competitors: [] });
    renderPair(trackedApp, { keyword: "example keyword", storefront: "fr" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "“example keyword” · FR"
    );
  });

  it("shows a loading placeholder until the history arrives", () => {
    stubFetch({ history: [], competitors: [] });
    renderPair(trackedApp);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("stays in the loading state and issues no request without a tracked app", () => {
    const calls = stubFetch({ history: [], competitors: [] });
    renderPair(null);
    expect(screen.getByText("Loading…")).toBeDefined();
    expect(calls).toStrictEqual([]);
    expect(
      screen.getByText(/Rank of the tracked app in the top 200/u)
    ).toBeDefined();
  });

  it("renders the chart once the history resolves", async () => {
    stubFetch({
      competitors: [],
      history: [
        historyPoint({ observed_date: "2026-01-01", position: 4 }),
        historyPoint({ observed_date: "2026-01-02", position: 5 }),
      ],
    });
    renderPair(trackedApp);
    await expect(
      screen.findByRole("img", {
        name: /Rank history for 1 keyword over 2 days, 2026-01-01 to 2026-01-02/u,
      })
    ).resolves.toBeDefined();
  });

  it("falls back to an empty chart and board when both requests fail", async () => {
    stubFetch({
      competitors: new Response("", { status: 500 }),
      history: new Response("", { status: 500 }),
    });
    renderPair(trackedApp);
    await expect(
      screen.findByText(/No ranked observations in this window yet/u)
    ).resolves.toBeDefined();
    expect(screen.getByText("No competitor data yet.")).toBeDefined();
  });

  it("ranks the latest top-10 and scores presence over the window", async () => {
    stubFetch({
      competitors: [
        competitorPoint({ observed_date: "2026-01-01", position: 1 }),
        competitorPoint({
          app_id: APP_ID,
          current_name: "Tracked App",
          observed_date: "2026-01-01",
          position: 2,
        }),
        competitorPoint({ observed_date: "2026-01-02", position: 2 }),
        competitorPoint({
          app_id: APP_ID,
          current_name: "Tracked App",
          observed_date: "2026-01-02",
          position: 1,
        }),
        competitorPoint({
          app_id: 606_060,
          current_name: null,
          observed_date: "2026-01-02",
          position: 3,
        }),
      ],
      history: [],
    });
    renderPair(trackedApp);
    await expect(screen.findByText("Tracked App")).resolves.toBeDefined();
    const cells = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent));
    expect(cells).toStrictEqual([
      ["1", "Tracked App", "100%"],
      ["2", "Rival App", "100%"],
      ["3", "606060", "50%"],
    ]);
    // The tracked app's own row is highlighted.
    expect(screen.getAllByRole("row")[1]?.className).toBe("row-self");
    expect(RIVAL_ID).toBe(515_151);
  });
});
