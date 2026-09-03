// ES256 JWT signing via WebCrypto, shared by Apple Ads, App Store Connect, and
// Sign in with Apple. Runs natively in workerd; no Node crypto needed.

function base64url(data: Uint8Array | string): string {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	let bin = "";
	for (const b of bytes) {
		bin += String.fromCodePoint(b);
	}
	return btoa(bin)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

/** Import a PEM-encoded PKCS#8 EC P-256 private key (.p8 file contents). */
export function importP8(pem: string): Promise<CryptoKey> {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/u, "")
		.replace(/-----END PRIVATE KEY-----/u, "")
		.replaceAll(/\s+/gu, "");
	const der = Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
	return crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"]
	);
}

export interface JwtHeader {
	alg: "ES256";
	kid: string;
	typ?: "JWT";
}

export async function signJwt(
	header: JwtHeader,
	payload: Record<string, unknown>,
	key: CryptoKey
): Promise<string> {
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const sig = await crypto.subtle.sign(
		{ hash: "SHA-256", name: "ECDSA" },
		key,
		new TextEncoder().encode(signingInput)
	);
	// WebCrypto returns the raw 64-byte (r,s) signature, exactly the JWS ES256
	// format.
	return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

export function nowEpochSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
