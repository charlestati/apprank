import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Suggestions } from "../src/pages/suggestions";
import { stubFetch, suggestion } from "./harness";

describe("Suggestions page", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a loading placeholder first", () => {
		stubFetch({ suggestions: [] });
		render(<Suggestions />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("explains the empty inbox", async () => {
		stubFetch({ suggestions: [] });
		render(<Suggestions />);
		await expect(screen.findByText(/Nothing pending/u)).resolves.toBeDefined();
	});

	it("treats a failed request as an empty inbox", async () => {
		stubFetch({ suggestions: new Response("", { status: 401 }) });
		render(<Suggestions />);
		await expect(screen.findByText(/Nothing pending/u)).resolves.toBeDefined();
	});

	it("offers a proposed keyword as a decision, not as JSON", async () => {
		stubFetch({
			suggestions: [
				suggestion({
					id: 7,
					payload: JSON.stringify({
						appId: 1,
						language: "fr",
						locale: "fr-FR",
						relevance: 31,
						seed: "météo locale",
						storefront: "fr",
						term: "météo locale gratuite",
					}),
					type: "promote_keyword",
				}),
			],
		});
		render(<Suggestions />);
		await expect(
			screen.findByText("météo locale gratuite")
		).resolves.toBeDefined();
		expect(screen.getByText(/alongside météo locale, in FR/u)).toBeDefined();
		expect(screen.getByRole("button", { name: "Track it" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
	});

	it("removes the row once the answer reaches the server", async () => {
		// The server has already moved it out of "pending", so a re-fetch would
		// cost a round trip to learn what the response already said.
		const calls = stubFetch({
			// Listed first: the harness matches on suffix, so the shorter pattern
			// would otherwise never let this one be reached.
			"suggestions/7": {},
			suggestions: [
				suggestion({
					id: 7,
					payload: JSON.stringify({
						appId: 1,
						language: "fr",
						locale: "fr-FR",
						relevance: 31,
						seed: "météo locale",
						storefront: "fr",
						term: "météo locale gratuite",
					}),
					type: "promote_keyword",
				}),
			],
		});
		render(<Suggestions />);
		fireEvent.click(await screen.findByRole("button", { name: "Track it" }));
		await waitFor(() =>
			expect(screen.queryByText("météo locale gratuite")).toBeNull()
		);
		expect(calls).toContain("/api/suggestions/7");
	});

	it("keeps the row when the answer never reaches the server", async () => {
		// An answer that failed must not look like one that landed: the operator
		// would believe a keyword is being collected when it is not.
		stubFetch({
			"suggestions/7": new Response("", { status: 500 }),
			suggestions: [
				suggestion({
					id: 7,
					payload: JSON.stringify({
						seed: "météo locale",
						storefront: "fr",
						term: "météo locale gratuite",
					}),
					type: "promote_keyword",
				}),
			],
		});
		render(<Suggestions />);
		fireEvent.click(await screen.findByRole("button", { name: "Track it" }));
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Track it" })
					.hasAttribute("disabled")
			).toBeFalsy()
		);
		expect(screen.getByText("météo locale gratuite")).toBeDefined();
	});

	it("lists the type and raw payload of each pending suggestion", async () => {
		stubFetch({
			suggestions: [
				suggestion({ id: 1 }),
				suggestion({
					id: 2,
					payload: '{"keyword":"another keyword"}',
					type: "promote_storefront",
				}),
			],
		});
		render(<Suggestions />);
		await expect(screen.findByText("promote_keyword")).resolves.toBeDefined();
		expect(screen.getByText("promote_storefront")).toBeDefined();
		expect(screen.getByText('{"keyword":"another keyword"}')).toBeDefined();
		expect(screen.queryByText(/Nothing pending/u)).toBeNull();
	});
});
