/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

/* oxlint-disable vitest/max-expects -- the audit row is one composite record;
   asserting it field by field is what makes a regression readable. */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { DAILY_CALL_BUDGET } from "../src/mcp/auth";
import { clearReferenceCache } from "../src/mcp/reference";
import {
	APP_ID,
	USER_ID,
	apiRequest,
	resetDb,
	seedCatalog,
	seedKeywords,
	seedTrackedApp,
} from "./fixtures";
import {
	MCP_URL,
	callTool,
	fetchMcp,
	issueCredential,
	jsonRpcBody,
	mcpRequest,
	rpc,
	toolPayload,
} from "./mcp-fixtures";

const OTHER_USER = "someone-else";
const OTHER_APP = 707_070;

/** MCP has no dev escape hatch: a credential is required even locally. */
function walled(extra: Record<string, unknown> = {}) {
	return {
		...env,
		ALLOW_UNAUTHENTICATED: "true",
		MCP_ENABLED: "true",
		...extra,
	} as never;
}

interface ListedTool {
	name: string;
	inputSchema: {
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

/** The tools the server itself registers, with their argument schemas. */
async function listTools(token: string): Promise<ListedTool[]> {
	const res = await fetchMcp(mcpRequest(rpc("tools/list"), token), walled());
	const body = await jsonRpcBody<{ result: { tools: ListedTool[] } }>(res);
	return body.result.tools;
}

/** A value for each argument some tool requires beside its id. */
const REQUIRED_ARGUMENTS: Record<string, unknown> = {
	chart: "free",
	storefront: "fr",
};

/** Arguments that address the caller's own data, enough for a tool to run. */
function argumentsFor(name: string): Record<string, unknown> {
	const own: Record<string, Record<string, unknown>> = {
		find_keyword_opportunities: { appId: APP_ID, storefront: "fr" },
		get_chart_movement: { chart: "free", storefront: "fr" },
		get_competitors: { pairId: 1 },
		get_current_rankings: { appId: APP_ID },
		get_keyword_popularity: { appId: APP_ID, storefront: "fr" },
		get_keyword_report: { appId: APP_ID, storefront: "fr" },
		get_metadata_changes: { appId: APP_ID },
		get_rank_history: { pairId: 1 },
		get_ratings_history: { appId: APP_ID },
		get_reviews: { appId: APP_ID },
		get_search_results: { pairId: 1 },
	};
	return own[name] ?? {};
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

describe("the MCP transport switch", () => {
	it("does not serve the endpoint unless it is switched on", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const res = await fetchMcp(
			mcpRequest(rpc("tools/list"), token),
			walled({ MCP_ENABLED: undefined })
		);
		// 404, not 401: a credential that would work on an enabled deployment
		// must not be told that this one merely has the feature turned off.
		expect(res.status).toBe(404);
		const logged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM mcp_tool_call"
		).first<{ n: number }>();
		expect(logged?.n).toBe(0);
	});

	it("withdraws the Basic exemption along with the route", async () => {
		// The exemption exists only to hand anonymous requests to the bearer gate.
		// With the transport off there is no gate downstream, so the wall has to
		// take the request back. Otherwise switching MCP off would open the one
		// path that skips authentication entirely.
		const accounts = JSON.stringify([
			{ password: "pw", userId: USER_ID, username: "operator" },
		]);
		const res = await fetchMcp(
			mcpRequest(rpc("tools/list")),
			walled({
				ALLOW_UNAUTHENTICATED: undefined,
				BASIC_AUTH_ACCOUNTS: accounts,
				MCP_ENABLED: undefined,
			})
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
	});
});

describe("the MCP transport boundary", () => {
	it("refuses an anonymous request before any tool runs", async () => {
		const res = await fetchMcp(mcpRequest(rpc("tools/list")), walled());
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
		// Nothing was dispatched, so nothing was logged.
		const logged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM mcp_tool_call"
		).first<{ n: number }>();
		expect(logged?.n).toBe(0);
	});

	it("stays shut even where the HTTP API opens for local development", async () => {
		// ALLOW_UNAUTHENTICATED serves the whole origin to anyone. It must not
		// reach MCP: a dev flag that publishes an agent endpoint is a trap.
		const api = await fetchMcp(apiRequest("/apps"), walled());
		expect(api.status).toBe(200);
		const mcp = await fetchMcp(mcpRequest(rpc("tools/list")), walled());
		expect(mcp.status).toBe(401);
	});

	it("rejects a Basic credential, because the two transports do not cross", async () => {
		const accounts = JSON.stringify([
			{ password: "pw", userId: USER_ID, username: "operator" },
		]);
		const res = await fetchMcp(
			mcpRequest(rpc("tools/list"), undefined, {
				Authorization: `Basic ${btoa("operator:pw")}`,
			}),
			walled({
				ALLOW_UNAUTHENTICATED: undefined,
				BASIC_AUTH_ACCOUNTS: accounts,
			})
		);
		expect(res.status).toBe(401);
	});

	it("rejects an MCP token against the HTTP API", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const accounts = JSON.stringify([
			{ password: "pw", userId: USER_ID, username: "operator" },
		]);
		const res = await fetchMcp(
			apiRequest("/apps", { headers: { Authorization: `Bearer ${token}` } }),
			walled({
				ALLOW_UNAUTHENTICATED: undefined,
				BASIC_AUTH_ACCOUNTS: accounts,
			})
		);
		expect(res.status).toBe(401);
	});

	it("rejects unknown, malformed and wrong-prefix tokens alike", async () => {
		await issueCredential({ id: "abc123", userId: USER_ID });
		for (const header of [
			"Bearer apprank_mcp_abc123_wrong-secret",
			"Bearer apprank_mcp_nosuchid_secret-abc123",
			"Bearer apprank_mcp_malformed",
			"Bearer not-an-apprank-token",
			"Bearer ",
			"apprank_mcp_abc123_secret-abc123",
		]) {
			const res = await fetchMcp(
				mcpRequest(rpc("tools/list"), undefined, { Authorization: header }),
				walled()
			);
			expect([header, res.status]).toStrictEqual([header, 401]);
		}
	});

	it("accepts a valid credential and lists the tools", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const res = await fetchMcp(mcpRequest(rpc("tools/list"), token), walled());
		expect(res.status).toBe(200);
		const body = await jsonRpcBody<{
			result: { tools: { name: string }[] };
		}>(res);
		expect(body.result.tools.map((t) => t.name)).toContain("whoami");
		// No raw-SQL escape hatch, by construction.
		expect(body.result.tools.map((t) => t.name)).not.toContain("run_sql");
	});

	it("kills a revoked credential on the very next call", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		const before = await fetchMcp(
			mcpRequest(callTool("whoami"), token),
			walled()
		);
		expect(before.status).toBe(200);

		await env.DB.prepare(
			"UPDATE mcp_credential SET revoked_at = ?1 WHERE id = ?2"
		)
			.bind(Date.now(), id)
			.run();

		const after = await fetchMcp(
			mcpRequest(callTool("whoami"), token),
			walled()
		);
		expect(after.status).toBe(401);
	});

	it("refuses an expired credential", async () => {
		const { token } = await issueCredential({
			expiresAt: Date.now() - 1000,
			userId: USER_ID,
		});
		const res = await fetchMcp(mcpRequest(rpc("tools/list"), token), walled());
		expect(res.status).toBe(401);
	});

	it("stops a credential that has spent its daily budget", async () => {
		const { token } = await issueCredential({
			userId: USER_ID,
			windowCount: DAILY_CALL_BUDGET,
			windowStart: Date.now(),
		});
		const res = await fetchMcp(mcpRequest(callTool("whoami"), token), walled());
		expect(res.status).toBe(429);
	});

	it("does not keep inflating the count of a spent credential", async () => {
		// A loop retrying a refused credential must not grow the number forever;
		// otherwise the write it costs is unbounded.
		const { id, token } = await issueCredential({
			userId: USER_ID,
			windowCount: DAILY_CALL_BUDGET + 1,
			windowStart: Date.now(),
		});
		for (let i = 0; i < 3; i += 1) {
			await fetchMcp(mcpRequest(callTool("whoami"), token), walled());
		}
		const row = await env.DB.prepare(
			"SELECT window_count FROM mcp_credential WHERE id = ?1"
		)
			.bind(id)
			.first<{ window_count: number }>();
		expect(row?.window_count).toBe(DAILY_CALL_BUDGET + 1);
	});

	it("stamps last-used so a forgotten credential can be found", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		await fetchMcp(mcpRequest(callTool("whoami"), token), walled());
		const row = await env.DB.prepare(
			"SELECT last_used_at, call_count FROM mcp_credential WHERE id = ?1"
		)
			.bind(id)
			.first<{ last_used_at: number; call_count: number }>();
		expect(row?.last_used_at).toBeGreaterThan(0);
		expect(row?.call_count).toBe(1);
	});
});

/** A stand-in for the rate-limit binding that refuses the keys it is told to. */
function limiter(refuse: (key: string) => boolean) {
	const keys: string[] = [];
	return {
		binding: {
			limit: ({ key }: { key: string }) => {
				keys.push(key);
				return Promise.resolve({ success: !refuse(key) });
			},
		},
		keys,
	};
}

describe("the MCP burst brake", () => {
	const ADDRESS = "203.0.113.7";

	it("does not charge a credential's bucket for a wrong secret", async () => {
		// The id is the public half of the token: it is printed in the revoke
		// command and stored in the audit log. Keyed on it before the secret was
		// checked, the brake let anyone who had seen an id spend its holder's
		// bucket and keep them at 429.
		const { id } = await issueCredential({ userId: USER_ID });
		const brake = limiter(() => false);
		const res = await fetchMcp(
			mcpRequest(rpc("tools/list"), undefined, {
				Authorization: `Bearer apprank_mcp_${id}_wrong-secret`,
				"CF-Connecting-IP": ADDRESS,
			}),
			walled({ MCP_RATE_LIMIT: brake.binding })
		);
		expect(res.status).toBe(401);
		expect(brake.keys).toStrictEqual([`ip:${ADDRESS}`]);
	});

	it("charges the credential once its secret has matched, before the daily count", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		const brake = limiter((key) => key === `credential:${id}`);
		const res = await fetchMcp(
			mcpRequest(callTool("whoami"), token, { "CF-Connecting-IP": ADDRESS }),
			walled({ MCP_RATE_LIMIT: brake.binding })
		);
		expect(res.status).toBe(429);
		expect(brake.keys).toStrictEqual([`ip:${ADDRESS}`, `credential:${id}`]);
		// Refused before the write it exists to save.
		const row = await env.DB.prepare(
			"SELECT call_count FROM mcp_credential WHERE id = ?1"
		)
			.bind(id)
			.first<{ call_count: number }>();
		expect(row?.call_count).toBe(0);
	});

	it("stops a loop of rotating ids at the address, before it reaches D1", async () => {
		// A fresh id per request got a fresh bucket each time, so the brake never
		// engaged and every request cost a read.
		const brake = limiter((key) => key === `ip:${ADDRESS}`);
		let prepared = 0;
		const counted = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) => {
						prepared += 1;
						return target.prepare(sql);
					};
				}
				const value: unknown = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		for (const id of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
			const res = await fetchMcp(
				mcpRequest(rpc("tools/list"), undefined, {
					Authorization: `Bearer apprank_mcp_${id}_x`,
					"CF-Connecting-IP": ADDRESS,
				}),
				walled({ DB: counted, MCP_RATE_LIMIT: brake.binding })
			);
			expect(res.status).toBe(429);
		}
		expect(prepared).toBe(0);
	});

	it("lets a served call through both brakes", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		const brake = limiter(() => false);
		const res = await fetchMcp(
			mcpRequest(callTool("whoami"), token, { "CF-Connecting-IP": ADDRESS }),
			walled({ MCP_RATE_LIMIT: brake.binding })
		);
		expect(res.status).toBe(200);
		expect(brake.keys).toStrictEqual([`ip:${ADDRESS}`, `credential:${id}`]);
	});
});

async function seedOtherOperator() {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (?1, 'Their App', 0, 0)"
		).bind(OTHER_APP),
		env.DB.prepare(
			"INSERT INTO tracked_app (user_id, app_id, created_at) VALUES (?1, ?2, 0)"
		).bind(OTHER_USER, OTHER_APP),
		env.DB.prepare(
			"INSERT INTO keyword (id, text, normalized, language) VALUES (9, 'their keyword', 'their keyword', 'fr')"
		),
		env.DB.prepare(
			`INSERT INTO crawl_pair (id, keyword_id, storefront_code, locale_code, tier, ref_count, next_due_at)
         VALUES (9, 9, 'fr', 'fr-FR', 1, 1, 0)`
		),
		env.DB.prepare(
			"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, ?2, 9, 0)"
		).bind(OTHER_USER, OTHER_APP),
	]);
}

/**
 * Every tool that takes an appId or a pairId, read off the server's own
 * tool list, each addressed at the other operator's data.
 *
 * Derived, not listed: a hand-kept table passes vacuously for the tool
 * somebody adds next, which is the one this test exists for. A pair id wins
 * over an app id where a tool takes both, because the pair is what the tool
 * is about and the app only narrows it.
 */
async function scopedTools(
	token: string
): Promise<[string, Record<string, unknown>][]> {
	const scoped: [string, Record<string, unknown>][] = [];
	for (const tool of await listTools(token)) {
		const properties = tool.inputSchema.properties ?? {};
		let args: Record<string, unknown> | null = null;
		if ("pairId" in properties) {
			args = { pairId: 9 };
		} else if ("appId" in properties) {
			args = { appId: OTHER_APP };
		}
		if (args === null) {
			continue;
		}
		for (const required of tool.inputSchema.required ?? []) {
			if (!(required in args)) {
				// A required argument this table cannot fill fails the test below
				// by name, so a new tool has to be taught here rather than skipped.
				args[required] = REQUIRED_ARGUMENTS[required];
			}
		}
		scoped.push([tool.name, args]);
	}
	return scoped;
}

describe("MCP ownership", () => {
	it("finds the scoped tools it expects, so the walk below is not vacuous", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const scoped = await scopedTools(token);
		expect(scoped.map(([name]) => name).toSorted()).toStrictEqual([
			"find_keyword_opportunities",
			"get_collection_health",
			"get_competitors",
			"get_current_rankings",
			"get_keyword_popularity",
			"get_keyword_report",
			"get_metadata_changes",
			"get_rank_history",
			"get_ratings_history",
			"get_reviews",
			"get_search_results",
		]);
		// Every required argument was filled: an undefined here is a new tool
		// whose arguments this file does not know yet.
		expect(
			scoped.filter(([, args]) => Object.values(args).includes(undefined))
		).toStrictEqual([]);
	});

	it("refuses every app- and pair-scoped tool for another operator's data", async () => {
		await seedOtherOperator();
		const { token } = await issueCredential({ userId: USER_ID });
		for (const [name, args] of await scopedTools(token)) {
			const res = await fetchMcp(
				mcpRequest(callTool(name, args), token),
				walled()
			);
			const { data, isError } = await toolPayload(res);
			expect([name, isError]).toStrictEqual([name, true]);
			// The same message whether the id is absent or someone else's: confirming
			// that it exists is itself information about another account.
			expect([name, String(data.error)]).toStrictEqual([
				name,
				expect.stringMatching(/^No tracked (?<kind>app|keyword)/u),
			]);
		}
	});

	it("answers the same way for an id that does not exist at all", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const missing = await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: 999_999 }), token),
			walled()
		);
		await seedOtherOperator();
		const theirs = await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: OTHER_APP }), token),
			walled()
		);
		const a = await toolPayload(missing);
		const b = await toolPayload(theirs);
		expect(String(a.data.error).replaceAll(/\d+/gu, "N")).toBe(
			String(b.data.error).replaceAll(/\d+/gu, "N")
		);
	});

	it("serves the caller's own app", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const res = await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: APP_ID }), token),
			walled()
		);
		const { isError } = await toolPayload(res);
		expect(isError).toBeFalsy();
	});

	it("scopes a credential to its own operator's apps", async () => {
		await seedOtherOperator();
		const { token } = await issueCredential({ userId: OTHER_USER });
		const res = await fetchMcp(
			mcpRequest(callTool("list_tracked_apps"), token),
			walled()
		);
		const { data } = await toolPayload(res);
		expect(
			(data.apps as { appId: number }[]).map((a) => a.appId)
		).toStrictEqual([OTHER_APP]);
	});
});

/**
 * The scope each tool is registered under. Hand-kept, because the scope is not
 * in the tool list, and checked for completeness against that list below.
 */
const TOOL_SCOPES: Record<string, string | null> = {
	find_keyword_opportunities: "read:rankings",
	get_chart_movement: "read:charts",
	get_collection_health: "read:health",
	get_competitors: "read:rankings",
	get_current_rankings: "read:rankings",
	get_keyword_popularity: "read:popularity",
	get_keyword_report: "read:rankings",
	get_metadata_changes: "read:metadata",
	get_rank_history: "read:rankings",
	get_ratings_history: "read:ratings",
	get_reviews: "read:reviews",
	get_search_results: "read:rankings",
	list_tracked_apps: "read:rankings",
	whoami: null,
};

describe("MCP scopes, tool by tool", () => {
	it("knows the scope of every registered tool", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		const tools = await listTools(token);
		const names = tools.map((t) => t.name);
		expect(names.toSorted()).toStrictEqual(Object.keys(TOOL_SCOPES).toSorted());
	});

	it("refuses each tool to a credential holding every scope but its own", async () => {
		// One tool under the wrong scope is a whole table readable by a
		// credential that was issued for something else.
		const everyScope = [
			...new Set(Object.values(TOOL_SCOPES).filter((s) => s !== null)),
		];
		for (const [name, scope] of Object.entries(TOOL_SCOPES)) {
			if (scope === null) {
				continue;
			}
			const { token } = await issueCredential({
				scopes: everyScope.filter((s) => s !== scope),
				userId: USER_ID,
			});
			const { data, isError } = await toolPayload(
				await fetchMcp(
					mcpRequest(callTool(name, argumentsFor(name)), token),
					walled()
				)
			);
			expect([name, isError, String(data.error)]).toStrictEqual([
				name,
				true,
				expect.stringContaining(`the ${scope} scope`),
			]);
		}
	});

	it("serves each tool to a credential holding only its own scope", async () => {
		for (const [name, scope] of Object.entries(TOOL_SCOPES)) {
			const { token } = await issueCredential({
				scopes: scope === null ? [] : [scope],
				userId: USER_ID,
			});
			const { data, isError } = await toolPayload(
				await fetchMcp(
					mcpRequest(callTool(name, argumentsFor(name)), token),
					walled()
				)
			);
			expect([name, isError, data.error]).toStrictEqual([
				name,
				false,
				undefined,
			]);
		}
	});
});

describe("MCP scopes", () => {
	it("refuses a tool the credential does not carry the scope for", async () => {
		const { token } = await issueCredential({
			scopes: ["read:health"],
			userId: USER_ID,
		});
		const denied = await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: APP_ID }), token),
			walled()
		);
		const { data, isError } = await toolPayload(denied);
		expect(isError).toBeTruthy();
		expect(String(data.error)).toContain("read:rankings");

		const allowed = await fetchMcp(
			mcpRequest(callTool("get_collection_health"), token),
			walled()
		);
		const health = await toolPayload(allowed);
		expect(health.isError).toBeFalsy();
	});

	it("grants nothing when the stored scope list is malformed", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		await env.DB.prepare(
			"UPDATE mcp_credential SET scopes = 'not json' WHERE id = ?1"
		)
			.bind(id)
			.run();
		const denied = await fetchMcp(
			mcpRequest(callTool("list_tracked_apps"), token),
			walled()
		);
		const payload = await toolPayload(denied);
		expect(payload.isError).toBeTruthy();
	});

	it("still lets a credential discover it has no usable scope", async () => {
		// whoami describes the credential the caller already holds and reads no
		// data, so it must answer even when nothing else will.
		const { id, token } = await issueCredential({ userId: USER_ID });
		await env.DB.prepare(
			"UPDATE mcp_credential SET scopes = '[]' WHERE id = ?1"
		)
			.bind(id)
			.run();
		const res = await fetchMcp(mcpRequest(callTool("whoami"), token), walled());
		const { data, isError } = await toolPayload(res);
		expect(isError).toBeFalsy();
		expect(data.scopes).toStrictEqual([]);
		// And it names no app, so it is not a way around the scope it lacks.
		expect(data.apps).toBeUndefined();
	});
});

describe("MCP audit log", () => {
	it("records principal, tool, params, row count and duration", async () => {
		const { id, token } = await issueCredential({ userId: USER_ID });
		await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: APP_ID }), token),
			walled()
		);
		const row = await env.DB.prepare(
			"SELECT credential_id, user_id, tool, params, row_count, duration_ms, outcome FROM mcp_tool_call ORDER BY id DESC LIMIT 1"
		).first<{
			credential_id: string;
			user_id: string;
			tool: string;
			params: string;
			row_count: number;
			duration_ms: number;
			outcome: string;
		}>();
		expect(row?.credential_id).toBe(id);
		expect(row?.user_id).toBe(USER_ID);
		expect(row?.tool).toBe("get_current_rankings");
		expect(JSON.parse(row?.params ?? "{}")).toMatchObject({ appId: APP_ID });
		expect(row?.row_count).toBeGreaterThanOrEqual(0);
		expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
		expect(row?.outcome).toBe("ok");
	});

	it("records a refused call as denied, with the tool that was attempted", async () => {
		const { token } = await issueCredential({ userId: USER_ID });
		await fetchMcp(
			mcpRequest(callTool("get_current_rankings", { appId: 999_999 }), token),
			walled()
		);
		const row = await env.DB.prepare(
			"SELECT tool, outcome FROM mcp_tool_call ORDER BY id DESC LIMIT 1"
		).first<{ tool: string; outcome: string }>();
		expect(row).toStrictEqual({
			outcome: "denied",
			tool: "get_current_rankings",
		});
	});
});

describe("the MCP route's place in the origin", () => {
	it("is not reachable through the SPA fallback", async () => {
		// run_worker_first is what guarantees this; the config test below asserts
		// the setting itself.
		const res = await fetchMcp(new Request(MCP_URL), walled());
		expect(res.status).not.toBe(200);
	});
});
