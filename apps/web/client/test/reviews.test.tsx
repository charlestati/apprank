import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Reviews } from "../src/pages/reviews";
import { review, stubFetch, trackedApp } from "./harness";

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

	it("treats a failed request as an empty list", async () => {
		stubFetch({ reviews: new Response("", { status: 500 }) });
		render(<Reviews app={trackedApp} />);
		await expect(
			screen.findByText(/Nothing collected yet/u)
		).resolves.toBeDefined();
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
		const unrated = await screen.findByLabelText("? stars");
		expect(unrated.querySelectorAll("svg")).toHaveLength(5);
		expect(unrated.querySelectorAll(".star-on")).toHaveLength(0);
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
