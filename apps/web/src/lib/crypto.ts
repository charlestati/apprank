// Constant-time secret comparison, shared by every credential check in this
// Worker.
//
// Secrets here are machine-generated and high-entropy (`openssl rand -base64
// 24`), so there is no offline brute-force for a password KDF to slow down;
// and a KDF would be the most expensive thing in the request on the free
// tier's 10ms CPU budget. Digest-and-compare is the right trade; the only
// property that must hold is that a wrong secret costs the same as a right
// one.

export async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
	);
}

/**
 * Fixed-length, non-short-circuiting comparison. The bitwise accumulate is the
 * point: any early return would leak, through timing, how much of the digest
 * matched.
 */
// oxlint-disable-next-line no-bitwise -- constant-time compare, see above
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (const [i, byte] of a.entries()) {
		// oxlint-disable-next-line no-bitwise -- constant-time compare
		diff |= byte ^ (b[i] as number);
	}
	return diff === 0;
}
