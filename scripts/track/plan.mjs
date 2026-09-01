// What the tracked set should become, expressed as SQL — the decision half of
// `pnpm track`, kept free of I/O so it can be reasoned about and tested.
//
// Three rules shape everything here, and all three come from the invariants:
//
//   Nothing is ever deleted. Removing a keyword from the config retires its
//   crawl pairs by dropping ref_count to zero; the rows and every observation
//   attached to them survive, because a day not collected cannot be recovered
//   and a day deleted is the same thing.
//
//   crawl_pair is the reference-counted union of what everyone tracks, so two
//   people asking for the same keyword in the same storefront share one row and
//   therefore one fetch a day.
//
//   Only differences are emitted. A re-run that changes nothing must cost no
//   row-writes: D1 charges for a conflicting upsert even when it updates
//   nothing, and the free tier's daily budget is the binding constraint.

/** Lowercase, NFC, trimmed — the form `keyword.normalized` stores. */
export function normalize(text) {
	return text.toLowerCase().normalize("NFC").trim();
}

/**
 * The locale a storefront indexes for this app's language, else the
 * storefront's own default.
 *
 * Apple cross-localizes: Canada indexes fr-CA, Belgium fr-FR. Where a
 * storefront indexes nothing in the app's language — Spain, for a French app —
 * the default locale is the honest description of the query being made, rather
 * than inventing a cross-localization Apple does not publish.
 */
export function localeFor(storefront, language, storefrontLocales) {
	const rows = storefrontLocales.filter(
		(r) => r.storefront_code === storefront
	);
	const matching = rows.find((r) => r.language === language);
	if (matching) {
		return matching.locale_code;
	}
	return rows.find((r) => r.is_default === 1)?.locale_code ?? null;
}

/**
 * Pairs nobody asks for any more. They are retired, never deleted: the row and
 * every observation hanging off it outlive the decision to stop tracking, so
 * putting the keyword back restores its history rather than starting over.
 */
function retireUnwanted(activePair, wantedPairs, summary) {
	const out = [];
	for (const [key, pair] of activePair) {
		if (!wantedPairs.has(key) && pair.ref_count > 0) {
			out.push(`UPDATE crawl_pair SET ref_count = 0 WHERE id = ${pair.id};`);
			summary.pairsRetired += 1;
		}
	}
	return out;
}

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param config  { [userId]: { apps: [{ appId, name, language, storefronts,
 *   keywords }] } } — a list, because one person routinely ships more than one
 *   app and `tracked_app` has always been keyed (user_id, app_id).
 * @param state   rows already in the database
 * @returns The SQL to run, counts for the human-readable plan, and any
 *   storefront the reference data does not know about.
 */
export function planChanges(config, state) {
	const statements = [];
	const warnings = [];
	const summary = {
		apps: 0,
		keywordsAdded: 0,
		pairsActivated: 0,
		pairsRetired: 0,
		tracksAdded: 0,
		tracksRemoved: 0,
	};

	const knownKeyword = new Map(
		state.keywords.map((k) => [`${k.normalized}:${k.language}`, k.id])
	);
	// Every (user, app, keyword) the config asks for, and every pair it implies.
	const wantedTracks = new Set();
	const wantedPairs = new Map();

	for (const [userId, entry] of Object.entries(config)) {
		// Keys beginning with an underscore are notes for whoever edits the file,
		// not operators. The shipped example leans on this, and treating one as a
		// user crashes on the first missing field.
		if (userId.startsWith("_")) {
			continue;
		}
		// A bare object is the single-app shorthand; the canonical form is a list.
		const apps = Array.isArray(entry.apps) ? entry.apps : [entry];
		for (const app of apps) {
			const { appId, name, language, storefronts, keywords } = app;
			summary.apps += 1;

			if (!state.apps.some((a) => a.id === appId)) {
				statements.push(
					`INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (${appId}, ${sqlString(name)}, strftime('%s','now')*1000, strftime('%s','now')*1000);`
				);
			}
			if (
				!state.trackedApps.some(
					(t) => t.user_id === userId && t.app_id === appId
				)
			) {
				statements.push(
					`INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES (${sqlString(userId)}, ${appId}, strftime('%s','now')*1000);`
				);
			}
			if (
				!state.appLanguages.some(
					(l) => l.app_id === appId && l.language === language
				)
			) {
				statements.push(
					`INSERT OR IGNORE INTO app_language (app_id, language) VALUES (${appId}, ${sqlString(language)});`
				);
			}

			for (const raw of keywords) {
				const text = raw.trim();
				const norm = normalize(text);
				const key = `${norm}:${language}`;
				if (!knownKeyword.has(key)) {
					statements.push(
						`INSERT OR IGNORE INTO keyword (text, normalized, language) VALUES (${sqlString(text)}, ${sqlString(norm)}, ${sqlString(language)});`
					);
					knownKeyword.set(key, null); // id resolved by subquery below
					summary.keywordsAdded += 1;
				}
				wantedTracks.add(`${userId}|${appId}|${key}`);

				const idExpr = `(SELECT id FROM keyword WHERE normalized = ${sqlString(norm)} AND language = ${sqlString(language)})`;
				if (
					!state.trackedKeywords.some(
						(t) =>
							t.user_id === userId &&
							t.app_id === appId &&
							t.normalized === norm &&
							t.language === language
					)
				) {
					statements.push(
						`INSERT OR IGNORE INTO tracked_keyword (user_id, app_id, keyword_id, created_at) SELECT ${sqlString(userId)}, ${appId}, id, strftime('%s','now')*1000 FROM keyword WHERE normalized = ${sqlString(norm)} AND language = ${sqlString(language)};`
					);
					summary.tracksAdded += 1;
				}

				for (const storefront of storefronts) {
					const locale = localeFor(
						storefront,
						language,
						state.storefrontLocales
					);
					if (!locale) {
						warnings.push(
							`${storefront}: not in the reference data — add the storefront and its locales first`
						);
						continue;
					}
					wantedPairs.set(`${norm}:${language}|${storefront}|${locale}`, {
						idExpr,
						locale,
						storefront,
					});
				}
			}
		}
	}

	// Tracks the config no longer asks for. The row goes; the crawl pair and its
	// observations do not.
	for (const t of state.trackedKeywords) {
		const key = `${t.user_id}|${t.app_id}|${t.normalized}:${t.language}`;
		if (!wantedTracks.has(key)) {
			statements.push(
				`DELETE FROM tracked_keyword WHERE user_id = ${sqlString(t.user_id)} AND app_id = ${t.app_id} AND keyword_id = ${t.keyword_id};`
			);
			summary.tracksRemoved += 1;
		}
	}

	const activePair = new Map(
		state.crawlPairs.map((p) => [
			`${p.normalized}:${p.language}|${p.storefront_code}|${p.locale_code}`,
			p,
		])
	);

	for (const [key, want] of wantedPairs) {
		const existing = activePair.get(key);
		if (!existing) {
			statements.push(
				`INSERT OR IGNORE INTO crawl_pair (keyword_id, storefront_code, locale_code, tier, ref_count, interval_hours, next_due_at, volatility) SELECT ${want.idExpr}, ${sqlString(want.storefront)}, ${sqlString(want.locale)}, 1, 1, 24, strftime('%s','now')*1000, 0;`
			);
			summary.pairsActivated += 1;
		} else if (existing.ref_count === 0) {
			// Retired earlier; bring it back without disturbing its history.
			statements.push(
				`UPDATE crawl_pair SET ref_count = 1 WHERE id = ${existing.id};`
			);
			summary.pairsActivated += 1;
		}
	}

	statements.push(...retireUnwanted(activePair, wantedPairs, summary));

	return { statements, summary, warnings };
}
