import { vi } from "vitest";

export interface StubbedCall {
	url: string;
	init?: RequestInit;
}

/**
 * Stub global fetch for the duration of a test. vitest-pool-workers runs tests
 * in the same isolate as the Worker and its Durable Objects, so this
 * intercepts the collector's own outbound requests too.
 */
export function stubFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): StubbedCall[] {
	const calls: StubbedCall[] = [];
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ init, url });
		return Promise.resolve(handler(url, init));
	});
	return calls;
}

/** A PKCS#8 EC P-256 key in PEM form, plus its public half for verification. */
export async function generateP8Pem(): Promise<{
	pem: string;
	publicKey: CryptoKey;
}> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"]
	);
	const der = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey)
	);
	let bin = "";
	for (const b of der) {
		bin += String.fromCodePoint(b);
	}
	const b64 = btoa(bin).replaceAll(/(?<chunk>.{64})/gu, "$<chunk>\n");
	return {
		pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
		publicKey: pair.publicKey,
	};
}

/** An iTunes search response with `count` results, ids starting at `startId`. */
export function fakeSearchResponse(count: number, startId = 100) {
	return {
		resultCount: count,
		results: Array.from({ length: count }, (_, i) => ({
			artistId: 900 + i,
			artistName: `Dev ${i}`,
			averageUserRating: 4 + (i % 2) / 2,
			currency: "EUR",
			description: `Description ${i}`,
			genreIds: ["7019"],
			price: 0,
			primaryGenreId: 7019,
			releaseNotes: `Notes ${i}`,
			screenshotUrls: [`https://example.test/s${i}.png`],
			trackId: startId + i,
			trackName: `App ${i}`,
			userRatingCount: 10 * i,
			version: `1.${i}`,
		})),
	};
}
