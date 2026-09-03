import {
	sha256Hex,
	normalizeApp,
	extractRanking,
	validateSearchResponse,
} from "@apprank/core/normalize/itunes";
import { describe, it, expect } from "vitest";

import { fakeSearchResponse } from "./helpers";

function baseResult() {
	return {
		artistId: 900,
		artistName: "Tracked Dev",
		averageUserRating: 4.5,
		bundleId: "test.app",
		currency: "EUR",
		description: "A description",
		genreIds: ["7019", "6014"],
		price: 0,
		primaryGenreId: 7019,
		releaseNotes: "Bug fixes",
		screenshotUrls: ["https://example.test/a.png"],
		trackId: 424_242,
		trackName: "Tracked App",
		userRatingCount: 70,
		version: "1.2.1",
	};
}

describe(sha256Hex, () => {
	it("returns a stable 64-character hex digest", async () => {
		const a = await sha256Hex("hello");
		expect(a).toMatch(/^[0-9a-f]{64}$/u);
		await expect(sha256Hex("hello")).resolves.toBe(a);
		await expect(sha256Hex("hello ")).resolves.not.toBe(a);
	});
});

describe(normalizeApp, () => {
	it("lifts the app dimension out of a search result", async () => {
		const n = await normalizeApp(baseResult());
		expect({
			bundleId: n.bundleId,
			developerName: n.developerName,
			id: n.id,
			primaryGenreId: n.primaryGenreId,
		}).toStrictEqual({
			bundleId: "test.app",
			developerName: "Tracked Dev",
			id: 424_242,
			primaryGenreId: 7019,
		});
		expect(n.metadata.title).toBe("Tracked App");
		expect(JSON.parse(n.metadata.genreIds)).toStrictEqual(["7019", "6014"]);
	});

	it("stores hashes rather than the bulky fields themselves", async () => {
		const n = await normalizeApp(baseResult());
		expect(n.metadata.descriptionHash).toMatch(/^[0-9a-f]{64}$/u);
		expect(n.metadata.releaseNotesHash).toMatch(/^[0-9a-f]{64}$/u);
		expect(n.metadata.screenshotUrlsHash).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("nulls the hashes when the source fields are absent", async () => {
		const n = await normalizeApp({ trackId: 1 });
		expect(n.metadata.descriptionHash).toBeNull();
		expect(n.metadata.releaseNotesHash).toBeNull();
		expect(n.metadata.screenshotUrlsHash).toBeNull();
		expect(n.metadata.title).toBeNull();
		expect(JSON.parse(n.metadata.genreIds)).toStrictEqual([]);
	});

	it("keeps contentHash stable when nothing ASO-relevant changed", async () => {
		const a = await normalizeApp(baseResult());
		// userRatingCount moves daily and must not count as a metadata change:
		// the rating series lives in rating_snapshot instead.
		const b = await normalizeApp({ ...baseResult(), userRatingCount: 999 });
		expect(b.metadata.contentHash).toBe(a.metadata.contentHash);
	});

	it("changes contentHash when the title, description or screenshots change", async () => {
		const base = await normalizeApp(baseResult());
		const renamed = await normalizeApp({
			...baseResult(),
			trackName: "Renamed",
		});
		const rewritten = await normalizeApp({
			...baseResult(),
			description: "Different copy",
		});
		const reshot = await normalizeApp({
			...baseResult(),
			screenshotUrls: ["https://example.test/b.png"],
		});
		expect(renamed.metadata.contentHash).not.toBe(base.metadata.contentHash);
		expect(rewritten.metadata.contentHash).not.toBe(base.metadata.contentHash);
		expect(reshot.metadata.contentHash).not.toBe(base.metadata.contentHash);
	});

	it("prefers the 512px icon and falls back to the 100px one", async () => {
		const big = await normalizeApp({
			...baseResult(),
			artworkUrl100: "https://example.test/small.png",
			artworkUrl512: "https://example.test/big.png",
		});
		expect(big.metadata.iconUrl).toBe("https://example.test/big.png");
		const small = await normalizeApp({
			...baseResult(),
			artworkUrl100: "https://example.test/small.png",
		});
		expect(small.metadata.iconUrl).toBe("https://example.test/small.png");
	});
});

describe(extractRanking, () => {
	it("keeps the full ordered list of track ids", () => {
		const { resultIds, resultCount } = extractRanking(fakeSearchResponse(200));
		expect(resultCount).toBe(200);
		expect(resultIds).toHaveLength(200);
		expect(resultIds[0]).toBe(100);
		expect(resultIds.at(-1)).toBe(299);
	});

	it("handles an empty result set", () => {
		const { resultIds, resultCount } = extractRanking({
			resultCount: 0,
			results: [],
		});
		expect(resultCount).toBe(0);
		expect(resultIds).toStrictEqual([]);
	});
});

describe(validateSearchResponse, () => {
	it("accepts a well-formed response", () => {
		expect(
			validateSearchResponse({ resultCount: 0, results: [] })
		).toBeTruthy();
	});

	it("rejects anything that is not a search response", () => {
		expect(validateSearchResponse(null)).toBeFalsy();
		expect(validateSearchResponse("string")).toBeFalsy();
		expect(validateSearchResponse({ results: [] })).toBeFalsy();
		expect(validateSearchResponse({ resultCount: 1 })).toBeFalsy();
		expect(
			validateSearchResponse({ resultCount: "1", results: [] })
		).toBeFalsy();
	});
});
