import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Reviews } from "../src/pages/reviews";
import { deferred, review, settle, stubFetch, trackedApp } from "./harness";

describe("Reviews page", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("says so when there is no tracked app, without fetching", () => {
		const calls = stubFetch({});
		render(<Reviews app={null} />);
		expect(screen.getByText("No app is being tracked yet.")).toBeDefined();
		expect(calls).toStrictEqual([]);
	});

	it("shows a loading placeholder first", () => {
		stubFetch({ reviews: [] });
		render(<Reviews app={trackedApp} />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("explains the empty state", async () => {
		stubFetch({ reviews: [] });
		render(<Reviews app={trackedApp} />);
		await expect(
			screen.findByText(/Nothing collected yet/u)
		).resolves.toBeDefined();
	});

	it("says a failed request failed, not that nothing was collected", async () => {
		stubFetch({ reviews: new Response("", { status: 500 }) });
		render(<Reviews app={trackedApp} />);
		await expect(
			screen.findByText(/could not be loaded/u)
		).resolves.toBeDefined();
		expect(screen.queryByText(/Nothing collected yet/u)).toBeNull();
	});

	it("renders the star rating, tags and body", async () => {
		stubFetch({
			reviews: [
				review({ id: "review-1", rating: 4, title: "Solid" }),
				review({
					app_version: "1.0.0",
					author: "Reviewer Two",
					body: "Another neutral body.",
					id: "review-2",
					rating: null,
					reviewed_at: null,
					storefront_code: "us",
					title: "No rating",
				}),
			],
		});
		render(<Reviews app={trackedApp} />);
		await expect(screen.findByLabelText("4 stars")).resolves.toBeDefined();
		// Icons now, not characters, so the rating is counted by fill rather than
		// read out of the text. Five are always drawn, so a row keeps its width
		// whatever the rating, and the label carries the number for a screen
		// reader.
		const rated = screen.getByLabelText("4 stars");
		expect(rated.querySelectorAll("svg")).toHaveLength(5);
		expect(rated.querySelectorAll(".star-on")).toHaveLength(4);
		expect(screen.getByText("A neutral review body.")).toBeDefined();
	});

	it("draws an unrated review as five hollow stars", async () => {
		stubFetch({
			reviews: [review({ id: "review-2", rating: null, title: "No rating" })],
		});
		render(<Reviews app={trackedApp} />);
		const unrated = await screen.findByLabelText("Not rated");
		expect(unrated.querySelectorAll("svg")).toHaveLength(5);
		expect(unrated.querySelectorAll(".star-on")).toHaveLength(0);
	});

	it("counts one star in the singular", async () => {
		stubFetch({ reviews: [review({ rating: 1 })] });
		render(<Reviews app={trackedApp} />);
		await expect(screen.findByLabelText("1 star")).resolves.toBeDefined();
	});

	it("sums up the loaded ratings: the average and a bar per star", async () => {
		stubFetch({
			reviews: [
				review({ id: "a", rating: 5 }),
				review({ id: "b", rating: 5 }),
				review({ id: "c", rating: 2 }),
				review({ id: "d", rating: null }),
			],
		});
		render(<Reviews app={trackedApp} />);
		const summary = await screen.findByRole("region", {
			name: /Rating summary/u,
		});
		expect(
			within(summary).getByLabelText("Average 4.0 out of 5")
		).toBeDefined();
		expect(within(summary).getByText("from 3 rated reviews")).toBeDefined();
		// Each bar says its count in text, five rows from five stars down.
		const rows = summary.querySelectorAll(".rating-row");
		expect([...rows].map((r) => r.textContent)).toStrictEqual([
			"55 stars2",
			"44 stars0",
			"33 stars0",
			"22 stars1",
			"11 star0",
		]);
	});

	it("sizes each star's bar against the most common rating", async () => {
		stubFetch({
			reviews: [
				review({ id: "a", rating: 5 }),
				review({ id: "b", rating: 5 }),
				review({ id: "c", rating: 2 }),
			],
		});
		render(<Reviews app={trackedApp} />);
		const summary = await screen.findByRole("region", {
			name: /Rating summary/u,
		});
		const fills = summary.querySelectorAll<HTMLElement>(".rating-fill");
		expect(fills[0]?.style.width).toBe("100%");
		expect(fills[3]?.style.width).toBe("50%");
	});

	it("leaves the summary out when nothing loaded carries a rating", async () => {
		stubFetch({ reviews: [review({ rating: null })] });
		render(<Reviews app={trackedApp} />);
		await screen.findByLabelText("Not rated");
		expect(
			screen.queryByRole("region", { name: /Rating summary/u })
		).toBeNull();
	});

	it("keeps the feed's cap behind the title's trigger", async () => {
		stubFetch({ reviews: [review()] });
		render(<Reviews app={trackedApp} />);
		const trigger = await screen.findByRole("button", {
			name: "About Reviews",
		});
		expect(screen.queryByText(/latest 500 per storefront/u)).toBeNull();
		fireEvent.click(trigger);
		await expect(
			screen.findByText(/latest 500 per storefront/u)
		).resolves.toBeDefined();
	});

	it("splits author, storefront and version into their own tags", async () => {
		stubFetch({
			reviews: [review({ app_version: "1.0.0", storefront_code: "us" })],
		});
		render(<Reviews app={trackedApp} />);
		// The storefront names its region rather than echoing the code, and the
		// flag beside it is hidden from the accessibility tree.
		await expect(screen.findByText("United States")).resolves.toBeDefined();
		expect(screen.getByText("Reviewer One")).toBeDefined();
		expect(screen.getByText("Version 1.0.0")).toBeDefined();
		expect(screen.getByText("10 Jan 2026")).toBeDefined();
	});
});

describe("Reviews page across an app switch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the current app's reviews when the previous app's land late", async () => {
		const other = { ...trackedApp, id: 999 };
		const stale = deferred<unknown>();
		stubFetch({
			"/apps/999/reviews": [review({ id: "current", title: "Current app" })],
			reviews: stale.promise,
		});
		const view = render(<Reviews app={trackedApp} />);
		view.rerender(<Reviews app={other} />);
		await expect(screen.findByText("Current app")).resolves.toBeDefined();

		stale.resolve([review({ id: "stale", title: "Previous app" })]);
		await settle();
		expect(screen.queryByText("Previous app")).toBeNull();
		expect(screen.getByText("Current app")).toBeDefined();
	});

	it("shows the loading state, not the previous app's reviews, while loading", async () => {
		const pending = deferred<unknown>();
		stubFetch({
			"/apps/999/reviews": pending.promise,
			reviews: [review({ title: "Previous app" })],
		});
		const view = render(<Reviews app={trackedApp} />);
		await screen.findByText("Previous app");

		view.rerender(<Reviews app={{ ...trackedApp, id: 999 }} />);
		expect(screen.queryByText("Previous app")).toBeNull();
		expect(screen.getByText("Loading…")).toBeDefined();
		pending.resolve([]);
		await screen.findByText(/Nothing collected yet/u);
	});
});
