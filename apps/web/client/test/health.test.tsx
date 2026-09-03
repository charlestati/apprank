/* oxlint-disable vitest/max-expects -- the health page is a four-card
   dashboard; one populated render is asserted card by card rather than
   re-fetching the same payload four times. */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Health } from "../src/pages/health";
import { dataHealth, stubFetch } from "./harness";

const HOUR_MS = 3_600_000;

function statDetail(label: string): string {
	const card = screen.getByText(label).parentElement;
	return card?.querySelector(".tile-note")?.textContent ?? "";
}

function statValue(label: string): HTMLElement | null {
	const card = screen.getByText(label).parentElement;
	return card?.querySelector<HTMLElement>(".stat-value") ?? null;
}

describe("Health page", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a loading placeholder until the payload arrives", () => {
		stubFetch({ "health/data": dataHealth() });
		render(<Health />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("stays on the placeholder when the request fails", async () => {
		stubFetch({ "health/data": new Response("", { status: 500 }) });
		render(<Health />);
		await Promise.resolve();
		expect(screen.getByText("Loading…")).toBeDefined();
		expect(screen.queryByText("Data health")).toBeNull();
	});

	it("summarises a healthy day", async () => {
		stubFetch({
			"health/data": dataHealth({ collectedToday: 10, tier1Pairs: 10 }),
		});
		render(<Health />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statDetail("Coverage today")).toBe(
			"100% of Tier-1 pairs observed (10 Jan 2026)"
		);
		expect(statValue("Crawl rate")?.textContent).toBe("12.0");
		expect(statDetail("Crawl rate")).toBe("fetches/min, learned");
		expect(statValue("Throttle hits (24h)")?.getAttribute("style")).toBeNull();
		expect(screen.getByText("Clean. No errors recorded.")).toBeDefined();
	});

	it("reports zero coverage rather than dividing by zero", async () => {
		stubFetch({
			"health/data": dataHealth({ collectedToday: 0, tier1Pairs: 0 }),
		});
		render(<Health />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statDetail("Coverage today")).toBe(
			"0% of Tier-1 pairs observed (10 Jan 2026)"
		);
	});

	it("flags a paused crawl, throttling and ASC anomalies", async () => {
		stubFetch({
			"health/data": dataHealth({
				ascAnomalies: [
					{
						anomaly: "duplicate",
						processing_date: "2026-01-09",
						report_type: "APP_STORE_DOWNLOADS",
					},
				],
				errorsLast24h: [
					{
						endpoint: "itunes:charts",
						errorClass: "throttled",
						lastAt: Date.now() - 600_000,
						message: null,
						n: 4,
					},
					{
						endpoint: "ads:popularity",
						errorClass: "upstream_error",
						lastAt: Date.now() - 300_000,
						message: '{"error":{"code":"INVALID_VALUE"}}',
						n: 1,
					},
				],
				pacing: {
					lastErrorAt: 0,
					pauseUntil: Date.now() + HOUR_MS,
					ratePerMin: 3.5,
				},
			}),
		});
		render(<Health />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statDetail("Crawl rate")).toMatch(/^paused until /u);
		expect(statValue("Throttle hits (24h)")?.textContent).toBe("4");
		expect(statValue("Throttle hits (24h)")?.className).toContain("stat-bad");
		expect(statValue("ASC anomalies")?.className).toContain("stat-warn");
		// The class in words, the raw value for grepping, and the endpoint that
		// failed. A class on its own named no subject: nine throttles read as one
		// number that could not say whether the keyword crawl was affected.
		expect(screen.getByText("Apple reported a failure")).toBeDefined();
		expect(screen.getByText("upstream_error")).toBeDefined();
		expect(screen.getByText("ads:popularity")).toBeDefined();
		expect(screen.getByText("itunes:charts")).toBeDefined();
		// The upstream body is present but collapsed, not pasted into the layout.
		expect(
			screen.getByText('{"error":{"code":"INVALID_VALUE"}}').className
		).toContain("error-detail");
	});

	it("marks the classes where the day's data is gone, not merely retried", async () => {
		// A throttle is absorbed by the pause and the next run; an abandoned feed
		// is a day nobody recorded, and history cannot be backfilled. Rendering
		// them identically is what left the count unable to say whether to care.
		stubFetch({
			"health/data": dataHealth({
				errorsLast24h: [
					{
						endpoint: "itunes:lookup",
						errorClass: "pull_abandoned",
						lastAt: Date.now(),
						message: null,
						n: 1,
					},
					{
						endpoint: "itunes:search",
						errorClass: "throttled",
						lastAt: Date.now(),
						message: null,
						n: 9,
					},
				],
			}),
		});
		render(<Health />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();

		const abandoned = screen.getByText("A feed gave up today");
		expect(abandoned.querySelector(".error-cost")).not.toBeNull();
		const throttled = screen.getByText("Rate-limited by Apple");
		expect(throttled.querySelector(".error-cost")).toBeNull();
	});

	it("dashes the crawl rate when the collector has no pacing state yet", async () => {
		stubFetch({ "health/data": dataHealth({ pacing: null }) });
		render(<Health />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statValue("Crawl rate")?.textContent).toBe("–");
		expect(statDetail("Crawl rate")).toBe("fetches/min, learned");
	});
});
