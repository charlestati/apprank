import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app";
import {
	chooseOption,
	dataHealth,
	deferred,
	settle,
	stubFetch,
	trackedApp,
} from "./harness";

const lossAt5000 = dataHealth({
	collectedToday: 10,
	errorsLast24h: [
		{
			endpoint: "itunes:charts",
			errorClass: "pull_abandoned",
			lastAt: 5000,
			loss: true,
			message: null,
			n: 3,
		},
	],
	lostLast24h: 3,
	tier1Pairs: 10,
});

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

	it("adopts the stored language without writing it back", async () => {
		// The server copy wins over this browser's guess, and adopting it is not
		// a choice: echoing it back would only ever be a chance to clobber it.
		const calls = stubFetch({
			"/api/apps": [],
			"/api/preferences": { lang: "fr" },
			"health/data": dataHealth(),
		});
		render(<App />);
		await expect(
			screen.findByText("Performance des mots-clés")
		).resolves.toBeDefined();
		expect(localStorage.getItem("apprank.lang")).toBe("fr");
		expect(calls).not.toContain("/api/preferences/lang");
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

	it("starts its four requests together, not one after another", () => {
		const calls = stubFetch({ "/api/apps": [], "health/data": dataHealth() });
		render(<App />);
		// Read before anything has answered: awaited in sequence, only the first
		// would have left yet, and the report waited on three round trips.
		expect(calls.toSorted()).toStrictEqual([
			"/api/apps",
			"/api/health/data",
			"/api/me",
			"/api/preferences",
		]);
	});

	it("does not claim nothing is tracked while the app list is in flight", async () => {
		const apps = deferred<unknown>();
		stubFetch({ "/api/apps": apps.promise, "health/data": dataHealth() });
		render(<App />);
		await settle();
		// An empty list and an unanswered one were the same [] and printed the
		// same sentence, on every load.
		expect(screen.queryByText("No app is being tracked yet.")).toBeNull();
		expect(screen.getByText("Loading…")).toBeDefined();

		apps.resolve([]);
		await expect(
			screen.findByText("No app is being tracked yet.")
		).resolves.toBeDefined();
	});

	it("says the app list failed, not that nothing is tracked", async () => {
		stubFetch({
			"/api/apps": new Response("", { status: 500 }),
			"health/data": dataHealth(),
		});
		render(<App />);
		await expect(
			screen.findByText(/app list could not be loaded/u)
		).resolves.toBeDefined();
		expect(screen.queryByText("No app is being tracked yet.")).toBeNull();
	});

	it("keeps the badge cleared when it was acknowledged on another machine", async () => {
		// Nothing in this browser's cache: only the stored row knows.
		stubFetch({
			"/api/apps": [],
			"/api/preferences": { "health:ack": "5000" },
			"health/data": lossAt5000,
		});
		render(<App />);
		await expect(screen.findByText("Complete")).resolves.toBeDefined();
		await settle();
		expect(document.querySelector(".nav-badge")).toBeNull();
		expect(localStorage.getItem("apprank.health:ack")).toBe("5000");
	});

	it("badges again for a loss newer than the stored acknowledgement", async () => {
		stubFetch({
			"/api/apps": [],
			"/api/preferences": { "health:ack": "4000" },
			"health/data": lossAt5000,
		});
		render(<App />);
		await expect(screen.findByText("Complete")).resolves.toBeDefined();
		await settle();
		expect(document.querySelector(".nav-badge")?.textContent).toBe("3");
	});

	it("does not let a late preferences answer undo a choice just made", async () => {
		const second = { ...trackedApp, current_name: "Second App", id: 777 };
		const prefs = deferred<unknown>();
		stubFetch({
			"/api/apps": [trackedApp, second],
			"/api/preferences": prefs.promise,
			// The write the choice makes; listed so it does not fall to a 404.
			"preferences/app": {},
			"health/data": dataHealth(),
			storefronts: [],
		});
		render(<App />);
		await expect(screen.findByLabelText("Application")).resolves.toBeDefined();
		chooseOption("Application", "Second App");

		// The read left before the click and still names the first app.
		prefs.resolve({ app: String(trackedApp.id) });
		await settle();
		expect(localStorage.getItem("apprank.app")).toBe("777");
		expect(screen.getByLabelText("Application").textContent).toContain(
			"Second App"
		);
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
