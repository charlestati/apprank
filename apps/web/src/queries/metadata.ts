// Metadata change events for a tracked app.
//
// `app_metadata_version` holds one row per *change*, not per sighting — the
// dedupe index is on the content hash — so this table is already the event log.
// A rank move is only interpretable against the release that might have caused
// it, which is why these are the anchors the rank chart draws markers on.

export interface MetadataChange {
	capturedAt: number;
	date: string;
	version: string | null;
	title: string | null;
	subtitle: string | null;
	price: number | null;
	hasIap: boolean | null;
	ratingCount: number | null;
	ratingAvg: number | null;
	source: string;
	/** Which fields differ from the previous version we hold. */
	changed: string[];
}

const TRACKED_FIELDS = [
	["title", "title"],
	["subtitle", "subtitle"],
	["version", "version"],
	["price", "price"],
	["has_iap", "hasIap"],
	["description_hash", "description"],
	["release_notes_hash", "releaseNotes"],
	["screenshot_urls_hash", "screenshots"],
	["icon_url", "icon"],
] as const;

type VersionRow = Record<string, unknown> & {
	captured_at: number;
	source: string;
};

export async function metadataChanges(
	db: D1Database,
	appId: number,
	from: string,
	to: string,
	limit: number
): Promise<MetadataChange[]> {
	// One extra row before the window, so the oldest change in range can still be
	// diffed against what preceded it rather than reported as "everything changed".
	const rows = await db
		.prepare(
			`SELECT captured_at, version, title, subtitle, price, has_iap, icon_url,
              rating_count, rating_avg, source, description_hash,
              release_notes_hash, screenshot_urls_hash
       FROM app_metadata_version
       WHERE app_id = ?1 AND DATE(captured_at / 1000, 'unixepoch') <= ?3
       ORDER BY captured_at DESC
       LIMIT ?4`
		)
		.bind(appId, from, to, limit + 1)
		.all<VersionRow>();

	const ordered = rows.results.toReversed();
	const changes: MetadataChange[] = [];
	for (const [i, row] of ordered.entries()) {
		const date = new Date(row.captured_at).toISOString().slice(0, 10);
		if (date < from) {
			continue;
		}
		const previous = i > 0 ? ordered[i - 1] : undefined;
		const changed = previous
			? TRACKED_FIELDS.filter(
					([column]) => row[column] !== previous[column]
				).map(([, label]) => label)
			: ["firstSeen"];
		changes.push({
			capturedAt: row.captured_at,
			changed,
			date,
			hasIap: row.has_iap === null ? null : row.has_iap === 1,
			price: row.price as number | null,
			ratingAvg: row.rating_avg as number | null,
			ratingCount: row.rating_count as number | null,
			source: row.source,
			subtitle: row.subtitle as string | null,
			title: row.title as string | null,
			version: row.version as string | null,
		});
	}
	return changes.slice(-limit);
}
