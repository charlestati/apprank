// Cloudflare Access as the browser sign-in.
//
// Access sits in front of the Worker, runs the login (an identity provider or
// a one-time code by email) and keeps the session for as long as the
// application's session duration says, which is what Basic could not do: no
// password to fill, and no prompt every time the browser forgets it.
//
// The Worker still verifies every request itself. Access attaches a signed JWT
// as `Cf-Access-Jwt-Assertion`; trusting the header's presence instead of its
// signature would let anyone who reaches the Worker by a route Access does not
// cover (a preview URL, a hostname added later, a policy edited by mistake)
// claim any email they like. The check is RS256 over WebCrypto: no dependency,
// and well inside the free tier's CPU budget.
//
// Configuration is three values, all per-deployment and none of them in the
// repository, which is public:
//
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   ACCESS_AUD          the application's Audience (AUD) tag
//   ACCESS_USERS        secret, [{ "email": "…", "userId": "admin" }]
//
// `userId` plays the same part as in BASIC_AUTH_ACCOUNTS: it is what
// `tracked_app.user_id` and the ownership checks compare against, so it is the
// durable identity. It defaults to the email.

export interface AccessUser {
	email: string;
	userId: string;
}

export interface AccessConfig {
	teamDomain: string;
	aud: string;
	users: AccessUser[];
}

interface AccessEnv {
	ACCESS_TEAM_DOMAIN?: string | undefined;
	ACCESS_AUD?: string | undefined;
	ACCESS_USERS?: string | undefined;
}

/** "team.cloudflareaccess.com" or its https URL, with or without a slash. */
export function normaliseTeamDomain(raw?: string): string | null {
	const trimmed = raw?.trim().replace(/\/+$/u, "");
	if (!trimmed) {
		return null;
	}
	const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	// The issuer claim is compared against this exactly, and Access only ever
	// issues from the bare https origin.
	if (url.protocol !== "https:" || url.pathname !== "/") {
		return null;
	}
	return url.origin;
}

export function parseAccessUsers(raw?: string): AccessUser[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// A malformed secret must lock the door, not open it.
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap((entry) => {
		const u = entry as Partial<AccessUser>;
		if (typeof u.email !== "string" || !u.email.trim()) {
			return [];
		}
		const email = u.email.trim().toLowerCase();
		return [{ email, userId: u.userId ?? email }];
	});
}

/**
 * `absent` when none of the three is set, so a deployment that never asked for
 * Access keeps Basic. `incomplete` when some are set but not all of them
 * usable: that is a half-finished switch, and falling back to Basic (or to
 * nothing) would be a guess about which half the operator meant.
 */
export function accessConfig(
	env: AccessEnv
): AccessConfig | "absent" | "incomplete" {
	const { ACCESS_AUD, ACCESS_TEAM_DOMAIN, ACCESS_USERS } = env;
	if (!(ACCESS_AUD || ACCESS_TEAM_DOMAIN || ACCESS_USERS)) {
		return "absent";
	}
	const teamDomain = normaliseTeamDomain(ACCESS_TEAM_DOMAIN);
	const users = parseAccessUsers(ACCESS_USERS);
	const aud = ACCESS_AUD?.trim();
	if (!(teamDomain && aud && users.length > 0)) {
		return "incomplete";
	}
	return { aud, teamDomain, users };
}

/** Resolves a key id to the public key Access signed with, if it knows one. */
export type KeyLoader = (
	teamDomain: string,
	kid: string
) => Promise<CryptoKey | undefined>;

const RS256 = { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" } as const;

// Access rotates its signing key every six weeks and keeps the previous one
// valid for seven days, so the set is refetched hourly and on an unknown key
// id. The floor on refetching stops a stream of forged key ids from turning
// every request into a subrequest to the certs endpoint.
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;
const KEYS_MIN_REFETCH_MS = 60 * 1000;

interface KeySet {
	fetchedAt: number;
	keys: Map<string, CryptoKey>;
}

const keySets = new Map<string, KeySet>();

async function fetchKeySet(teamDomain: string): Promise<KeySet> {
	const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) {
		throw new Error(`Access certs answered HTTP ${res.status}`);
	}
	const body = (await res.json()) as {
		keys?: (JsonWebKey & { kid?: string })[];
	};
	const keys = new Map<string, CryptoKey>();
	for (const jwk of body.keys ?? []) {
		if (jwk.kid && jwk.kty === "RSA") {
			keys.set(
				jwk.kid,
				await crypto.subtle.importKey("jwk", jwk, RS256, false, ["verify"])
			);
		}
	}
	return { fetchedAt: Date.now(), keys };
}

/**
 * The production loader: the team's published key set, cached per isolate.
 * Throws when the certs endpoint cannot be read, which the gate turns into a
 * 503 rather than a 401: the caller did nothing wrong.
 */
export const remoteKeys: KeyLoader = async (teamDomain, kid) => {
	const now = Date.now();
	let set = keySets.get(teamDomain);
	const stale = !set || now - set.fetchedAt > KEYS_MAX_AGE_MS;
	const unknown =
		set && !set.keys.has(kid) && now - set.fetchedAt > KEYS_MIN_REFETCH_MS;
	if (stale || unknown) {
		set = await fetchKeySet(teamDomain);
		keySets.set(teamDomain, set);
	}
	return set?.keys.get(kid);
};

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
	const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	return Uint8Array.from(binary, (ch) => ch.codePointAt(0) as number);
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
	const value: unknown = JSON.parse(
		new TextDecoder().decode(base64UrlBytes(segment))
	);
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

// Tolerance for clock drift between Access and the edge running the Worker.
const LEEWAY_S = 60;

/** The email a verified token's claims vouch for, if they hold right now. */
function claimedEmail(
	payload: Record<string, unknown>,
	config: Pick<AccessConfig, "aud" | "teamDomain">,
	nowSeconds: number
): string | null {
	const { aud, email, exp, iss, nbf } = payload;
	const audiences = Array.isArray(aud) ? aud : [aud];
	if (!audiences.includes(config.aud) || iss !== config.teamDomain) {
		return null;
	}
	if (typeof exp !== "number" || exp + LEEWAY_S < nowSeconds) {
		return null;
	}
	if (typeof nbf === "number" && nbf - LEEWAY_S > nowSeconds) {
		return null;
	}
	if (typeof email !== "string" || !email) {
		return null;
	}
	return email.toLowerCase();
}

/**
 * The verified email, lowercased, or null for any token that is malformed,
 * signed by a key Access did not publish, meant for another application or
 * issuer, expired, or carries no email (a service token, which has no person
 * behind it to map to a userId).
 */
export async function verifyAccessToken(
	token: string | null | undefined,
	config: Pick<AccessConfig, "aud" | "teamDomain">,
	loadKey: KeyLoader = remoteKeys,
	nowSeconds: number = Date.now() / 1000
): Promise<string | null> {
	const parts = token?.split(".");
	if (parts?.length !== 3) {
		return null;
	}
	const [rawHeader, rawPayload, rawSignature] = parts as [
		string,
		string,
		string,
	];

	let header: Record<string, unknown> | null;
	let payload: Record<string, unknown> | null;
	let signature: Uint8Array<ArrayBuffer>;
	try {
		header = base64UrlJson(rawHeader);
		payload = base64UrlJson(rawPayload);
		signature = base64UrlBytes(rawSignature);
	} catch {
		return null;
	}
	// The algorithm is pinned, never read from the token: honouring `alg`
	// is how "none" and HMAC-with-the-public-key forgeries get in.
	if (header?.alg !== "RS256" || typeof header.kid !== "string" || !payload) {
		return null;
	}

	const key = await loadKey(config.teamDomain, header.kid);
	if (!key) {
		return null;
	}
	const valid = await crypto.subtle.verify(
		RS256,
		key,
		signature,
		new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
	);
	if (!valid) {
		return null;
	}

	return claimedEmail(payload, config, nowSeconds);
}

export type AccessOutcome =
	| { ok: true; userId: string }
	| { ok: false; status: 401 | 403 };

/**
 * 401 when there is no valid token; 403 when the token is genuine but its
 * email is not an AppRank user. That one is safe to say: the caller has proved
 * who they are, and the answer names nobody else.
 */
export async function authenticateAccess(
	token: string | null | undefined,
	config: AccessConfig,
	loadKey: KeyLoader = remoteKeys
): Promise<AccessOutcome> {
	const email = await verifyAccessToken(token, config, loadKey);
	if (!email) {
		return { ok: false, status: 401 };
	}
	const user = config.users.find((u) => u.email === email);
	if (!user) {
		return { ok: false, status: 403 };
	}
	return { ok: true, userId: user.userId };
}
