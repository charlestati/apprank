// Bearer-token gate for the collector's one public route.
//
// The collector otherwise has no HTTP surface at all, and that was deliberate.
// It gained one because there is no other way to fire a job on the deployed
// Worker: `wrangler dev --remote` refuses to run a Worker that declares a
// Durable Object, and the job cron fires once a day. Verifying a freshly
// issued Apple credential should not cost a day, and a weekly job should not
// cost a week.
//
// The token is compared as a SHA-256 digest in constant time, for the same
// reason as apps/web: these are machine-generated high-entropy secrets, so
// there is no offline brute-force for a KDF to slow down, and the free tier's
// 10ms CPU budget is better spent elsewhere.

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
	);
}

/**
 * Fixed-length, non-short-circuiting comparison. The bitwise accumulate is the
 * point: any early return would leak, through timing, how much matched.
 */
// oxlint-disable-next-line no-bitwise -- constant-time compare, see above
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
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

export function bearer(header: string | null): string | null {
	if (!header?.startsWith("Bearer ")) {
		return null;
	}
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 ? token : null;
}

/**
 * `configured: false` means no ADMIN_TOKEN secret is set. The route then does
 * not exist at all — an unconfigured collector must never be remotely
 * triggerable, so this fails closed exactly like the web Worker's wall.
 */
export async function authorize(
	header: string | null,
	expected: string | undefined
): Promise<{ ok: boolean; configured: boolean }> {
	if (!expected) {
		return { configured: false, ok: false };
	}
	const given = bearer(header);
	if (given === null) {
		return { configured: true, ok: false };
	}
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	return { configured: true, ok: timingSafeEqual(a, b) };
}
