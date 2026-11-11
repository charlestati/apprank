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

/**
 * The keys the interface writes, and nothing else.
 *
 * The key arrives in the request path, so without this any signed-in account
 * could store arbitrary text under arbitrary names, each write spending the D1
 * allowance collection depends on. The chart's selection is per app and
 * storefront, hence the one pattern beside the fixed names.
 */
const FIXED_KEYS = new Set(["app", "lang", "health:ack"]);
const CHART_KEY = /^chart:\d{1,20}:[a-z]{2,8}$/u;

export function isPreferenceKey(key: string): boolean {
	return FIXED_KEYS.has(key) || CHART_KEY.test(key);
}

/**
 * Rows one account may hold. A chart selection per app and storefront is the
 * only key that multiplies, so this is far above any real tracked set and far
 * below a table worth filling on purpose.
 */
export const PREFERENCE_ROW_CAP = 200;

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
 *
 * Answers false when the account already holds its cap of rows and this key is
 * not one of them. The count rides in the same statement so two writes cannot
 * both pass a check made beforehand; a key already stored is always updated.
 */
export async function putPreference(
	db: D1Database,
	{ userId, key, value }: { userId: string; key: string; value: string }
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO user_preference (user_id, key, value, updated_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE (SELECT COUNT(*) FROM user_preference WHERE user_id = ?1) < ?5
          OR EXISTS (SELECT 1 FROM user_preference
                     WHERE user_id = ?1 AND key = ?2)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(userId, key, value, Date.now(), PREFERENCE_ROW_CAP)
		.run();
	return result.meta.changes > 0;
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
