// Tier-2 → Tier-1 promotion suggestions. A suggestion belongs to whoever
// tracks the app it concerns, so the user id is part of every statement rather
// than a check performed beside one.

export function listSuggestions(db: D1Database, userId: string) {
	return db
		.prepare(
			"SELECT * FROM suggestion WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC"
		)
		.bind(userId)
		.all();
}

/** Returns how many rows changed: 0 means the suggestion is not the caller's. */
export async function setSuggestionStatus(
	db: D1Database,
	userId: string,
	id: number,
	status: "accepted" | "dismissed"
): Promise<number> {
	const updated = await db
		.prepare("UPDATE suggestion SET status = ?1 WHERE id = ?2 AND user_id = ?3")
		.bind(status, id, userId)
		.run();
	return updated.meta.changes;
}
