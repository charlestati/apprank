/* oxlint-disable typescript/no-non-null-assertion, unicorn/prefer-code-point --
   the PEM round-trip works on raw bytes; charCode is the intended byte API. */
import { importP8, signJwt } from "@apprank/core/apple/jwt";
import { describe, it, expect } from "vitest";

import { latestCompleteWeekStart } from "../src/tasks/ads";

async function generateP8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
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
		bin += String.fromCharCode(b);
	}
	const b64 = btoa(bin).replaceAll(/(?<chunk>.{64})/gu, "$<chunk>\n");
	return {
		pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
		publicKey: pair.publicKey,
	};
}

function b64urlDecode(s: string): Uint8Array {
	const b64 =
		s.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("ES256 JWT signer", () => {
	it("produces a verifiable JWS with correct header and claims", async () => {
		const { pem, publicKey } = await generateP8Pem();
		const key = await importP8(pem);
		const jwt = await signJwt(
			{ alg: "ES256", kid: "TESTKEY123", typ: "JWT" },
			{ aud: "appstoreconnect-v1", exp: 1_234_567_890, iss: "issuer-id" },
			key
		);
		const [h, p, s] = jwt.split(".");
		expect(h && p && s).toBeTruthy();
		const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h!)));
		expect(header).toStrictEqual({
			alg: "ES256",
			kid: "TESTKEY123",
			typ: "JWT",
		});
		const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p!)));
		expect(payload.aud).toBe("appstoreconnect-v1");
		const ok = await crypto.subtle.verify(
			{ hash: "SHA-256", name: "ECDSA" },
			publicKey,
			b64urlDecode(s!),
			new TextEncoder().encode(`${h}.${p}`)
		);
		expect(ok).toBeTruthy();
	});
});

describe(latestCompleteWeekStart, () => {
	it("returns a Sunday at least 7 days back", () => {
		const d = new Date(
			latestCompleteWeekStart(new Date("2026-08-31T12:00:00Z"))
		); // a Monday
		expect(d.getUTCDay()).toBe(0);
		expect(Date.parse("2026-08-31") - d.getTime()).toBeGreaterThanOrEqual(
			7 * 86_400_000
		);
	});
});
