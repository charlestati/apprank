import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { isRestart } from "../src/scheduler";
import {
	adsDiscoverStep,
	isVariantOf,
	MIN_RELEVANCE,
	pickCandidates,
	PROPOSALS_PER_SEED,
} from "../src/tasks/discover";
import type { Task } from "../src/tasks/types";
import { generateP8Pem, stubFetch } from "./helpers";

let pem = "";

function discoverEnv() {
	return {
		...env,
		ADS_CLIENT_ID: "cid",
		ADS_KEY_ID: "kid",
		ADS_PRIVATE_KEY: pem,
		ADS_TEAM_ID: "tid",
	} as typeof env;
}

function task(over: Partial<Extract<Task, { type: "ads_discover" }>> = {}) {
	return {
		appAdamId: "555",
		appId: 555,
		language: "fr",
		localeCode: "fr-FR",
		rest: [],
		seed: "météo locale",
		storefront: "fr",
		type: "ads_discover" as const,
		userId: "operator",
		...over,
	};
}

function suggestionsFetch(rows: unknown[]) {
	stubFetch((url) => {
		if (url.includes("appleid.apple.com")) {
			return Response.json({ access_token: "tok", expires_in: 3600 });
		}
		if (url.includes("/v1/acls")) {
			return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
		}
		return Response.json({ result: rows });
	});
}

/** A keyword tracked by `userId` in fr, through its storefront row. */
function trackIn(keywordId: number, text: string, userId = "operator") {
	return [
		env.DB.prepare(
			"INSERT OR IGNORE INTO keyword (id, text, normalized, language) VALUES (?1, ?2, ?2, 'fr')"
		).bind(keywordId, text),
		env.DB.prepare(
			"INSERT OR IGNORE INTO crawl_pair (keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at) VALUES (?1, 'fr', 'fr-FR', 1, 1, 24, 0)"
		).bind(keywordId),
		env.DB.prepare(
			"INSERT INTO tracked_keyword (user_id, app_id, keyword_id, created_at) VALUES (?1, 555, ?2, 0)"
		).bind(userId, keywordId),
		env.DB.prepare(
			"INSERT INTO tracked_keyword_storefront (tracked_keyword_id, storefront_code, locale_code, created_at) SELECT id, 'fr', 'fr-FR', 0 FROM tracked_keyword WHERE user_id = ?1 AND keyword_id = ?2"
		).bind(userId, keywordId),
	];
}

describe(pickCandidates, () => {
	it("drops what is already known, including the seed Apple echoes back", () => {
		const picked = pickCandidates(
			[
				{ popularity: 90, text: "Météo Locale" },
				{ popularity: 40, text: "météo locale gratuite" },
			],
			new Set(["météo locale"]),
			"météo locale"
		);
		expect(picked.map((c) => c.term)).toStrictEqual(["météo locale gratuite"]);
	});

	it("drops a change of subject, however relevant Apple thinks it is", () => {
		// Measured on the live account: unrelated terms came back at 53 and 17
		// from two tracked seeds. A score cannot tell those from a variant;
		// sharing a word with the seed can.
		const picked = pickCandidates(
			[
				{ popularity: 53, text: "mobility" },
				{ popularity: 20, text: "radar gratuit" },
			],
			new Set(),
			"radar"
		);
		expect(picked.map((c) => c.term)).toStrictEqual(["radar gratuit"]);
	});

	it("matches on whole words, not substrings", () => {
		// "local" is inside "localisation" and "locality", which is how a naive
		// filter re-admits the noise it was added to remove.
		expect(isVariantOf("localisation gps", "météo locale")).toBeFalsy();
		expect(isVariantOf("météo locale gratuite", "météo locale")).toBeTruthy();
	});

	it("drops the low-relevance tail rather than filling the inbox with it", () => {
		// Apple answers one seed with up to ~75 associations, most of them another
		// category entirely. A queue nobody opens is worse than an empty one.
		const picked = pickCandidates(
			[
				{ popularity: MIN_RELEVANCE, text: "radar keep" },
				{ popularity: MIN_RELEVANCE - 1, text: "radar drop" },
			],
			new Set(),
			"radar"
		);
		expect(picked.map((c) => c.term)).toStrictEqual(["radar keep"]);
	});

	it("keeps the most relevant few, in order", () => {
		const picked = pickCandidates(
			Array.from({ length: 10 }, (_, i) => ({
				popularity: 20 + i,
				text: `radar t${i}`,
			})),
			new Set(),
			"radar"
		);
		expect(picked).toHaveLength(PROPOSALS_PER_SEED);
		expect(picked[0]?.term).toBe("radar t9");
	});
});

describe(adsDiscoverStep, () => {
	beforeEach(async () => {
		({ pem } = await generateP8Pem());
		await env.DB.batch([
			env.DB.prepare("DELETE FROM fetch_error"),
			env.DB.prepare("DELETE FROM suggestion"),
			env.DB.prepare("DELETE FROM tracked_keyword_storefront"),
			env.DB.prepare("DELETE FROM tracked_keyword"),
			env.DB.prepare("DELETE FROM crawl_pair"),
			env.DB.prepare("DELETE FROM keyword"),
			env.DB.prepare(
				"INSERT OR IGNORE INTO storefront (code, name, weight, active) VALUES ('fr', 'France', 1.0, 1)"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO locale (code, language) VALUES ('fr-FR', 'fr')"
			),
			env.DB.prepare(
				"INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (555, 'App', 0, 0)"
			),
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still offers a term another user already tracks here", async () => {
		// The "already tracked" check used the shared pairs, so one user's track
		// hid the term from everyone else. Accepting it shares the pair anyway.
		await env.DB.batch([
			...trackIn(1, "météo locale"),
			...trackIn(2, "météo locale gratuite", "someone-else"),
		]);
		suggestionsFetch([{ popularity: 31, text: "météo locale gratuite" }]);

		await adsDiscoverStep(discoverEnv(), task());

		const rows = await env.DB.prepare(
			"SELECT json_extract(payload, '$.term') AS term FROM suggestion"
		).all<{ term: string }>();
		expect(rows.results).toStrictEqual([{ term: "météo locale gratuite" }]);
	});

	it("proposes a variant of a tracked keyword, without touching the crawl", async () => {
		await env.DB.batch(trackIn(1, "météo locale"));
		suggestionsFetch([
			{ popularity: 90, text: "météo locale" },
			{ popularity: 31, text: "météo locale gratuite" },
		]);

		await adsDiscoverStep(discoverEnv(), task());

		const row = await env.DB.prepare(
			"SELECT user_id, type, status, payload FROM suggestion"
		).first<{
			user_id: string;
			type: string;
			status: string;
			payload: string;
		}>();
		expect(row?.type).toBe("promote_keyword");
		expect(row?.status).toBe("pending");
		expect(row?.user_id).toBe("operator");
		expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
			seed: "météo locale",
			storefront: "fr",
			term: "météo locale gratuite",
		});

		// A proposal is not a promotion: nothing enters the crawl budget here.
		const pairs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM crawl_pair"
		).first<{ n: number }>();
		expect(pairs?.n).toBe(1);
	});

	it("does not re-propose a term the operator already ruled on", async () => {
		// A dismissal is an answer. Asking again every week is how a queue teaches
		// people to ignore it.
		await env.DB.prepare(
			`INSERT INTO suggestion (user_id, type, payload, status, created_at)
       VALUES ('operator', 'promote_keyword', '{"term":"météo locale gratuite","storefront":"fr"}', 'dismissed', 0)`
		).run();
		suggestionsFetch([{ popularity: 31, text: "météo locale gratuite" }]);

		await adsDiscoverStep(discoverEnv(), task());

		const n = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM suggestion"
		).first<{ n: number }>();
		expect(n?.n).toBe(1);
	});

	it("starts each seed with a clean attempt count", async () => {
		// Carried over, 429s added up across seeds until one abandonment took
		// every seed not yet asked.
		suggestionsFetch([]);
		const followUps = await adsDiscoverStep(
			discoverEnv(),
			task({ attempt: 3, rest: ["radar"] })
		);
		expect(followUps[0]).toMatchObject({ attempt: 0, seed: "radar" });
	});

	it("gives up on a refused seed without dropping the ones after it", async () => {
		stubFetch((url) => {
			if (url.includes("appleid.apple.com")) {
				return Response.json({ access_token: "tok", expires_in: 3600 });
			}
			if (url.includes("/v1/acls")) {
				return Response.json({ data: { acls: [{ adAccount: { id: 777 } }] } });
			}
			return new Response("", { status: 429 });
		});
		const followUps = await adsDiscoverStep(
			discoverEnv(),
			task({ attempt: 4, rest: ["radar", "pluie"] })
		);
		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toMatchObject({
			attempt: 0,
			rest: ["pluie"],
			seed: "radar",
		});
	});

	it("walks one seed per tick and hands the rest on", async () => {
		suggestionsFetch([]);
		const followUps = await adsDiscoverStep(
			discoverEnv(),
			task({ rest: ["radar", "pluie"] })
		);
		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toMatchObject({ rest: ["pluie"], seed: "radar" });
	});
});

describe(isRestart, () => {
	it("recognises the message a deploy leaves behind", () => {
		// Every deploy replaces the object and drops the call in flight. Filing
		// that as a failed task put "data lost" on the dashboard each time the
		// Worker shipped, which is the false signal the split exists to prevent.
		expect(
			isRestart(
				"Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."
			)
		).toBeTruthy();
		expect(
			isRestart("Durable Object reset because its code was updated.")
		).toBeTruthy();
	});

	it("leaves a real failure alone", () => {
		expect(isRestart("D1_ERROR: no such column")).toBeFalsy();
		expect(isRestart("Connection closed")).toBeFalsy();
	});
});
