// Configuration invariants that no runtime test can catch.

import { describe, expect, it } from "vitest";

import { MCP_ROUTE } from "../src/mcp/server";
// Imported as text rather than read from disk: these tests run inside the
// Workers runtime, which has no filesystem.
import raw from "../wrangler.jsonc?raw";

/** wrangler.jsonc is JSONC: strip comments and trailing commas before parsing. */
function readWranglerConfig(): Record<string, unknown> {
	const withoutComments = raw
		.replaceAll(/\/\*[\S\s]*?\*\//gu, "")
		.replaceAll(/(?<before>^|[^:"])\/\/.*$/gmu, "$<before>");
	return JSON.parse(
		withoutComments.replaceAll(/,(?<close>\s*[\]}])/gu, "$<close>")
	) as Record<string, unknown>;
}

describe("the assets configuration", () => {
	const config = readWranglerConfig();
	const assets = config.assets as {
		not_found_handling?: string;
		run_worker_first?: boolean;
	};

	it("sends every request through the Worker before the assets binding", () => {
		// This is the whole reason `not_found_handling: single-page-application`
		// cannot reach /mcp or /api. Turn it off and the SPA fallback answers them
		// with index.html — the API and the MCP endpoint both break, and the wall
		// that gates the HTML disappears with them.
		expect(assets.run_worker_first).toBeTruthy();
	});

	it("keeps the SPA fallback, which is safe only because of the above", () => {
		expect(assets.not_found_handling).toBe("single-page-application");
	});
});

describe("the MCP route", () => {
	it("is a single fixed path, not a prefix the SPA could swallow", () => {
		expect(MCP_ROUTE).toBe("/mcp");
	});

	it("has a per-credential rate limit binding declared", () => {
		const limits = readWranglerConfig().ratelimits as {
			name: string;
			simple: { limit: number; period: number };
		}[];
		const limiter = limits.find((l) => l.name === "MCP_RATE_LIMIT");
		expect(limiter).toBeDefined();
		// Cloudflare accepts only 10 or 60 for `period`; anything else is rejected
		// at deploy time rather than at review time.
		expect([10, 60]).toContain(limiter?.simple.period);
	});
});
