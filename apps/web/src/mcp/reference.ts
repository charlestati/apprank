// Reference data as tool parameter enums.
//
// Storefronts and genres are rows, not code, so adding one is an INSERT and
// must
// never need a redeploy. So the enums are built from the database rather than
// hardcoded, and cached per isolate for a few minutes: a new storefront shows
// up within the TTL, and a cold isolate picks it up immediately. The cost of
// getting this wrong is a tool that cannot see a market the collector is
// already crawling.

export interface ReferenceData {
	storefronts: string[];
	genreIds: number[];
	charts: readonly ["free", "paid", "grossing"];
}

const TTL_MS = 300_000;

let cache: { at: number; data: ReferenceData } | null = null;

/** Tests share one isolate with the Worker, so the cache has to be resettable. */
export function clearReferenceCache(): void {
	cache = null;
}

export async function referenceData(
	db: D1Database,
	now: number = Date.now()
): Promise<ReferenceData> {
	if (cache && now - cache.at < TTL_MS) {
		return cache.data;
	}
	const [storefronts, genres] = await Promise.all([
		db
			.prepare("SELECT code FROM storefront WHERE active = 1 ORDER BY code")
			.all<{ code: string }>(),
		db.prepare("SELECT id FROM genre ORDER BY id").all<{ id: number }>(),
	]);
	const data: ReferenceData = {
		charts: ["free", "paid", "grossing"],
		genreIds: genres.results.map((g) => g.id),
		storefronts: storefronts.results.map((s) => s.code),
	};
	cache = { at: now, data };
	return data;
}
