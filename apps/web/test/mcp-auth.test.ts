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
    ...extra,
  } as never;
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

  it("rejects a Basic credential — the two transports do not cross", async () => {
    const accounts = JSON.stringify([
      { password: "pw", userId: USER_ID, username: "charles" },
    ]);
    const res = await fetchMcp(
      mcpRequest(rpc("tools/list"), undefined, {
        Authorization: `Basic ${btoa("charles:pw")}`,
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
      { password: "pw", userId: USER_ID, username: "charles" },
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

describe("MCP ownership", () => {
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

  /** Every tool that takes an appId or a pairId. */
  const SCOPED_TOOLS: [string, Record<string, unknown>][] = [
    ["get_keyword_report", { appId: OTHER_APP, storefront: "fr" }],
    ["get_current_rankings", { appId: OTHER_APP }],
    ["get_keyword_popularity", { appId: OTHER_APP, storefront: "fr" }],
    ["get_metadata_changes", { appId: OTHER_APP }],
    ["find_keyword_opportunities", { appId: OTHER_APP, storefront: "fr" }],
    ["get_reviews", { appId: OTHER_APP }],
    ["get_ratings_history", { appId: OTHER_APP }],
    ["get_collection_health", { appId: OTHER_APP }],
    ["get_rank_history", { pairId: 9 }],
    ["get_competitors", { pairId: 9 }],
    ["get_search_results", { pairId: 9 }],
  ];

  it("refuses every app- and pair-scoped tool for another operator's data", async () => {
    await seedOtherOperator();
    const { token } = await issueCredential({ userId: USER_ID });
    for (const [name, args] of SCOPED_TOOLS) {
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
