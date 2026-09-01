/* oxlint-disable vitest/require-top-level-describe -- the database reset is a
   file-wide precondition shared by every suite below. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import { authenticate, decodeHeader, parseAccounts } from "../src/basic-auth";
import worker from "../src/index";
import {
	APP_ID,
	apiRequest,
	resetDb,
	seedCatalog,
	seedTrackedApp,
} from "./fixtures";

const ACCOUNTS = JSON.stringify([
	{ password: "correct-horse-battery", userId: "admin", username: "operator" },
	{ password: "second-account-secret", username: "alice" },
]);

function header(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

/** An env with accounts configured and the dev escape hatch off. */
function walled(extra: Record<string, unknown> = {}) {
	return {
		...env,
		ALLOW_UNAUTHENTICATED: undefined,
		BASIC_AUTH_ACCOUNTS: ACCOUNTS,
		...extra,
	} as never;
}

beforeEach(async () => {
	await resetDb();
	await seedCatalog();
	await seedTrackedApp();
});

describe(parseAccounts, () => {
	it("reads a list of accounts", () => {
		expect(parseAccounts(ACCOUNTS)).toStrictEqual([
			{
				password: "correct-horse-battery",
				userId: "admin",
				username: "operator",
			},
			{ password: "second-account-secret", userId: "alice", username: "alice" },
		]);
	});

	it("defaults the user id to the username", () => {
		const [account] = parseAccounts('[{"username":"bob","password":"x"}]');
		expect(account?.userId).toBe("bob");
	});

	it("locks the door on a malformed secret rather than opening it", () => {
		expect(parseAccounts("not json at all")).toStrictEqual([]);
		expect(parseAccounts('{"username":"solo"}')).toStrictEqual([]);
		expect(parseAccounts()).toStrictEqual([]);
	});

	it("drops entries missing a username or password", () => {
		expect(
			parseAccounts(
				'[{"username":"a"},{"password":"b"},{"username":"c","password":"d"}]'
			)
		).toStrictEqual([{ password: "d", userId: "c", username: "c" }]);
	});
});

describe(decodeHeader, () => {
	it("decodes a well-formed header", () => {
		expect(decodeHeader(header("operator", "secret"))).toStrictEqual({
			password: "secret",
			username: "operator",
		});
	});

	it("keeps colons that belong to the password", () => {
		expect(decodeHeader(header("operator", "a:b:c"))?.password).toBe("a:b:c");
	});

	it("refuses anything that is not Basic", () => {
		expect(decodeHeader(null)).toBeNull();
		expect(decodeHeader("Bearer token")).toBeNull();
		expect(decodeHeader("Basic !!!not-base64!!!")).toBeNull();
		expect(decodeHeader(`Basic ${btoa("no-separator")}`)).toBeNull();
	});
});

describe(authenticate, () => {
	const accounts = parseAccounts(ACCOUNTS);

	it("accepts a correct password and resolves the mapped user id", async () => {
		await expect(
			authenticate(header("operator", "correct-horse-battery"), accounts)
		).resolves.toStrictEqual({
			ok: true,
			userId: "admin",
			username: "operator",
		});
	});

	it("accepts the second account, proving accounts are independent", async () => {
		const outcome = await authenticate(
			header("alice", "second-account-secret"),
			accounts
		);
		expect(outcome).toMatchObject({ ok: true, userId: "alice" });
	});

	it("rejects a wrong password, an unknown user and a swapped pair", async () => {
		for (const attempt of [
			header("operator", "wrong"),
			header("nobody", "correct-horse-battery"),
			// alice's password must not work for operator.
			header("operator", "second-account-secret"),
		]) {
			await expect(authenticate(attempt, accounts)).resolves.toStrictEqual({
				ok: false,
			});
		}
	});

	it("rejects everything when no accounts are configured", async () => {
		await expect(
			authenticate(header("operator", "correct-horse-battery"), [])
		).resolves.toStrictEqual({ ok: false });
	});
});

describe("the wall", () => {
	it("challenges an anonymous request so the browser prompts", async () => {
		const res = await worker.fetch(apiRequest("/apps"), walled());
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'Basic realm="AppRank"'
		);
	});

	it("guards the page itself, not just the API", async () => {
		// A failed fetch() does not prompt, so the HTML must be behind the wall too.
		const res = await worker.fetch(
			new Request("https://example.com/"),
			walled()
		);
		expect(res.status).toBe(401);
	});

	it("serves the app once the credentials are right", async () => {
		const res = await worker.fetch(
			apiRequest("/apps", {
				headers: { Authorization: header("operator", "correct-horse-battery") },
			}),
			walled()
		);
		expect(res.status).toBe(200);
		const rows = (await res.json()) as { id: number }[];
		expect(rows.map((r) => r.id)).toStrictEqual([APP_ID]);
	});

	it("keeps each account to its own apps", async () => {
		// The tracked app belongs to 'admin', which is operator — not alice.
		const res = await worker.fetch(
			apiRequest("/apps", {
				headers: { Authorization: header("alice", "second-account-secret") },
			}),
			walled()
		);
		await expect(res.json()).resolves.toStrictEqual([]);
	});

	it("reports who the caller is", async () => {
		const res = await worker.fetch(
			apiRequest("/me", {
				headers: { Authorization: header("alice", "second-account-secret") },
			}),
			walled()
		);
		await expect(res.json()).resolves.toStrictEqual({ userId: "alice" });
	});

	it("serves nothing at all when no accounts are configured", async () => {
		const res = await worker.fetch(apiRequest("/apps"), {
			...env,
			ALLOW_UNAUTHENTICATED: undefined,
			BASIC_AUTH_ACCOUNTS: undefined,
		} as never);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			error: "auth not configured",
		});
	});

	it("leaves the liveness probe reachable without credentials", async () => {
		const res = await worker.fetch(apiRequest("/health"), walled());
		expect(res.status).toBe(200);
	});
});
