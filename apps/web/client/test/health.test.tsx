/* oxlint-disable vitest/max-expects -- the health page is a four-card
   dashboard; one populated render is asserted card by card rather than
   re-fetching the same payload four times. */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataHealth } from "../src/api";
import { Health } from "../src/pages/health";
import { dataHealth, stubFetch } from "./harness";

const HOUR_MS = 3_600_000;

function errorRow(
	errorClass: string | null,
	endpoint: string,
	n = 1
): DataHealth["errorsLast24h"][number] {
	return {
		endpoint,
		errorClass,
		lastAt: Date.now(),
		loss: false,
		message: null,
		n,
	};
}

function dailyRun(startedAt: number): DataHealth["lastDailyRun"] {
	return {
		finishedAt: startedAt + 60_000,
		ok: true,
		queued: 4,
		startedAt,
		trigger: "cron",
	};
}

function statDetail(label: string): string {
	const card = screen.getByText(label).parentElement;
	return card?.querySelector(".tile-note")?.textContent ?? "";
}

function statValue(label: string): HTMLElement | null {
	const card = screen.getByText(label).parentElement;
	return card?.querySelector<HTMLElement>(".stat-value") ?? null;
}

async function renderLoop(over: Partial<DataHealth>) {
	stubFetch({ "health/data": dataHealth(over) });
	render(<Health onAcknowledge={() => {}} unread={0} />);
	await expect(screen.findByText("Data health")).resolves.toBeDefined();
	return statValue("Work loop");
}

describe("Health page", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a loading placeholder until the payload arrives", () => {
		stubFetch({ "health/data": dataHealth() });
		render(<Health onAcknowledge={() => {}} unread={0} />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("says the request failed instead of loading for ever", async () => {
		stubFetch({ "health/data": new Response("", { status: 500 }) });
		render(<Health onAcknowledge={() => {}} unread={0} />);
		// Awaited through the finder: a single microtask turn is over before the
		// stubbed response has been read, so an assertion made there only ever
		// saw the first render.
		await expect(
			screen.findByText(/could not be loaded/u)
		).resolves.toBeDefined();
		expect(screen.queryByText("Loading…")).toBeNull();
		expect(screen.queryByText("Data health")).toBeNull();
	});

	it("summarises a healthy day", async () => {
		stubFetch({
			"health/data": dataHealth({ collectedToday: 10, tier1Pairs: 10 }),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
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
		render(<Health onAcknowledge={() => {}} unread={0} />);
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
						loss: false,
						lastAt: Date.now() - 600_000,
						message: null,
						n: 4,
					},
					{
						endpoint: "ads:popularity",
						errorClass: "upstream_error",
						loss: true,
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
		render(<Health onAcknowledge={() => {}} unread={0} />);
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
						loss: true,
						lastAt: Date.now(),
						message: null,
						n: 1,
					},
					{
						endpoint: "itunes:search",
						errorClass: "throttled",
						loss: false,
						lastAt: Date.now(),
						message: null,
						n: 9,
					},
				],
			}),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();

		const abandoned = screen.getByText("A feed gave up today");
		expect(abandoned.querySelector(".error-cost")).not.toBeNull();
		const throttled = screen.getByText("Rate-limited by Apple");
		expect(throttled.querySelector(".error-cost")).toBeNull();
	});

	it("counts throttles at every endpoint, not only the first row", async () => {
		// Rows are grouped by class and endpoint, so one class arrives as several.
		stubFetch({
			"health/data": dataHealth({
				errorsLast24h: [
					errorRow("throttled", "itunes:search", 4),
					errorRow("throttled", "itunes:charts", 3),
				],
			}),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statValue("Throttle hits (24h)")?.textContent).toBe("7");
	});

	it("names the report findings in words, not as raw classes", async () => {
		stubFetch({
			"health/data": dataHealth({
				errorsLast24h: [
					errorRow("skipped_processing_date", "asc:report"),
					errorRow("duplicate_processing_date", "asc:report"),
					errorRow("stopped_due_to_inactivity", "asc:report"),
				],
			}),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(screen.getByText("Apple skipped a report day")).toBeDefined();
		expect(
			screen.getByText("Apple delivered a report day twice")
		).toBeDefined();
		expect(screen.getByText("Apple stopped an unpolled report")).toBeDefined();
	});

	it("says whether an upstream message is expanded", async () => {
		stubFetch({
			"health/data": dataHealth({
				errorsLast24h: [
					{
						endpoint: "ads:popularity",
						errorClass: "upstream_error",
						lastAt: Date.now(),
						loss: true,
						message: "upstream body",
						n: 1,
					},
				],
			}),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
		const toggle = await screen.findByRole("button", { name: "upstream body" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});

	it("colours the all-clear with the theme's success text token", async () => {
		// The page once named a token theme.css never defined, so the all-clear
		// silently fell back to the body colour. Vitest serves CSS empty, so the
		// test cannot read the theme and names the token instead.
		stubFetch({ "health/data": dataHealth({ errorsLast24h: [] }) });
		render(<Health onAcknowledge={() => {}} unread={0} />);
		const cell = await screen.findByText("Clean. No errors recorded.");
		expect(cell.style.color).toBe("var(--ds-text-success)");
	});

	it("dashes the crawl rate when the collector has no pacing state yet", async () => {
		stubFetch({ "health/data": dataHealth({ pacing: null }) });
		render(<Health onAcknowledge={() => {}} unread={0} />);
		await expect(screen.findByText("Data health")).resolves.toBeDefined();
		expect(statValue("Crawl rate")?.textContent).toBe("–");
		expect(statDetail("Crawl rate")).toBe("fetches/min, learned");
	});

	it("names a row with no class, rather than leaving the cell empty", async () => {
		stubFetch({
			"health/data": dataHealth({
				errorsLast24h: [errorRow(null, "itunes:search")],
			}),
		});
		render(<Health onAcknowledge={() => {}} unread={0} />);
		await expect(
			screen.findByText("Unclassified error")
		).resolves.toBeDefined();
		expect(document.querySelector(".error-class-raw")).toBeNull();
	});

	describe("last daily job", () => {
		it("shows the time alone for a run that started today", async () => {
			stubFetch({
				"health/data": dataHealth({ lastDailyRun: dailyRun(Date.now()) }),
			});
			render(<Health onAcknowledge={() => {}} unread={0} />);
			await expect(screen.findByText("Data health")).resolves.toBeDefined();
			expect(statValue("Last daily job")?.textContent).toMatch(
				/^\d{2}:\d{2}$/u
			);
			expect(statValue("Last daily job")?.className).not.toContain("stat-bad");
			expect(statDetail("Last daily job")).toBe("completed · cron · queued 4");
		});

		it("dates and flags a run from three days ago", async () => {
			// A completed run of any age is what the server sends. Shown as a bare
			// clock time it read as this morning's, in the neutral colour.
			const started = Date.now() - 72 * HOUR_MS;
			stubFetch({
				"health/data": dataHealth({ lastDailyRun: dailyRun(started) }),
			});
			render(<Health onAcknowledge={() => {}} unread={0} />);
			await expect(screen.findByText("Data health")).resolves.toBeDefined();
			const value = statValue("Last daily job");
			expect(value?.textContent).toContain(String(new Date(started).getDate()));
			expect(value?.textContent).toMatch(/[a-z]{3}/iu);
			expect(value?.className).toContain("stat-bad");
			expect(statDetail("Last daily job")).toBe(
				"no run in the last 26 hours · completed · cron · queued 4"
			);
		});
	});

	describe("work loop", () => {
		const MIN_MS = 60_000;
		const daily = (startedAt: number, queued: number | null) => ({
			finishedAt: startedAt + MIN_MS,
			ok: true,
			queued,
			startedAt,
			trigger: "cron",
		});

		it("stays neutral when it has been idle for hours with nothing queued", async () => {
			// The credentialed Worker drains its few daily tasks and parks; a
			// six-hour-old heartbeat is the normal afternoon, not a fault.
			const now = Date.now();
			const value = await renderLoop({
				lastDailyRun: daily(now - 400 * MIN_MS, 4),
				loop: { at: now - 395 * MIN_MS, didWork: true, queued: 0 },
			});
			expect(value?.textContent).toBe("395m");
			expect(value?.className).not.toContain("stat-bad");
			expect(statDetail("Work loop")).toBe(
				"since last tick · idle, nothing queued"
			);
		});

		it("turns red when queued work has gone untouched past the watchdog", async () => {
			const value = await renderLoop({
				loop: {
					at: Date.now() - 30 * MIN_MS,
					didWork: true,
					queued: 2,
					tasks: { asc_poll: 2 },
				},
			});
			expect(value?.className).toContain("stat-bad");
			expect(statDetail("Work loop")).toBe("since last tick · asc_poll ×2");
		});

		it("stays neutral while queued work is still inside the watchdog window", async () => {
			const value = await renderLoop({
				loop: { at: Date.now() - 5 * MIN_MS, didWork: true, queued: 2 },
			});
			expect(value?.className).not.toContain("stat-bad");
		});

		it("turns red when a daily run queued work that no tick followed", async () => {
			// The heartbeat says the queue was empty, but only as of a tick that
			// predates the run: the run's tasks are what the loop never picked up.
			const now = Date.now();
			const value = await renderLoop({
				lastDailyRun: daily(now - 60 * MIN_MS, 4),
				loop: { at: now - 120 * MIN_MS, didWork: true, queued: 0 },
			});
			expect(value?.className).toContain("stat-bad");
			expect(statDetail("Work loop")).toBe("since last tick · 4 queued");
		});

		it("stays neutral during a backoff pause, which parks the loop on purpose", async () => {
			const now = Date.now();
			const value = await renderLoop({
				loop: { at: now - 60 * MIN_MS, didWork: true, queued: 3 },
				pacing: { lastErrorAt: now, pauseUntil: now + HOUR_MS, ratePerMin: 12 },
			});
			expect(value?.className).not.toContain("stat-bad");
		});
	});
});
