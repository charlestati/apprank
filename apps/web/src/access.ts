// Who may see what.
//
// Two separate questions, and both have to be answered on every request:
//
//   1. Is this a signed-in operator at all?  (the session gate)
//   2. Does *this* operator track the app or keyword being asked about?
//      (ownership — without it, any signed-in user could read another's data
//      by walking ids, since app and pair ids are guessable integers)
//
// Ranking observations are deliberately shared: `crawl_pair` is the union of
// what everyone tracks, so two operators watching the same keyword produce one
// crawl. Ownership therefore gates *access to a pair's data*, not the data
// itself — you may read a pair when you track that keyword.
//
// The checks take a database and a user id rather than a request context, so
// that a second transport (anything that is not an HTTP route) enforces the
// same rule by calling the same function instead of reimplementing it. The
// `caller*` wrappers are the HTTP-shaped sugar over them.

import type { Context } from "hono";

import type { Env } from "./env";

export interface Vars {
	userId: string;
}

export type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

/** Does this operator track this app? */
export async function ownsApp(
	db: D1Database,
	userId: string,
	appId: number
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 AS ok FROM tracked_app WHERE user_id = ?1 AND app_id = ?2"
		)
		.bind(userId, appId)
		.first();
	return row !== null;
}

/**
 * Does this operator track the keyword behind this crawl pair? Pairs are
 * shared between operators by design, so the check is on the keyword rather
 * than on the pair row itself.
 */
export async function ownsPair(
	db: D1Database,
	userId: string,
	pairId: number
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
     FROM crawl_pair cp
     JOIN tracked_keyword tk ON tk.keyword_id = cp.keyword_id
     WHERE cp.id = ?1 AND tk.user_id = ?2`
		)
		.bind(pairId, userId)
		.first();
	return row !== null;
}

export function callerOwnsApp(c: AppContext, appId: number): Promise<boolean> {
	return ownsApp(c.env.DB, c.get("userId"), appId);
}

export function callerOwnsPair(
	c: AppContext,
	pairId: number
): Promise<boolean> {
	return ownsPair(c.env.DB, c.get("userId"), pairId);
}

/**
 * 404 rather than 403 on a resource the caller does not own: a 403 would
 * confirm that the id exists, which is itself information about someone else's
 * account.
 */
export function notFound(c: AppContext) {
	return c.json({ error: "not found" }, 404);
}
