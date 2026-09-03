// What the reader chose: the app the switcher landed on, the UI language, and
// which keywords are drawn on the chart.
//
// Every row is keyed by the caller's own `user_id`, so there is no ownership
// check to make here and no way to read someone else's: the key is half the
// primary key, not a filter that could be forgotten.

export interface Preference {
	key: string;
	value: string;
}

/** Every preference the caller has set, as one round trip on first paint. */
export function listPreferences(
	db: D1Database,
	userId: string
): Promise<D1Result<Preference>> {
	return db
		.prepare("SELECT key, value FROM user_preference WHERE user_id = ?1")
		.bind(userId)
		.all<Preference>();
}

/**
 * Write one preference.
 *
 * Upsert rather than delete-then-insert: the page writes on every toggle, and
 * a pair of statements would leave a window where the reader's selection does
 * not exist at all.
 */
export function putPreference(
	db: D1Database,
	{ userId, key, value }: { userId: string; key: string; value: string }
): Promise<D1Result> {
	return db
		.prepare(
			`INSERT INTO user_preference (user_id, key, value, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(userId, key, value, Date.now())
		.run();
}

/**
 * Drop a preference, which is how a reader returns to the default rather than
 * pinning whatever the default happened to be on the day they first looked.
 */
export function deletePreference(
	db: D1Database,
	{ userId, key }: { userId: string; key: string }
): Promise<D1Result> {
	return db
		.prepare("DELETE FROM user_preference WHERE user_id = ?1 AND key = ?2")
		.bind(userId, key)
		.run();
}
