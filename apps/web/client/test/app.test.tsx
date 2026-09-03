import { cleanup, render, screen } from "@testing-library/react";
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

	it("goes critical and singularises a lone error", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({
				collectedToday: 10,
				errorsLast24h: [
					{
						endpoint: "itunes:search",
						errorClass: "throttled",
						lastAt: 0,
						message: null,
						n: 1,
					},
				],
				tier1Pairs: 10,
			}),
		});
		render(<App />);
		await expect(
			screen.findByText("1 collection error")
		).resolves.toBeDefined();
		expect(lozengeClass()).toContain("lozenge-removed");
	});

	it("pluralises several errors", async () => {
		stubFetch({
			"/api/apps": [],
			"health/data": dataHealth({
				errorsLast24h: [
					{
						endpoint: "itunes:search",
						errorClass: "throttled",
						lastAt: 0,
						message: null,
						n: 2,
					},
					{
						endpoint: "itunes:charts",
						errorClass: "http_error",
						lastAt: 0,
						message: null,
						n: 1,
					},
				],
			}),
		});
		render(<App />);
		await expect(
			screen.findByText("3 collection errors")
		).resolves.toBeDefined();
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
		await expect(screen.findByText(/Inbox empty/u)).resolves.toBeDefined();
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
