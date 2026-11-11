import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Suggestions } from "../src/pages/suggestions";
import { deferred, stubFetch, suggestion } from "./harness";

function promote(id: number, term: string) {
	return suggestion({
		id,
		payload: JSON.stringify({ seed: "seed term", storefront: "fr", term }),
		type: "promote_keyword",
	});
}

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

	it("says a failed request failed, not that nothing is pending", async () => {
		stubFetch({ suggestions: new Response("", { status: 401 }) });
		render(<Suggestions />);
		await expect(
			screen.findByText(/could not be loaded/u)
		).resolves.toBeDefined();
		expect(screen.queryByText(/Nothing pending/u)).toBeNull();
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

	it("keeps a row disabled while its own answer is still in flight", async () => {
		const held = deferred<unknown>();
		stubFetch({
			"suggestions/7": held.promise,
			"suggestions/8": new Response("", { status: 500 }),
			suggestions: [promote(7, "first term"), promote(8, "second term")],
		});
		render(<Suggestions />);
		const [first, second] = await screen.findAllByRole("button", {
			name: "Track it",
		});
		fireEvent.click(first as HTMLElement);
		fireEvent.click(second as HTMLElement);
		// The second answer fails and frees its own row. Held as one id, that
		// also re-enabled the first row mid-request, open to a double submit.
		await waitFor(() =>
			expect((second as HTMLElement).hasAttribute("disabled")).toBeFalsy()
		);
		expect((first as HTMLElement).hasAttribute("disabled")).toBeTruthy();
		held.resolve({});
	});

	it("shows a promotion missing a field as its payload instead of crashing", async () => {
		stubFetch({
			suggestions: [
				suggestion({
					id: 3,
					payload: '{"term":"half a payload","seed":"seed term"}',
					type: "promote_keyword",
				}),
			],
		});
		render(<Suggestions />);
		// No storefront to print: reading it threw in render, and with no error
		// boundary the whole dashboard went blank.
		await expect(screen.findByLabelText("Payload")).resolves.toHaveProperty(
			"textContent",
			'{"term":"half a payload","seed":"seed term"}'
		);
		expect(screen.queryByRole("button", { name: "Track it" })).toBeNull();
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
