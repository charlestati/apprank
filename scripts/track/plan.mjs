// What the tracked set should become, expressed as SQL: the decision half of
// `pnpm track`, kept free of I/O so it can be reasoned about and tested.
//
// Four rules shape everything here, and all four come from the invariants:
//
//   The database is the source of truth, the file a local copy of it. Rows
//   arrive from more than one place: the file, and the dashboard accepting a
//   suggestion. A plan that treated the file as the whole truth undid every
//   other writer on its next run, and did it silently, because to the planner
//   an accepted keyword looked exactly like one the operator had deleted. So
//   by default the plan only adds. Removal is `prune`, asked for by name, and
//   `pullConfig` brings the file back up to the database first.
//
//   Nothing is ever deleted. Removing a keyword from the config retires its
//   crawl pairs by dropping ref_count to zero; the rows and every observation
//   attached to them survive, because a day not collected cannot be recovered
//   and a day deleted is the same thing.
//
//   crawl_pair is the reference-counted union of what everyone tracks, so two
//   people asking for the same keyword in the same storefront share one row and
//   therefore one fetch a day. The references are `tracked_keyword_storefront`
//   rows: one per user, keyword and storefront. A pair is retired only when no
//   such row points at it any more.
//
//   Only differences are emitted. A re-run that changes nothing must cost no
//   row-writes: D1 charges for a conflicting upsert even when it updates
//   nothing, and the free tier's daily budget is the binding constraint.

/** Lowercase, NFC, trimmed, the form `keyword.normalized` stores. */
export function normalize(text) {
	return text.toLowerCase().normalize("NFC").trim();
}

/**
 * The locale a storefront indexes for this app's language, else the
 * storefront's own default.
 *
 * Apple cross-localizes: Canada indexes fr-CA, Belgium fr-FR. Where a
 * storefront indexes nothing in the app's language, Spain for a French app
 * say, the default locale is the honest description of the query being made,
 * rather than inventing a cross-localization Apple does not publish.
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

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function trackKey(userId, appId, normalized, language) {
	return `${userId}|${appId}|${normalized}:${language}`;
}

function pairKey(normalized, language, storefront, locale) {
	return `${normalized}:${language}|${storefront}|${locale}`;
}

/** The id of one user's track of one keyword, as a subquery. */
function trackIdExpr(userId, appId, normalized, language) {
	return `(SELECT tk.id FROM tracked_keyword tk JOIN keyword k ON k.id = tk.keyword_id WHERE tk.user_id = ${sqlString(userId)} AND tk.app_id = ${appId} AND k.normalized = ${sqlString(normalized)} AND k.language = ${sqlString(language)})`;
}

/**
 * Pairs nobody asks for any more. They are retired, never deleted: the row and
 * every observation hanging off it outlive the decision to stop tracking, so
 * putting the keyword back restores its history rather than starting over.
 */
function retireUnwanted(activePair, wantedPairs, stillReferenced, summary) {
	const out = [];
	for (const [key, pair] of activePair) {
		if (
			!wantedPairs.has(key) &&
			!stillReferenced.has(key) &&
			pair.ref_count > 0
		) {
			out.push(`UPDATE crawl_pair SET ref_count = 0 WHERE id = ${pair.id};`);
			summary.pairsRetired += 1;
		}
	}
	return out;
}

/**
 * What the database holds and the file does not list. Without `prune` it is
 * reported and kept, since the database may hold it for a reason the file never
 * heard of. With it, the rows go for the users the file names; the crawl pairs
 * and their observations do not. A user absent from the file is never touched:
 * an empty entry is a statement about that person, a missing one is not.
 *
 * @returns the pairs still referenced by a row that stays, which may not be
 *   retired out from under it
 */
function settleUnlisted(state, wanted, out) {
	const { listedUsers, prune, statements, summary, unlisted } = out;
	const pruning = (userId) => prune && listedUsers.has(userId);
	const stillReferenced = new Set();

	for (const s of state.trackedStorefronts) {
		const track = trackKey(s.user_id, s.app_id, s.normalized, s.language);
		if (wanted.storefronts.has(`${track}|${s.storefront_code}`)) {
			continue;
		}
		if (pruning(s.user_id)) {
			// A track the file dropped entirely goes below, and its storefronts go
			// with it; only a storefront dropped from a track that stays is deleted
			// on its own.
			if (wanted.tracks.has(track)) {
				statements.push(
					`DELETE FROM tracked_keyword_storefront WHERE tracked_keyword_id = ${trackIdExpr(s.user_id, s.app_id, s.normalized, s.language)} AND storefront_code = ${sqlString(s.storefront_code)};`
				);
				summary.storefrontsRemoved += 1;
			}
			continue;
		}
		stillReferenced.add(
			pairKey(s.normalized, s.language, s.storefront_code, s.locale_code)
		);
		if (!prune) {
			unlisted.push(s);
		}
	}

	for (const t of state.trackedKeywords) {
		if (
			wanted.tracks.has(trackKey(t.user_id, t.app_id, t.normalized, t.language))
		) {
			continue;
		}
		if (pruning(t.user_id)) {
			statements.push(
				`DELETE FROM tracked_keyword WHERE user_id = ${sqlString(t.user_id)} AND app_id = ${t.app_id} AND keyword_id = ${t.keyword_id};`
			);
			summary.tracksRemoved += 1;
		}
	}
	summary.unlisted = unlisted.length;
	return stillReferenced;
}

/**
 * @param config  { [userId]: { apps: [{ appId, name, language, storefronts,
 * keywords }] } }, a list, because one person routinely ships more than one
 * app and `tracked_app` has always been keyed (user_id, app_id).
 * @param state   rows already in the database
 * @param options `prune`: also remove what the file does not list, for the
 *   users the file names. Off by default, because the file is not the only
 *   writer.
 * @returns The SQL to run, counts for the human-readable plan, the tracked
 *   storefronts the database holds and the file does not (`unlisted`, kept
 *   unless pruning), and any storefront the reference data does not know about.
 */
export function planChanges(config, state, { prune = false } = {}) {
	const statements = [];
	const warnings = [];
	const unlisted = [];
	const summary = {
		apps: 0,
		keywordsAdded: 0,
		pairsActivated: 0,
		pairsRetired: 0,
		storefrontsAdded: 0,
		storefrontsRemoved: 0,
		tracksAdded: 0,
		tracksRemoved: 0,
		unlisted: 0,
	};
	const listedUsers = new Set(
		Object.keys(config).filter((userId) => !userId.startsWith("_"))
	);

	const knownKeyword = new Map(
		state.keywords.map((k) => [`${k.normalized}:${k.language}`, k.id])
	);
	const heldTracks = new Set(
		state.trackedKeywords.map((t) =>
			trackKey(t.user_id, t.app_id, t.normalized, t.language)
		)
	);
	const heldStorefronts = new Set(
		state.trackedStorefronts.map(
			(s) =>
				`${trackKey(s.user_id, s.app_id, s.normalized, s.language)}|${s.storefront_code}`
		)
	);
	// Every track and tracked storefront the config asks for, and every pair.
	const wanted = { storefronts: new Set(), tracks: new Set() };
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
				const track = trackKey(userId, appId, norm, language);
				wanted.tracks.add(track);

				const idExpr = `(SELECT id FROM keyword WHERE normalized = ${sqlString(norm)} AND language = ${sqlString(language)})`;
				if (!heldTracks.has(track)) {
					statements.push(
						`INSERT OR IGNORE INTO tracked_keyword (user_id, app_id, keyword_id, created_at) SELECT ${sqlString(userId)}, ${appId}, id, strftime('%s','now')*1000 FROM keyword WHERE normalized = ${sqlString(norm)} AND language = ${sqlString(language)};`
					);
					heldTracks.add(track);
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
							`${storefront}: not in the reference data; add the storefront and its locales first`
						);
						continue;
					}
					wanted.storefronts.add(`${track}|${storefront}`);
					if (!heldStorefronts.has(`${track}|${storefront}`)) {
						statements.push(
							`INSERT OR IGNORE INTO tracked_keyword_storefront (tracked_keyword_id, storefront_code, locale_code, created_at) SELECT ${trackIdExpr(userId, appId, norm, language)}, ${sqlString(storefront)}, ${sqlString(locale)}, strftime('%s','now')*1000;`
						);
						heldStorefronts.add(`${track}|${storefront}`);
						summary.storefrontsAdded += 1;
					}
					wantedPairs.set(pairKey(norm, language, storefront, locale), {
						idExpr,
						locale,
						storefront,
					});
				}
			}
		}
	}

	const stillReferenced = settleUnlisted(state, wanted, {
		listedUsers,
		prune,
		statements,
		summary,
		unlisted,
	});

	const activePair = new Map(
		state.crawlPairs.map((p) => [
			pairKey(p.normalized, p.language, p.storefront_code, p.locale_code),
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

	if (prune) {
		statements.push(
			...retireUnwanted(activePair, wantedPairs, stillReferenced, summary)
		);
	}

	return { statements, summary, unlisted, warnings };
}

/** A user's app entries without reshaping the file: [] when there are none. */
function entriesOf(config, userId) {
	const entry = config[userId];
	if (!entry) {
		return [];
	}
	return Array.isArray(entry.apps) ? entry.apps : [entry];
}

/** The same list, created or lifted out of the single-app shorthand to append to. */
function mutableEntriesOf(config, userId) {
	const entry = config[userId];
	if (!entry) {
		config[userId] = { apps: [] };
	} else if (!Array.isArray(entry.apps)) {
		config[userId] = { apps: [entry] };
	}
	return config[userId].apps;
}

function sameSet(a, b) {
	return a.length === b.length && a.every((s) => b.includes(s));
}

/**
 * The file brought up to the database: every tracked storefront the database
 * holds and the file does not list, added in place.
 *
 * Additive only. A keyword in the file but not yet in the database is a pending
 * `--apply`, not a stale line, so it stays; removing things is `prune`'s job.
 *
 * The storefronts come from `tracked_keyword_storefront`, so they are exactly
 * the ones this user chose, never another user's that happen to share a pair.
 * A keyword the file already lists gets a line only for the storefronts beyond
 * the entries listing it, which is how a storefront accepted on the dashboard
 * reaches the file.
 *
 * A keyword joins an entry only when the entry's storefronts are exactly the
 * ones it needs; otherwise it gets an entry of its own. Joining a wider entry
 * looks harmless in the file, and the next `--apply` tracks it in every
 * storefront that entry lists: fetch volume nobody chose.
 *
 * @param config the current file, or {} when there is none
 * @param state  rows already in the database (the shape `planChanges` reads)
 * @returns the new file, how many lines it gained, and how many tracked
 *   keywords have no storefront at all and so could not be written
 */
export function pullConfig(config, state) {
	const next = structuredClone(config ?? {});
	const names = new Map(state.apps.map((a) => [a.id, a.current_name]));
	const chosen = new Map();
	for (const s of state.trackedStorefronts) {
		const key = trackKey(s.user_id, s.app_id, s.normalized, s.language);
		const set = chosen.get(key) ?? new Set();
		set.add(s.storefront_code);
		chosen.set(key, set);
	}

	const ordered = state.trackedKeywords.toSorted(
		(a, b) =>
			a.user_id.localeCompare(b.user_id) ||
			a.app_id - b.app_id ||
			a.language.localeCompare(b.language) ||
			a.normalized.localeCompare(b.normalized)
	);
	let added = 0;
	let withoutStorefront = 0;
	for (const t of ordered) {
		const storefronts = chosen.get(
			trackKey(t.user_id, t.app_id, t.normalized, t.language)
		);
		if (!storefronts) {
			withoutStorefront += 1;
			continue;
		}
		const listedIn = new Set(
			entriesOf(next, t.user_id)
				.filter(
					(e) =>
						e.appId === t.app_id &&
						e.language === t.language &&
						(e.keywords ?? []).some((k) => normalize(k) === t.normalized)
				)
				.flatMap((e) => e.storefronts ?? [])
		);
		const missing = [...storefronts].filter((s) => !listedIn.has(s)).toSorted();
		if (missing.length === 0) {
			continue;
		}
		const entries = mutableEntriesOf(next, t.user_id);
		let entry = entries.find(
			(e) =>
				e.appId === t.app_id &&
				e.language === t.language &&
				sameSet(e.storefronts ?? [], missing)
		);
		if (!entry) {
			entry = {
				appId: t.app_id,
				name: names.get(t.app_id) ?? `App ${t.app_id}`,
				language: t.language,
				storefronts: missing,
				keywords: [],
			};
			entries.push(entry);
		}
		entry.keywords = [...(entry.keywords ?? []), t.text ?? t.normalized];
		added += 1;
	}
	return { added, config: next, withoutStorefront };
}
