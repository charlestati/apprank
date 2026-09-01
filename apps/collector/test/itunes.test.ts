/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import {
	localeToLang,
	searchUrl,
	lookupUrl,
	reviewsRssUrl,
	chartRssUrl,
	fetchClassified,
} from "@apprank/core/apple/itunes";
import type { FetchOutcome } from "@apprank/core/apple/itunes";
import { describe, it, expect, afterEach, vi } from "vitest";

import { stubFetch } from "./helpers";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("URL builders", () => {
	it("maps App Store locale codes to the iTunes lang parameter", () => {
		expect(localeToLang("fr-FR")).toBe("fr_FR");
		expect(localeToLang("en-CA")).toBe("en_CA");
		// Bare codes (Italian) pass through unchanged.
		expect(localeToLang("it")).toBe("it");
	});

	it("builds a search URL carrying storefront and locale separately", () => {
		const url = new URL(searchUrl("recettes de crêpes", "fr", "fr-FR"));
		expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
		expect(url.searchParams.get("term")).toBe("recettes de crêpes");
		expect(url.searchParams.get("country")).toBe("fr");
		expect(url.searchParams.get("lang")).toBe("fr_FR");
		expect(url.searchParams.get("limit")).toBe("200");
	});

	it("honours a smaller limit when asked", () => {
		const url = new URL(searchUrl("word", "ca", "en-CA", 25));
		expect(url.searchParams.get("limit")).toBe("25");
	});

	it("omits lang from a lookup when no locale is given", () => {
		const withLocale = new URL(lookupUrl(424_242, "fr", "fr-FR"));
		expect(withLocale.searchParams.get("lang")).toBe("fr_FR");
		expect(withLocale.searchParams.get("id")).toBe("424242");
		const without = new URL(lookupUrl(424_242, "fr"));
		expect(without.searchParams.has("lang")).toBeFalsy();
	});

	it("builds review feed URLs per storefront and page", () => {
		expect(reviewsRssUrl(424_242, "be", 3)).toBe(
			"https://itunes.apple.com/be/rss/customerreviews/page=3/sortby=mostrecent/id=424242/json"
		);
	});

	it("builds chart URLs for each chart, with and without a genre", () => {
		expect(chartRssUrl("fr", "free", 7019)).toContain(
			"/rss/topfreeapplications/limit=100/genre=7019/json"
		);
		expect(chartRssUrl("fr", "paid")).toContain(
			"/rss/toppaidapplications/limit=100/json"
		);
		expect(chartRssUrl("fr", "grossing", 7012, 50)).toContain(
			"/rss/topgrossingapplications/limit=50/genre=7012/json"
		);
	});
});

describe(fetchClassified, () => {
	it("returns parsed JSON on 200", async () => {
		stubFetch(() => Response.json({ resultCount: 1, results: [{ a: 1 }] }));
		const out = (await fetchClassified(
			"https://itunes.apple.com/search?term=x"
		)) as Extract<FetchOutcome, { kind: "ok" }>;
		expect(out.kind).toBe("ok");
		expect(out.status).toBe(200);
		expect(out.json).toStrictEqual({ resultCount: 1, results: [{ a: 1 }] });
		expect(out.responseMs).toBeGreaterThanOrEqual(0);
	});

	it("classifies a 403-with-empty-results as throttling, not as data", async () => {
		// Apple's documented silent-garbage failure mode: an empty result set that
		// is really a rate limit.
		stubFetch(() =>
			Response.json({ resultCount: 0, results: [] }, { status: 403 })
		);
		const out = await fetchClassified("https://itunes.apple.com/search?term=x");
		expect(out.kind).toBe("throttled");
		expect(out.status).toBe(403);
	});

	it("classifies 429 as throttling and keeps the body for the archive", async () => {
		stubFetch(
			() => new Response("Rate limit has been exceeded", { status: 429 })
		);
		const out = await fetchClassified("https://itunes.apple.com/search?term=x");
		expect(out.kind).toBe("throttled");
		expect(out.bodyText).toContain("Rate limit");
	});

	it("classifies other non-OK statuses as errors", async () => {
		stubFetch(() => new Response("nope", { status: 500 }));
		const out = await fetchClassified("https://itunes.apple.com/search?term=x");
		expect(out.kind).toBe("error");
		expect(out.status).toBe(500);
	});

	it("classifies unparseable 200 bodies as errors", async () => {
		stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
		const out = await fetchClassified("https://itunes.apple.com/search?term=x");
		expect(out.kind).toBe("error");
	});

	it("identifies itself with a polite User-Agent", async () => {
		const calls = stubFetch(() => Response.json({}));
		await fetchClassified("https://itunes.apple.com/search?term=x");
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toContain("AppRankCollector");
	});
});
