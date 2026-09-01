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

	it("renders the star rating, meta line and body", async () => {
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
		expect(screen.getByLabelText("4 stars").textContent).toBe("★★★★☆");
		// A missing rating renders five empty stars and an unknown label.
		expect(screen.getByLabelText("? stars").textContent).toBe("☆☆☆☆☆");
		expect(screen.getByText("A neutral review body.")).toBeDefined();
		expect(
			screen.getByText(/Reviewer Two · US · v1\.0\.0/u).textContent?.trim()
		).toBe("Reviewer Two · US · v1.0.0 ·");
	});
});
