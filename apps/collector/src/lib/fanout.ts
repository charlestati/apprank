// The daily app-level fan-out: which (app, storefront) targets get a metadata
// lookup and a review feed, and which charts are pulled.
//
// One definition, read twice. The daily job builds its queues from it and the
// cadence planner charges the same work against the day's budget. When each
// derived the set on its own they disagreed: the planner counted the
// storefronts that hold a crawl pair times a constant two genres, while the
// job queued every target storefront times the tracked genres plus one, so
// three tracked genres over five storefronts cost sixty chart pulls against
// thirty budgeted, and the plan scheduled crawls the window could not hold.

import { getStateJson } from "./state";

export const CHARTS = ["free", "paid", "grossing"] as const;

export interface PullTarget {
	app_id: number;
	code: string;
	locale_code: string;
}

/**
 * The genres to work in: the distinct primary genre of every tracked app.
 *
 * A hardcoded list here is wrong for every operator whose app is in another
 * category, and invariant 5 keeps reference data in rows. Apple already tells
 * us the answer: primary_genre_id is written on every app the collector sees,
 * so no extra fetch is needed.
 *
 * Empty is a real answer rather than a failure. On a fresh deploy no app has
 * been looked up yet, and under COLLECTION_MODE=credentialed that lookup runs
 * from the Actions runner rather than this Worker, so the column stays null
 * until the first run lands. Guessing a category then would write popularity
 * for terms nobody tracks.
 */
export async function trackedGenreIds(db: D1Database): Promise<number[]> {
	const rows = await db
		.prepare(
			`SELECT DISTINCT a.primary_genre_id AS id
       FROM tracked_app t
       JOIN app a ON a.id = t.app_id
      WHERE a.primary_genre_id IS NOT NULL`
		)
		.all<{ id: number }>();
	return rows.results.map((r) => r.id);
}

/**
 * Every (tracked app, storefront) the app-level pulls cover, with the locale
 * to ask in.
 *
 * Coverage is the union of two sources because neither alone is right.
 * Content language (language ≠ storefront) gives the storefronts Apple
 * cross-localises the app into, which is what an app tracked before it has
 * any keywords should still get. Live crawl pairs give the storefronts
 * somebody actually chose, and they are the only way a storefront indexing
 * nothing in the app's language is reached at all: Spain for a French app
 * indexes Spanish, Catalan and English, so the language join can never
 * produce it, and on its own that storefront yields keyword ranks with no
 * metadata, reviews or charts for as long as it runs.
 *
 * Locale preference, in order: the storefront's own default among the app's
 * languages, then any locale in one of them, then the pair's. The first rung
 * is what makes a multi-language app correct, and app_language is a set with
 * no primary: a French *and* English app indexes both fr-FR and en-GB in
 * France, and picking by name alone would fetch the English listing and store
 * it as France's. Apple honours the lang parameter whenever the app really is
 * localised in that storefront, so that metadata would be wrong, not merely
 * mislabelled. Belgium is why the second rung exists: it indexes French, but
 * its default is English, so a French-only app has no default to match.
 *
 * Every branch is an aggregate rather than a bare column on purpose: SQLite
 * only pins a bare column to the min()/max() row when there is exactly one
 * such aggregate, and on ties it picks among them arbitrarily.
 */
export async function pullTargets(db: D1Database): Promise<PullTarget[]> {
	const rows = await db
		.prepare(
			`SELECT app_id, code,
            COALESCE(
              MIN(CASE WHEN pref = 0 AND is_default = 1 THEN locale_code END),
              MIN(CASE WHEN pref = 0 THEN locale_code END),
              MIN(CASE WHEN pref = 1 THEN locale_code END)
            ) AS locale_code
       FROM (
         SELECT ta.app_id AS app_id, sl.storefront_code AS code,
                sl.locale_code AS locale_code, sl.is_default AS is_default,
                0 AS pref
           FROM tracked_app ta
           JOIN app_language al ON al.app_id = ta.app_id
           JOIN locale l ON l.language = al.language
           JOIN storefront_locale sl ON sl.locale_code = l.code
           JOIN storefront s ON s.code = sl.storefront_code AND s.active = 1
         UNION ALL
         SELECT tk.app_id AS app_id, cp.storefront_code AS code,
                cp.locale_code AS locale_code, 0 AS is_default, 1 AS pref
           FROM tracked_keyword tk
           JOIN crawl_pair cp ON cp.keyword_id = tk.keyword_id AND cp.ref_count > 0
           JOIN storefront s ON s.code = cp.storefront_code AND s.active = 1
       )
      GROUP BY app_id, code`
		)
		.all<PullTarget>();
	return rows.results;
}

/**
 * The genres each storefront is charted in. null is the storefront-wide
 * chart, which needs no genre, so charts still work on day one when no app has
 * been looked up yet. The `chart_genres` collector_state key overrides the
 * tracked set.
 */
export async function chartGenres(db: D1Database): Promise<(number | null)[]> {
	return (
		(await getStateJson<(number | null)[]>(db, "chart_genres")) ?? [
			...(await trackedGenreIds(db)),
			null,
		]
	);
}

/** The storefronts the targets span; the chart set is per storefront. */
export function targetStorefronts(targets: PullTarget[]): string[] {
	return [...new Set(targets.map((t) => t.code))];
}
