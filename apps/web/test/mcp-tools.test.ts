/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { clearReferenceCache } from "../src/mcp/reference";
import { CAPS, clamp, summariseSeries } from "../src/mcp/tools";
import { findGaps } from "../src/queries/coverage";
import {
	APP_ID,
	RIVAL_ID,
	USER_ID,
	isoDay,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedRanking,
	seedTrackedApp,
} from "./fixtures";
import {
	callTool,
	fetchMcp,
	issueCredential,
	jsonRpcBody,
	mcpRequest,
	toolPayload,
} from "./mcp-fixtures";

function walled() {
	return {
		...env,
		ALLOW_UNAUTHENTICATED: "true",
		MCP_ENABLED: "true",
	} as never;
}

async function token(): Promise<string> {
	const { token: t } = await issueCredential({ userId: USER_ID });
	return t;
}

beforeEach(async () => {
	await resetDb();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM mcp_tool_call"),
		env.DB.prepare("DELETE FROM mcp_credential"),
	]);
	clearReferenceCache();
	await seedCatalog();
	await seedTrackedApp();
	await seedKeywords();
});

describe(clamp, () => {
	it("clamps rather than trusts, in both directions", () => {
		expect(clamp(9999, 100)).toBe(100);
		expect(clamp(0, 100)).toBe(1);
		expect(clamp(-5, 100)).toBe(1);
		expect(clamp(undefined, 100)).toBe(100);
		expect(clamp(12.7, 100)).toBe(12);
	});
});

describe("row caps", () => {
	it("enforces the cap and says the answer was truncated", async () => {
		// Thirty days of observations on one pair, asked for with a limit of 5.
		for (let i = 0; i < 30; i += 1) {
			await seedRanking({
				date: isoDay(i),
				entries: [[i + 1, APP_ID]],
				id: 100 + i,
				pairId: 1,
			});
		}
		const res = await fetchMcp(
			mcpRequest(
				callTool("get_rank_history", {
					detail: "daily",
					from: isoDay(40),
					limit: 5,
					pairId: 1,
				}),
				await token()
			),
			walled()
		);
		const { data } = await toolPayload(res);
		expect(data.points as unknown[]).toHaveLength(5);
		expect((data.provenance as { truncated: boolean }).truncated).toBeTruthy();
	});

	it("refuses a limit above the schema's maximum before the tool runs", async () => {
		const res = await fetchMcp(
			mcpRequest(
				callTool("get_rank_history", {
					limit: CAPS.history + 1,
					pairId: 1,
				}),
				await token()
			),
			walled()
		);
		// Schema validation rejects it before dispatch, so the reply is a
		// validation error rather than a tool result, which is the point. The cap
		// is part of the contract the client is handed, not a silent trim.
		const body = await jsonRpcBody<{
			result?: { content?: { text: string }[]; isError?: boolean };
		}>(res);
		expect(body.result?.isError).toBeTruthy();
		expect(body.result?.content?.[0]?.text).toContain("Input validation");
		const logged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM mcp_tool_call"
		).first<{ n: number }>();
		expect(logged?.n).toBe(0);
	});
});

describe("provenance", () => {
	it("reports gaps and the throttling behind them, not just a thinner series", async () => {
		// Ten days tracked; three consecutive days missing, with throttles recorded
		// against the pair over exactly those days.
		for (const day of [9, 8, 7, 6, 2, 1, 0]) {
			await seedRanking({
				date: isoDay(day),
				entries: [[5, APP_ID]],
				id: 200 + day,
				pairId: 1,
			});
		}
		for (const day of [5, 4, 3]) {
			await env.DB.prepare(
				`INSERT INTO fetch_error (fetched_at, endpoint, params, http_status, error_class, message)
         VALUES (?1, 'itunes:search', ?2, 403, 'throttled', 'Rate limit has been exceeded')`
			)
				.bind(
					Date.parse(`${isoDay(day)}T12:00:00Z`),
					"example keyword|fr|fr-FR"
				)
				.run();
		}

		const res = await fetchMcp(
			mcpRequest(
				callTool("get_rank_history", {
					from: isoDay(9),
					pairId: 1,
					to: isoDay(0),
				}),
				await token()
			),
			walled()
		);
		const { data } = await toolPayload(res);
		const provenance = data.provenance as {
			degraded: boolean;
			gaps: { from: string; to: string; days: number }[];
			errors: { errorClass: string; count: number }[];
			note: string;
		};

		expect(provenance.degraded).toBeTruthy();
		expect(provenance.gaps).toStrictEqual([
			{ days: 3, from: isoDay(5), to: isoDay(3) },
		]);
		expect(provenance.errors).toStrictEqual([
			{
				count: 3,
				errorClass: "throttled",
				from: isoDay(5),
				loss: false,
				to: isoDay(3),
			},
		]);

		// The warning has to be in the body as prose: a model reading a series will
		// narrate a hole as a decline unless the answer says otherwise.
		// Missing observations are counted against the cadence, in observations.
		expect(provenance.note).toMatch(
			/3 of 10 expected observations are missing.*not evidence of a rank change.*throttled/u
		);
	});

	it("does not call a stretched cadence a gap", async () => {
		// A pair on a 7-day rung is supposed to have six-day holes.
		await env.DB.prepare(
			"UPDATE crawl_pair SET interval_hours = 168 WHERE id = 1"
		).run();
		for (const day of [14, 7, 0]) {
			await seedRanking({
				date: isoDay(day),
				entries: [[5, APP_ID]],
				id: 300 + day,
				pairId: 1,
			});
		}
		const res = await fetchMcp(
			mcpRequest(
				callTool("get_rank_history", {
					from: isoDay(14),
					pairId: 1,
					to: isoDay(0),
				}),
				await token()
			),
			walled()
		);
		const { data } = await toolPayload(res);
		const provenance = data.provenance as {
			degraded: boolean;
			coverage: number;
			intervalHours: number;
		};
		expect(provenance.intervalHours).toBe(168);
		expect(provenance.coverage).toBe(1);
		expect(provenance.degraded).toBeFalsy();
	});
});

async function seedPairError(day: number, errorClass: string) {
	await env.DB.prepare(
		`INSERT INTO fetch_error (fetched_at, endpoint, params, error_class)
     VALUES (?1, 'itunes:search', 'example keyword|fr|fr-FR', ?2)`
	)
		.bind(Date.parse(`${isoDay(day)}T12:00:00Z`), errorClass)
		.run();
}

async function coverageOf(from: number) {
	const res = await fetchMcp(
		mcpRequest(
			callTool("get_rank_history", {
				from: isoDay(from),
				pairId: 1,
				to: isoDay(0),
			}),
			await token()
		),
		walled()
	);
	const { data } = await toolPayload(res);
	return data.provenance as {
		coverage: number;
		degraded: boolean;
		gaps: unknown[];
		note: string | null;
		errors: { errorClass: string; loss: boolean }[];
	};
}

describe("coverage and the three kinds of fetch_error", () => {
	it("does not degrade a fully observed pair for a throttle that was absorbed", async () => {
		// Every day observed, one throttle that was requeued and succeeded. That
		// is ordinary weather: flagging it put the warning on every pair.
		for (const day of [4, 3, 2, 1, 0]) {
			await seedRanking({
				date: isoDay(day),
				entries: [[5, APP_ID]],
				id: 500 + day,
				pairId: 1,
			});
		}
		await seedPairError(2, "throttled");
		const provenance = await coverageOf(4);
		expect(provenance.coverage).toBe(1);
		expect(provenance.degraded).toBeFalsy();
		// Still named, because the provenance is the point, but without the
		// sentence that tells the reader to distrust the window.
		expect(provenance.note).toContain("1 throttled fetch");
		expect(provenance.note).not.toContain("not evidence of a rank change");
	});

	it("degrades a fully observed pair for a class that cost an observation", async () => {
		for (const day of [4, 3, 2, 1, 0]) {
			await seedRanking({
				date: isoDay(day),
				entries: [[5, APP_ID]],
				id: 500 + day,
				pairId: 1,
			});
		}
		await seedPairError(2, "task_threw");
		const provenance = await coverageOf(4);
		expect(provenance.degraded).toBeTruthy();
		expect(provenance.errors).toMatchObject([
			{ errorClass: "task_threw", loss: true },
		]);
		expect(provenance.note).toContain("not evidence of a rank change");
	});

	it("never counts a stretched cadence as missing days, even beside an error", async () => {
		// A weekly pair with all three expected observations and one throttle.
		// The note used to read "12 of 15 days have no observation".
		await env.DB.prepare(
			"UPDATE crawl_pair SET interval_hours = 168 WHERE id = 1"
		).run();
		for (const day of [14, 7, 0]) {
			await seedRanking({
				date: isoDay(day),
				entries: [[5, APP_ID]],
				id: 600 + day,
				pairId: 1,
			});
		}
		await seedPairError(3, "throttled");
		const provenance = await coverageOf(14);
		expect(provenance.degraded).toBeFalsy();
		expect(provenance.gaps).toStrictEqual([]);
		expect(provenance.note).not.toContain("missing");
		expect(provenance.note).not.toContain("have no observation");
	});
});

describe(findGaps, () => {
	it("keeps only the runs a pair's cadence does not explain", () => {
		// Checked every three days: two empty days between observations are the
		// plan, five are a hole.
		expect(
			findGaps(
				["2026-01-01", "2026-01-04", "2026-01-10"],
				"2026-01-01",
				"2026-01-10",
				3
			)
		).toStrictEqual([{ days: 5, from: "2026-01-05", to: "2026-01-09" }]);
	});

	it("finds leading, interior and trailing runs", () => {
		expect(findGaps(["2026-01-03"], "2026-01-01", "2026-01-05")).toStrictEqual([
			{ days: 2, from: "2026-01-01", to: "2026-01-02" },
			{ days: 2, from: "2026-01-04", to: "2026-01-05" },
		]);
	});

	it("finds nothing in a complete window", () => {
		expect(
			findGaps(["2026-01-01", "2026-01-02"], "2026-01-01", "2026-01-02")
		).toStrictEqual([]);
	});
});

describe(summariseSeries, () => {
	it("summarises without shipping every point", () => {
		const points = [
			{ date: "2026-01-01", position: 20 },
			{ date: "2026-01-02", position: 19 },
			{ date: "2026-01-03", position: 4 },
			{ date: "2026-01-04", position: null },
		];
		const summary = summariseSeries(points);
		expect(summary.best).toBe(4);
		expect(summary.worst).toBe(20);
		// The newest day saw the app outside the top 200, so 4 is no longer its
		// rank: latest follows the newest observation, not the newest rank.
		expect(summary.latest).toBeNull();
		expect(summary.observations).toBe(3);
		// A one-place drift is Apple reshuffling; a fifteen-place climb is not.
		expect(summary.inflections).toStrictEqual([
			{ date: "2026-01-03", delta: 15, from: 19, to: 4 },
		]);
	});

	it("says nothing rather than zero for a series with no ranked days", () => {
		const summary = summariseSeries([{ date: "2026-01-01", position: null }]);
		expect(summary.best).toBeNull();
		expect(summary.latest).toBeNull();
		expect(summary.observations).toBe(0);
	});
});

describe("aggregate-by-default", () => {
	it("omits per-day points until detail asks for them", async () => {
		await seedRanking({
			date: isoDay(0),
			entries: [
				[3, APP_ID],
				[1, RIVAL_ID],
			],
			id: 400,
			pairId: 1,
		});
		const t = await token();

		const summary = await toolPayload(
			await fetchMcp(
				mcpRequest(callTool("get_rank_history", { pairId: 1 }), t),
				walled()
			)
		);
		expect(summary.data.points).toBeUndefined();
		expect(summary.data.summary).toBeDefined();

		const daily = await toolPayload(
			await fetchMcp(
				mcpRequest(
					callTool("get_rank_history", { detail: "daily", pairId: 1 }),
					t
				),
				walled()
			)
		);
		expect(daily.data.summary).toBeUndefined();
		expect(daily.data.points).toBeDefined();
	});
});
