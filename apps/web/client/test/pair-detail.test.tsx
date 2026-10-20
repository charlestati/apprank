import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairDetail } from "../src/pages/pair-detail";
import {
	APP_ID,
	RIVAL_ID,
	competitorPoint,
	deferred,
	historyPoint,
	settle,
	stubFetch,
	trackedApp,
} from "./harness";

/** Moves to another pair without remounting the page, as a link would. */
function GoTo({ to }: { to: string }) {
	const navigate = useNavigate();
	return (
		<button onClick={() => navigate(to)} type="button">
			go
		</button>
	);
}

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
		vi.useRealTimers();
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

	it("renders the chart once the history resolves, out to today", async () => {
		// Only Date is faked: the finders still need real timers to poll.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-04T12:00:00Z"));
		stubFetch({
			competitors: [],
			history: [
				historyPoint({ observed_date: "2026-01-01", position: 4 }),
				historyPoint({ observed_date: "2026-01-02", position: 5 }),
			],
		});
		renderPair(trackedApp);
		// Two days nobody collected since the last point: the axis runs on to
		// the end of the requested window, so the line visibly stops short of it
		// instead of the chart ending wherever collection did.
		await expect(
			screen.findByRole("img", {
				name: /Rank history for 1 keyword over 4 days, 2026-01-01 to 2026-01-04/u,
			})
		).resolves.toBeDefined();
	});

	it("marks the days collection failed, apart from days never collected", async () => {
		stubFetch({
			competitors: [],
			history: {
				fetchErrors: [
					{ count: 2, date: "2026-01-03", errorClass: "throttled" },
				],
				points: [
					historyPoint({ observed_date: "2026-01-01", position: 4 }),
					historyPoint({ observed_date: "2026-01-02", position: 5 }),
				],
				window: { from: "2026-01-01", to: "2026-01-05" },
			},
		});
		const { container } = renderPair(trackedApp);
		await expect(
			screen.findByRole("img", {
				name: /over 5 days, 2026-01-01 to 2026-01-05/u,
			})
		).resolves.toBeDefined();
		expect(container.querySelectorAll(".error-mark")).toHaveLength(1);
	});

	it("keeps the current pair's history when the previous pair's lands late", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-02-03T12:00:00Z"));
		const stale = deferred<unknown>();
		stubFetch({
			"/pairs/8/history": [
				historyPoint({ observed_date: "2026-02-01", position: 3 }),
			],
			competitors: [],
			history: stale.promise,
		});
		render(
			<MemoryRouter initialEntries={["/pairs/7"]}>
				<Routes>
					<Route
						element={
							<>
								<GoTo to="/pairs/8" />
								<PairDetail app={trackedApp} />
							</>
						}
						path="/pairs/:pairId"
					/>
				</Routes>
			</MemoryRouter>
		);
		fireEvent.click(screen.getByRole("button", { name: "go" }));
		await expect(
			screen.findByRole("img", { name: /2026-02-01/u })
		).resolves.toBeDefined();

		stale.resolve([historyPoint({ observed_date: "2026-01-20", position: 9 })]);
		await settle();
		expect(screen.queryByRole("img", { name: /2026-01-20/u })).toBeNull();
		expect(screen.getByRole("img", { name: /2026-02-01/u })).toBeDefined();
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
