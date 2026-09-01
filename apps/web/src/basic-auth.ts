// HTTP Basic authentication against a fixed set of accounts.
//
// Accounts live in the BASIC_AUTH_ACCOUNTS secret as JSON — never in the
// repository, which is public:
//
//   [
//     { "username": "operator", "password": "…", "userId": "admin" },
//     { "username": "alice",   "password": "…", "userId": "alice" }
//   ]
//
// `userId` is what the ownership checks compare against (`tracked_app.user_id`),
// so it is the durable identity: change a password freely, but changing a
// userId re-points that person at a different set of tracked apps. It defaults
// to the username.
//
// Passwords are compared against their SHA-256 digests in constant time; see
// `lib/crypto.ts` for why a password KDF would be the wrong call here.

import { digest, timingSafeEqual } from "./lib/crypto";

export interface Account {
	username: string;
	password: string;
	userId: string;
}

export interface AuthOutcome {
	ok: boolean;
	userId?: string;
	username?: string;
}

export function parseAccounts(raw?: string): Account[] {
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
		const a = entry as Partial<Account>;
		if (!(a.username && a.password)) {
			return [];
		}
		return [
			{
				password: a.password,
				userId: a.userId ?? a.username,
				username: a.username,
			},
		];
	});
}

/** "Basic dXNlcjpwYXNz" → { username, password }. */
export function decodeHeader(
	header: string | null
): { username: string; password: string } | null {
	if (!header?.startsWith("Basic ")) {
		return null;
	}
	let decoded: string;
	try {
		decoded = atob(header.slice("Basic ".length).trim());
	} catch {
		return null;
	}
	const separator = decoded.indexOf(":");
	if (separator === -1) {
		return null;
	}
	return {
		password: decoded.slice(separator + 1),
		username: decoded.slice(0, separator),
	};
}

export async function authenticate(
	header: string | null,
	accounts: Account[]
): Promise<AuthOutcome> {
	const credentials = decodeHeader(header);
	if (!credentials) {
		return { ok: false };
	}

	const account = accounts.find((a) => a.username === credentials.username);
	// Hash and compare even when the username is unknown, so a missing account
	// costs the same as a wrong password. The sentinel only has to be a string
	// no configured password can equal, and it stays written as an escape: a
	// literal NUL in the source makes git classify this file as binary, so the
	// one file most worth reading in a review is the one it will not diff.
	const expected = account?.password ?? "\u0000no-such-account";
	const [given, want] = await Promise.all([
		digest(credentials.password),
		digest(expected),
	]);

	if (!(account && timingSafeEqual(given, want))) {
		return { ok: false };
	}
	return { ok: true, userId: account.userId, username: account.username };
}

/** The challenge that makes a browser show its credential prompt. */
export function challenge(): Record<string, string> {
	return { "WWW-Authenticate": 'Basic realm="AppRank", charset="UTF-8"' };
}
