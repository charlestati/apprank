/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import {
	AdsClient,
	AdsRateLimitedError,
	fetchAdsAccessToken,
	mintAdsClientSecret,
	pickPrimaryAccount,
} from "@apprank/core/apple/ads";
import {
	AscClient,
	AscApiError,
	downloadSegment,
	mintAscToken,
} from "@apprank/core/apple/asc";
import { describe, it, expect, afterEach, vi } from "vitest";

import { generateP8Pem, stubFetch } from "./helpers";

afterEach(() => {
	vi.unstubAllGlobals();
});

function decodeSegment(segment: string) {
	return JSON.parse(
		new TextDecoder().decode(
			Uint8Array.from(
				atob(
					segment.replaceAll("-", "+").replaceAll("_", "/") +
						"=".repeat((4 - (segment.length % 4)) % 4)
				),
				(c) => c.codePointAt(0) ?? 0
			)
		)
	);
}

function decodeJwt(jwt: string) {
	const [h, p] = jwt.split(".");
	return { header: decodeSegment(h ?? ""), payload: decodeSegment(p ?? "") };
}

describe("Apple Ads client", () => {
	it("mints a client secret JWT with Apple's required claims", async () => {
		const { pem } = await generateP8Pem();
		const jwt = await mintAdsClientSecret({
			clientId: "client-id",
			keyId: "KEY123",
			privateKeyPem: pem,
			teamId: "TEAM123",
		});
		const { header, payload } = decodeJwt(jwt);
		expect(header).toStrictEqual({ alg: "ES256", kid: "KEY123" });
		expect(payload.sub).toBe("client-id");
		expect(payload.iss).toBe("TEAM123");
		expect(payload.aud).toBe("https://appleid.apple.com");
		// Apple rejects a client secret living longer than 180 days.
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(180 * 86_400);
	});

	it("exchanges the secret for an access token via client_credentials", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch(() =>
			Response.json({ access_token: "tok", expires_in: 3600 })
		);
		const token = await fetchAdsAccessToken({
			clientId: "client-id",
			keyId: "KEY123",
			privateKeyPem: pem,
			teamId: "TEAM123",
		});
		expect(token.accessToken).toBe("tok");
		expect(token.expiresAt).toBeGreaterThan(Date.now());
		expect(calls[0]?.url).toBe("https://appleid.apple.com/auth/oauth2/token");
		expect(String(calls[0]?.init?.body)).toContain(
			"grant_type=client_credentials"
		);
		expect(String(calls[0]?.init?.body)).toContain("scope=searchadsorg");
	});

	it("surfaces a failed token exchange", async () => {
		const { pem } = await generateP8Pem();
		stubFetch(() => new Response("bad key", { status: 401 }));
		await expect(
			fetchAdsAccessToken({
				clientId: "c",
				keyId: "k",
				privateKeyPem: pem,
				teamId: "t",
			})
		).rejects.toThrow("Ads token exchange failed: 401");
	});

	it("queries search-term popularity with the ad account context header", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch((url) => {
			if (url.includes("appleid.apple.com")) {
				return Response.json({ access_token: "tok", expires_in: 3600 });
			}
			return Response.json({
				result: {
					rows: [
						{ rankInGenre: 1, searchPopularity1to100: 90, searchTerm: "a" },
					],
				},
			});
		});
		const client = new AdsClient(
			{ clientId: "c", keyId: "k", privateKeyPem: pem, teamId: "t" },
			"acct-1"
		);
		const { rows } = await client.searchTermPopularity({
			countryOrRegion: "FR",
			end: "2026-08-15",
			start: "2026-08-09",
		});
		expect(rows).toHaveLength(1);
		const query = calls.at(-1);
		expect(query?.url).toContain(
			"/v1/insights/apps/search-term-popularity/query"
		);
		const headers = query?.init?.headers as Record<string, string>;
		expect(headers["X-AP-Context"]).toBe("adAccountId=acct-1");
		const body = JSON.parse(String(query?.init?.body));
		expect(body.timeRange).toStrictEqual({
			end: "2026-08-15",
			granularity: "WEEKLY_SUN_SAT",
			start: "2026-08-09",
		});
		expect(body.filters).toContainEqual({
			field: "countryOrRegion",
			operator: "EQUALS",
			value: "FR",
		});
	});

	it("does not send the old Campaign Management envelope", async () => {
		// A top-level `granularity` or a `selector` wrapper earns
		// REQUEST_UNRECOGNIZED_PROPERTY from the Platform API.
		const { pem } = await generateP8Pem();
		const calls = stubFetch((url) =>
			url.includes("appleid.apple.com")
				? Response.json({ access_token: "tok", expires_in: 3600 })
				: Response.json({ result: { rows: [] } })
		);
		const client = new AdsClient(
			{ clientId: "c", keyId: "k", privateKeyPem: pem, teamId: "t" },
			"acct-1"
		);
		await client.searchTermPopularity({
			countryOrRegion: "FR",
			end: "2026-08-15",
			start: "2026-08-09",
		});
		const body = JSON.parse(String(calls.at(-1)?.init?.body));
		expect(body.selector).toBeUndefined();
		expect(body.granularity).toBeUndefined();
	});

	it("adds a searchTerm filter only when terms are supplied", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch((url) =>
			url.includes("appleid.apple.com")
				? Response.json({ access_token: "tok", expires_in: 3600 })
				: Response.json({ result: { rows: [] } })
		);
		const client = new AdsClient(
			{ clientId: "c", keyId: "k", privateKeyPem: pem, teamId: "t" },
			"acct-1"
		);
		await client.searchTermPopularity({
			countryOrRegion: "FR",
			end: "2026-08-15",
			genre: "Word",
			searchTerms: ["terme un"],
			start: "2026-08-09",
		});
		const body = JSON.parse(String(calls.at(-1)?.init?.body));
		expect(body.filters).toContainEqual({
			field: "searchTerm",
			operator: "IN",
			value: ["terme un"],
		});
		expect(body.filters).toContainEqual({
			field: "genre",
			operator: "EQUALS",
			value: "Word",
		});
	});

	it("throws a typed rate-limit error carrying Retry-After", async () => {
		const { pem } = await generateP8Pem();
		stubFetch((url) =>
			url.includes("appleid.apple.com")
				? Response.json({ access_token: "tok", expires_in: 3600 })
				: new Response("slow down", {
						headers: { "Retry-After": "120" },
						status: 429,
					})
		);
		const client = new AdsClient(
			{ clientId: "c", keyId: "k", privateKeyPem: pem, teamId: "t" },
			"acct-1"
		);
		await expect(
			client.searchTermPopularity({
				countryOrRegion: "FR",
				end: "2026-08-15",
				start: "2026-08-09",
			})
		).rejects.toBeInstanceOf(AdsRateLimitedError);
	});

	it("discovers ad accounts and their roles through the ACL endpoint", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch((url) =>
			url.includes("appleid.apple.com")
				? Response.json({ access_token: "tok", expires_in: 3600 })
				: Response.json({
						result: {
							acls: [
								{
									adAccount: { id: 42, name: "Acme", orgId: 42 },
									roles: ["API Campaign Manager"],
								},
							],
						},
						success: true,
					})
		);
		const { accounts } = await AdsClient.listAdAccounts({
			clientId: "c",
			keyId: "k",
			privateKeyPem: pem,
			teamId: "t",
		});
		expect(accounts).toStrictEqual([
			{ id: "42", name: "Acme", orgId: "42", roles: ["API Campaign Manager"] },
		]);
		expect(calls.at(-1)?.url).toContain("/v1/acls");
	});

	it("accepts an unwrapped ACL payload too", async () => {
		// Apple's own SDK models the response as { acls: [...] }; the live API
		// wraps it in `result`. Tolerate every shape rather than guess: reading
		// the wrong wrapper yields an empty list, which looks exactly like a
		// permissions problem and is not one.
		const { pem } = await generateP8Pem();
		stubFetch((url) =>
			url.includes("appleid.apple.com")
				? Response.json({ access_token: "tok", expires_in: 3600 })
				: Response.json({ acls: [{ adAccount: { id: 7 } }] })
		);
		const { accounts } = await AdsClient.listAdAccounts({
			clientId: "c",
			keyId: "k",
			privateKeyPem: pem,
			teamId: "t",
		});
		expect(accounts).toStrictEqual([
			{ id: "7", name: null, orgId: null, roles: [] },
		]);
	});
});

describe("App Store Connect client", () => {
	it("mints a token with a lifetime inside Apple's 20-minute cap", async () => {
		const { pem } = await generateP8Pem();
		const jwt = await mintAscToken({
			issuerId: "issuer",
			keyId: "KEY",
			privateKeyPem: pem,
		});
		const { header, payload } = decodeJwt(jwt);
		expect(header.typ).toBe("JWT");
		expect(payload.aud).toBe("appstoreconnect-v1");
		expect(payload.iss).toBe("issuer");
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(1200);
	});

	it("follows pagination when listing report requests", async () => {
		const { pem } = await generateP8Pem();
		let page = 0;
		stubFetch(() => {
			page += 1;
			return page === 1
				? Response.json({
						data: [{ attributes: { accessType: "ONGOING" }, id: "r1" }],
						links: { next: "https://api.appstoreconnect.apple.com/page2" },
					})
				: Response.json({
						data: [
							{ attributes: { accessType: "ONE_TIME_SNAPSHOT" }, id: "r2" },
						],
					});
		});
		const asc = new AscClient({
			issuerId: "i",
			keyId: "k",
			privateKeyPem: pem,
		});
		const rows = await asc.listReportRequests("424242");
		expect(rows.map((r) => r.id)).toStrictEqual(["r1", "r2"]);
	});

	it("creates a report request and returns the new resource", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch(() =>
			Response.json({
				data: { attributes: { accessType: "ONGOING" }, id: "new" },
			})
		);
		const asc = new AscClient({
			issuerId: "i",
			keyId: "k",
			privateKeyPem: pem,
		});
		const created = await asc.createReportRequest("424242", "ONGOING");
		expect(created.id).toBe("new");
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body.data.relationships.app.data.id).toBe("424242");
	});

	it("filters reports by category and instances by granularity", async () => {
		const { pem } = await generateP8Pem();
		const calls = stubFetch(() => Response.json({ data: [] }));
		const asc = new AscClient({
			issuerId: "i",
			keyId: "k",
			privateKeyPem: pem,
		});
		await asc.listReports("req-1", "APP_STORE_ENGAGEMENT");
		await asc.listInstances("rep-1", "DAILY");
		await asc.listSegments("inst-1");
		expect(calls[0]?.url).toContain("filter[category]=APP_STORE_ENGAGEMENT");
		expect(calls[1]?.url).toContain("filter[granularity]=DAILY");
		expect(calls[2]?.url).toContain(
			"/analyticsReportInstances/inst-1/segments"
		);
	});

	it("raises a typed error when the API rejects a call", async () => {
		const { pem } = await generateP8Pem();
		stubFetch(() => new Response("expired token", { status: 401 }));
		const asc = new AscClient({
			issuerId: "i",
			keyId: "k",
			privateKeyPem: pem,
		});
		await expect(asc.listReportRequests("424242")).rejects.toBeInstanceOf(
			AscApiError
		);
	});

	it("streams a segment download without auth headers", async () => {
		const calls = stubFetch(() => new Response("gzip-bytes", { status: 200 }));
		const res = await downloadSegment("https://presigned.example/seg.gz");
		await expect(res.text()).resolves.toBe("gzip-bytes");
		expect(calls[0]?.init).toBeUndefined();
	});

	it("fails loudly when a segment 404s despite being listed", async () => {
		stubFetch(() => new Response("", { status: 404 }));
		await expect(
			downloadSegment("https://presigned.example/seg.gz")
		).rejects.toBeInstanceOf(AscApiError);
	});
});

describe(pickPrimaryAccount, () => {
	const advanced = {
		id: "5861160",
		name: "Acme",
		orgId: "5861160",
		roles: [],
	};
	const basic = {
		id: "8388360",
		name: "Search Ads Basic",
		orgId: "5861160",
		roles: [],
	};

	it("prefers the Advanced account over the Search Ads Basic one", () => {
		// A login commonly holds both; only the Advanced account (id === orgId)
		// carries Insights data, and it is not reliably listed first.
		expect(pickPrimaryAccount([basic, advanced])).toBe(advanced);
	});

	it("falls back to the first account when none matches its org", () => {
		expect(pickPrimaryAccount([basic])).toBe(basic);
		expect(pickPrimaryAccount([])).toBeUndefined();
	});
});
