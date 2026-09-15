import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app";
import { dataHealth, stubFetch, trackedApp } from "./harness";

function status(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".status-link");
}

function lozengeClass(): string {
	return status()?.querySelector(".lozenge")?.className ?? "";
}

describe("App shell", () => {
	// The shell fires two requests on mount and mounts its child page when the
	// first resolves, so requests can still be in flight when a test ends.
	// Unmount, then leave an inert stub in place rather than restoring the real
	// fetch, since a restored fetch would reach the network.
	afterEach(() => {
		cleanup();
		stubFetch({ "*": [] });
		window.history.pushState({}, "", "/");
	});

	it("renders the wordmark and the primary navigation", async () => {
		stubFetch({ "/api/apps": [], "health/data": dataHealth() });
		render(<App />);
		await expect(screen.findByLabelText("AppRank")).resolves.toBeDefined();
		// The collection-status link sits between the wordmark and the nav.
		const nav = screen.getByRole("navigation", { name: "Sections" });
		expect(
			[...nav.querySelectorAll("a")].map((a) => a.textContent)
		).toStrictEqual([
			"Keyword performance",
			"Reviews",
			"Suggestions",
			"Data health",
		]);
	});

	it("names the first tracked app in the top bar", async () => {
		stubFetch({
			"/api/apps": [trackedApp],
			"health/data": dataHealth(),
			keywords: [],
		});
		render(<App />);
		await expect(screen.findByText("Tracked App")).resolves.toBeDefined();
	});

	it("hides the collection status when the health request fails", async () => {
		stubFetch({
			"/api/apps": new Response("", { status: 500 }),
			"health/data": new Response("", { status: 500 }),
		});
		render(<App />);
		await expect(
			screen.findByText("Keyword performance")
		).resolves.toBeDefined();
		expect(status()).toBeNull();
	});

	it("goes green once every Tier-1 pair has been collected", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({ collectedToday: 10, tier1Pairs: 10 }),
		});
		render(<App />);
		await expect(screen.findByText("Complete")).resolves.toBeDefined();
		// Named, not bare: "10/10" alone did not say what was counted.
		expect(status()?.textContent).toContain("10 of 10 searches today");
		expect(lozengeClass()).toContain("lozenge-success");
	});

	it("warns while the day is still incomplete", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({ collectedToday: 4, tier1Pairs: 10 }),
		});
		render(<App />);
		await expect(screen.findByText("Collecting")).resolves.toBeDefined();
		expect(lozengeClass()).toContain("lozenge-inprogress");
	});

	it("keeps failures out of the topbar entirely", async () => {
		// A count that was red every day of the first twelve stopped being read.
		// Progress belongs here; what went wrong belongs where there is room to
		// say what it was.
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({
				collectedToday: 10,
				errorsLast24h: [
					{
						endpoint: "itunes:charts",
						errorClass: "pull_abandoned",
						loss: true,
						lastAt: 5000,
						message: null,
						n: 3,
					},
				],
				lostLast24h: 3,
				tier1Pairs: 10,
			}),
		});
		render(<App />);
		await expect(screen.findByText("Complete")).resolves.toBeDefined();
		expect(lozengeClass()).not.toContain("lozenge-removed");
		expect(status()?.textContent).not.toContain("3");
	});

	it("badges the sidebar with what was lost, and clears on request", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({
				collectedToday: 10,
				errorsLast24h: [
					{
						endpoint: "itunes:charts",
						errorClass: "pull_abandoned",
						loss: true,
						lastAt: 5000,
						message: null,
						n: 3,
					},
				],
				lostLast24h: 3,
				tier1Pairs: 10,
			}),
		});
		render(<App />);
		const badge = await screen.findByLabelText(
			"3 observations lost in the last 24 hours"
		);
		expect(badge.textContent).toBe("3");

		fireEvent.click(screen.getByRole("link", { name: /Data health/u }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Mark as seen" })
		);
		expect(
			screen.queryByLabelText("3 observations lost in the last 24 hours")
		).toBeNull();
	});

	it("does not badge for throttles, which the next run absorbs", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({
				collectedToday: 10,
				errorsLast24h: [
					{
						endpoint: "itunes:search",
						errorClass: "throttled",
						loss: false,
						lastAt: 5000,
						message: null,
						n: 40,
					},
				],
				lostLast24h: 0,
				tier1Pairs: 10,
			}),
		});
		render(<App />);
		await expect(screen.findByText("Complete")).resolves.toBeDefined();
		expect(document.querySelector(".nav-badge")).toBeNull();
	});

	it("shows zero coverage without a divide-by-zero when nothing is due", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({ collectedToday: 0, tier1Pairs: 0 }),
		});
		render(<App />);
		await expect(screen.findByText("Collecting")).resolves.toBeDefined();
		expect(status()?.textContent).toContain("0 of 0 searches today");
	});

	it("routes to the reviews page", async () => {
		window.history.pushState({}, "", "/reviews");
		stubFetch({
			"/api/apps": [trackedApp],
			"health/data": dataHealth(),
			reviews: [],
		});
		render(<App />);
		await expect(
			screen.findByRole("heading", { level: 1 })
		).resolves.toHaveProperty("textContent", "Reviews");
	});

	it("routes to the suggestions page", async () => {
		window.history.pushState({}, "", "/suggestions");
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth(),
			"/api/suggestions": [],
		});
		render(<App />);
		await expect(screen.findByText(/Nothing pending/u)).resolves.toBeDefined();
	});

	it("routes to the data-health page", async () => {
		window.history.pushState({}, "", "/health");
		stubFetch({ "/api/apps": [], "health/data": dataHealth() });
		render(<App />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
	});

	it("routes to a pair detail page", async () => {
		window.history.pushState({}, "", "/pairs/7");
		stubFetch({
			"/api/apps": [trackedApp],
			competitors: [],
			"health/data": dataHealth(),
			history: [],
		});
		render(<App />);
		await expect(
			screen.findByText("No competitor data yet.")
		).resolves.toBeDefined();
	});
});
