/* oxlint-disable vitest/require-top-level-describe -- the database reset and
   the signing key are file-wide preconditions shared by every suite below. */

import { env } from "cloudflare:test";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	accessConfig,
	authenticateAccess,
	normaliseTeamDomain,
	parseAccessUsers,
	remoteKeys,
	verifyAccessToken,
} from "../src/cf-access";
import type { KeyLoader } from "../src/cf-access";
import worker from "../src/index";
import {
	APP_ID,
	apiRequest,
	resetDb,
	seedCatalog,
	seedTrackedApp,
} from "./fixtures";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-of-the-apprank-application";
const KID = "key-1";
const USERS = JSON.stringify([
	{ email: "Operator@Example.com", userId: "admin" },
	{ email: "alice@example.com" },
]);

const RS256 = {
	hash: "SHA-256",
	modulusLength: 2048,
	name: "RSASSA-PKCS1-v1_5",
	publicExponent: new Uint8Array([1, 0, 1]),
} as const;

let signer: CryptoKeyPair;
let impostor: CryptoKeyPair;
let publicJwk: JsonWebKey;

beforeAll(async () => {
	signer = (await crypto.subtle.generateKey(RS256, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	impostor = (await crypto.subtle.generateKey(RS256, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	publicJwk = (await crypto.subtle.exportKey(
		"jwk",
		signer.publicKey
	)) as JsonWebKey;
});

beforeEach(async () => {
	await resetDb();
	await seedCatalog();
	await seedTrackedApp();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function b64url(bytes: Uint8Array | string): string {
	const raw =
		typeof bytes === "string" ? bytes : String.fromCodePoint(...bytes);
	return btoa(raw)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

const now = () => Math.floor(Date.now() / 1000);

async function sign(
	claims: Record<string, unknown>,
	{
		header = { alg: "RS256", kid: KID },
		key = signer.privateKey,
	}: { header?: Record<string, unknown>; key?: CryptoKey } = {}
): Promise<string> {
	const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(RS256, key, new TextEncoder().encode(body))
	);
	return `${body}.${b64url(signature)}`;
}

function claimSet(extra: Record<string, unknown> = {}) {
	return {
		aud: [AUD],
		email: "operator@example.com",
		exp: now() + 3600,
		iat: now(),
		iss: TEAM,
		...extra,
	};
}

const knownKey: KeyLoader = (_team, kid) =>
	Promise.resolve(kid === KID ? signer.publicKey : undefined);

const CONFIG = { aud: AUD, teamDomain: TEAM };

describe(normaliseTeamDomain, () => {
	it("accepts the host or the URL, with or without a trailing slash", () => {
		for (const raw of [
			"team.cloudflareaccess.com",
			"https://team.cloudflareaccess.com",
			"https://team.cloudflareaccess.com/",
			" https://team.cloudflareaccess.com// ",
		]) {
			expect(normaliseTeamDomain(raw)).toBe(TEAM);
		}
	});

	it("refuses anything that cannot be the issuer", () => {
		expect(normaliseTeamDomain()).toBeNull();
		expect(normaliseTeamDomain("   ")).toBeNull();
		expect(normaliseTeamDomain("http://team.cloudflareaccess.com")).toBeNull();
		expect(
			normaliseTeamDomain("https://team.cloudflareaccess.com/x")
		).toBeNull();
		expect(normaliseTeamDomain("not a host!")).toBeNull();
	});
});

describe(parseAccessUsers, () => {
	it("lowercases emails and defaults the user id to the email", () => {
		expect(parseAccessUsers(USERS)).toStrictEqual([
			{ email: "operator@example.com", userId: "admin" },
			{ email: "alice@example.com", userId: "alice@example.com" },
		]);
	});

	it("locks the door on a malformed secret rather than opening it", () => {
		expect(parseAccessUsers()).toStrictEqual([]);
		expect(parseAccessUsers("not json")).toStrictEqual([]);
		expect(parseAccessUsers('{"email":"a@b.c"}')).toStrictEqual([]);
		expect(
			parseAccessUsers('[{"userId":"x"},{"email":"  "},{"email":7}]')
		).toStrictEqual([]);
	});
});

describe(accessConfig, () => {
	it("is absent when nothing is set, so Basic stays in charge", () => {
		expect(accessConfig({})).toBe("absent");
	});

	it("is incomplete when any of the three is missing or unusable", () => {
		expect(accessConfig({ ACCESS_AUD: AUD })).toBe("incomplete");
		expect(accessConfig({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM })).toBe(
			"incomplete"
		);
		expect(
			accessConfig({
				ACCESS_AUD: AUD,
				ACCESS_TEAM_DOMAIN: TEAM,
				ACCESS_USERS: "[]",
			})
		).toBe("incomplete");
		expect(
			accessConfig({
				ACCESS_AUD: " ",
				ACCESS_TEAM_DOMAIN: TEAM,
				ACCESS_USERS: USERS,
			})
		).toBe("incomplete");
	});

	it("reads a complete configuration", () => {
		expect(
			accessConfig({
				ACCESS_AUD: AUD,
				ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
				ACCESS_USERS: USERS,
			})
		).toMatchObject({ aud: AUD, teamDomain: TEAM });
	});
});

describe(verifyAccessToken, () => {
	it("returns the lowercased email of a genuine token", async () => {
		const token = await sign(claimSet({ email: "Operator@Example.com" }));
		await expect(verifyAccessToken(token, CONFIG, knownKey)).resolves.toBe(
			"operator@example.com"
		);
	});

	it("accepts a single-string audience", async () => {
		const token = await sign(claimSet({ aud: AUD }));
		await expect(verifyAccessToken(token, CONFIG, knownKey)).resolves.toBe(
			"operator@example.com"
		);
	});

	it("rejects a token signed by a key Access did not publish", async () => {
		const token = await sign(claimSet(), { key: impostor.privateKey });
		await expect(
			verifyAccessToken(token, CONFIG, knownKey)
		).resolves.toBeNull();
	});

	it("rejects an unknown key id", async () => {
		const token = await sign(claimSet(), {
			header: { alg: "RS256", kid: "x" },
		});
		await expect(
			verifyAccessToken(token, CONFIG, knownKey)
		).resolves.toBeNull();
	});

	it("pins the algorithm instead of reading it from the token", async () => {
		const token = await sign(claimSet(), { header: { alg: "none", kid: KID } });
		await expect(
			verifyAccessToken(token, CONFIG, knownKey)
		).resolves.toBeNull();
		const noKid = await sign(claimSet(), { header: { alg: "RS256" } });
		await expect(
			verifyAccessToken(noKid, CONFIG, knownKey)
		).resolves.toBeNull();
	});

	it("rejects another application's or another team's token", async () => {
		for (const extra of [
			{ aud: ["some-other-app"] },
			{ iss: "https://other.cloudflareaccess.com" },
		]) {
			const token = await sign(claimSet(extra));
			await expect(
				verifyAccessToken(token, CONFIG, knownKey)
			).resolves.toBeNull();
		}
	});

	it("rejects an expired, not-yet-valid or undated token", async () => {
		for (const extra of [
			{ exp: now() - 3600 },
			{ nbf: now() + 3600 },
			{ exp: undefined },
		]) {
			const token = await sign(claimSet(extra));
			await expect(
				verifyAccessToken(token, CONFIG, knownKey)
			).resolves.toBeNull();
		}
	});

	it("tolerates a minute of clock drift", async () => {
		const token = await sign(claimSet({ exp: now() - 30, nbf: now() + 30 }));
		await expect(verifyAccessToken(token, CONFIG, knownKey)).resolves.toBe(
			"operator@example.com"
		);
	});

	it("rejects a service token, which has no person to map", async () => {
		const token = await sign(claimSet({ common_name: "ci", email: undefined }));
		await expect(
			verifyAccessToken(token, CONFIG, knownKey)
		).resolves.toBeNull();
	});

	it("rejects anything that is not a JWT", async () => {
		const genuine = await sign(claimSet());
		const [h, p] = genuine.split(".") as [string, string];
		for (const junk of [
			null,
			undefined,
			"",
			"a.b",
			"!!!.???.***",
			`${h}.${b64url("[1]")}.AAAA`,
			`${b64url("null")}.${p}.AAAA`,
		]) {
			await expect(
				verifyAccessToken(junk, CONFIG, knownKey)
			).resolves.toBeNull();
		}
	});
});

describe(authenticateAccess, () => {
	const config = accessConfig({
		ACCESS_AUD: AUD,
		ACCESS_TEAM_DOMAIN: TEAM,
		ACCESS_USERS: USERS,
	});
	if (typeof config === "string") {
		throw new TypeError("fixture configuration must be complete");
	}

	it("maps a listed email to its user id", async () => {
		const token = await sign(claimSet());
		await expect(
			authenticateAccess(token, config, knownKey)
		).resolves.toStrictEqual({ ok: true, userId: "admin" });
	});

	it("401s a missing token and 403s a genuine but unlisted email", async () => {
		await expect(
			authenticateAccess(null, config, knownKey)
		).resolves.toStrictEqual({ ok: false, status: 401 });
		const stranger = await sign(claimSet({ email: "mallory@example.com" }));
		await expect(
			authenticateAccess(stranger, config, knownKey)
		).resolves.toStrictEqual({ ok: false, status: 403 });
	});
});

describe(remoteKeys, () => {
	it("fetches the team's key set once and caches it", async () => {
		const team = "https://cache.cloudflareaccess.com";
		const spy = vi.fn<(input: string) => Promise<Response>>(() =>
			Promise.resolve(
				Response.json({
					keys: [
						{ ...publicJwk, kid: KID },
						{ kid: "ec", kty: "EC" },
					],
				})
			)
		);
		vi.stubGlobal("fetch", spy);
		await expect(remoteKeys(team, KID)).resolves.toBeDefined();
		await expect(remoteKeys(team, KID)).resolves.toBeDefined();
		// An unknown id inside the refetch floor does not hit the endpoint again.
		await expect(remoteKeys(team, "ec")).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalledExactlyOnceWith(`${team}/cdn-cgi/access/certs`);
	});

	it("throws when the certs endpoint fails, so the gate can 503", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<() => Promise<Response>>(() =>
				Promise.resolve(new Response("down", { status: 502 }))
			)
		);
		await expect(
			remoteKeys("https://down.cloudflareaccess.com", KID)
		).rejects.toThrow("HTTP 502");
	});
});

function behindAccess(team = TEAM, extra: Record<string, unknown> = {}) {
	return {
		...env,
		ACCESS_AUD: AUD,
		ACCESS_TEAM_DOMAIN: team,
		ACCESS_USERS: USERS,
		ALLOW_UNAUTHENTICATED: undefined,
		BASIC_AUTH_ACCOUNTS: undefined,
		...extra,
	} as never;
}

function serveKeys() {
	vi.stubGlobal(
		"fetch",
		vi.fn<() => Promise<Response>>(() =>
			Promise.resolve(Response.json({ keys: [{ ...publicJwk, kid: KID }] }))
		)
	);
}

async function withToken(path: string, extra: Record<string, unknown> = {}) {
	return apiRequest(path, {
		headers: { "Cf-Access-Jwt-Assertion": await sign(claimSet(extra)) },
	});
}

describe("the Access wall", () => {
	it("serves the operator's own apps to a signed-in operator", async () => {
		serveKeys();
		const res = await worker.fetch(await withToken("/apps"), behindAccess());
		expect(res.status).toBe(200);
		const rows = (await res.json()) as { id: number }[];
		expect(rows.map((r) => r.id)).toStrictEqual([APP_ID]);
	});

	it("keeps each person to their own apps", async () => {
		serveKeys();
		const res = await worker.fetch(
			await withToken("/me", { email: "alice@example.com" }),
			behindAccess()
		);
		await expect(res.json()).resolves.toStrictEqual({
			userId: "alice@example.com",
		});
	});

	it("401s a request that arrives without Access in front of it", async () => {
		serveKeys();
		const res = await worker.fetch(apiRequest("/apps"), behindAccess());
		expect(res.status).toBe(401);
		// No Basic challenge: there is no password that would help.
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
	});

	it("guards the page itself, not just the API", async () => {
		serveKeys();
		const res = await worker.fetch(
			new Request("https://example.com/"),
			behindAccess()
		);
		expect(res.status).toBe(401);
	});

	it("403s a genuine sign-in by someone who is not an operator", async () => {
		serveKeys();
		const res = await worker.fetch(
			await withToken("/apps", { email: "mallory@example.com" }),
			behindAccess()
		);
		expect(res.status).toBe(403);
	});

	it("ignores Basic once Access is configured", async () => {
		serveKeys();
		const res = await worker.fetch(
			apiRequest("/apps", {
				headers: { Authorization: `Basic ${btoa("a:b")}` },
			}),
			behindAccess(TEAM, {
				BASIC_AUTH_ACCOUNTS: '[{"username":"a","password":"b"}]',
			})
		);
		expect(res.status).toBe(401);
	});

	it("503s rather than 401s when the signing keys cannot be read", async () => {
		const team = "https://unreachable.cloudflareaccess.com";
		vi.stubGlobal(
			"fetch",
			vi.fn<() => Promise<Response>>(() =>
				Promise.reject(new Error("network down"))
			)
		);
		const res = await worker.fetch(
			apiRequest("/apps", {
				headers: {
					"Cf-Access-Jwt-Assertion": await sign(claimSet({ iss: team })),
				},
			}),
			behindAccess(team)
		);
		expect(res.status).toBe(503);
	});

	it("fails closed on a half-finished configuration", async () => {
		const res = await worker.fetch(
			apiRequest("/apps"),
			behindAccess(TEAM, {
				ACCESS_USERS: undefined,
				ALLOW_UNAUTHENTICATED: "true",
			})
		);
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toMatchObject({
			error: "auth misconfigured",
		});
	});

	it("leaves the liveness probe reachable without a token", async () => {
		const res = await worker.fetch(apiRequest("/health"), behindAccess());
		expect(res.status).toBe(200);
	});
});
