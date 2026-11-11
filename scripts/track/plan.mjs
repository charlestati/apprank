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

/**
 * The file's mistakes, found before anything is planned from it.
 *
 * Errors stop the run, because each one otherwise becomes rows: a string
 * `appId` never equals the integer the database holds, so every run re-emitted
 * the same three inserts and charged for them; an empty keyword became a pair
 * that searches the empty term every day. Warnings are for what is legal and
 * probably not meant.
 *
 * Inner whitespace is only reported. The collector and the dashboard store
 * `normalized` as lowercase, NFC, trimmed, and nothing else; collapsing spaces
 * here alone would mint a second keyword row beside the one already tracked.
 *
 * @returns the entries with a numeric-string `appId` coerced, plus `errors`
 *   and `warnings` as printable lines
 */
/** One app entry: its `appId` as a number where it can be one, and its faults. */
function validateApp(app, where) {
	const errors = [];
	const warnings = [];
	const appId =
		typeof app?.appId === "string" && /^\d+$/u.test(app.appId)
			? Number(app.appId)
			: app?.appId;
	if (!Number.isSafeInteger(appId) || appId <= 0) {
		errors.push(`${where}: appId must be a positive integer`);
	}
	if (typeof app?.language !== "string" || app.language.trim() === "") {
		errors.push(`${where}: language is missing`);
	}
	const lists = {};
	for (const field of ["storefronts", "keywords"]) {
		const list = app?.[field];
		const valid =
			Array.isArray(list) && list.every((v) => typeof v === "string");
		lists[field] = valid ? list : [];
		if (!valid) {
			errors.push(`${where}: ${field} must be a list of strings`);
		}
	}
	if (lists.keywords.some((k) => k.trim() === "")) {
		errors.push(`${where}: a keyword is empty`);
	}
	const spaced = lists.keywords.filter((k) => /\s{2,}/u.test(k.trim())).length;
	if (spaced > 0) {
		warnings.push(
			`${where}: ${spaced} keyword(s) hold repeated spaces; they are stored as written and are a different keyword from the single-spaced form`
		);
	}
	return { app: { ...app, appId }, errors, warnings };
}

export function validateConfig(config) {
	const errors = [];
	const warnings = [];
	const clean = {};
	for (const [userId, entry] of Object.entries(config ?? {})) {
		if (userId.startsWith("_")) {
			clean[userId] = entry;
			continue;
		}
		const single = !Array.isArray(entry?.apps);
		const checked = (single ? [entry] : entry.apps).map((app, i) =>
			validateApp(app, `${userId}, app ${i + 1}`)
		);
		errors.push(...checked.flatMap((c) => c.errors));
		warnings.push(...checked.flatMap((c) => c.warnings));
		const apps = checked.map((c) => c.app);
		clean[userId] = single ? apps[0] : { ...entry, apps };
	}
	return { config: clean, errors, warnings };
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
function retireUnwanted(activePair, kept, summary) {
	const { stillReferenced, unresolved, wantedPairs } = kept;
	const out = [];
	for (const [key, pair] of activePair) {
		if (
			!wantedPairs.has(key) &&
			!stillReferenced.has(key) &&
			// A storefront the file lists but the reference data cannot resolve is
			// still wanted. Its locale is unknown here, so every pair of that
			// keyword in that storefront is left alone.
			!unresolved.some((prefix) => key.startsWith(prefix)) &&
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
 * Make sure one user's track has a storefront row, under today's locale.
 *
 * A row stored under a different locale is moved rather than left: the
 * reference data can change which locale a storefront indexes for a language,
 * which is an INSERT away (invariant 5). Left behind, the row keeps naming the
 * old pair, prune retires that pair from under it, and discovery stops finding
 * it live.
 */
function holdStorefront(want, held) {
	const { appId, language, locale, norm, storefront, track, userId } = want;
	const { heldStorefronts, statements, summary, wanted } = held;
	const key = `${track}|${storefront}`;
	wanted.storefronts.add(key);
	const heldLocale = heldStorefronts.get(key);
	if (heldLocale === undefined) {
		statements.push(
			`INSERT OR IGNORE INTO tracked_keyword_storefront (tracked_keyword_id, storefront_code, locale_code, created_at) SELECT ${trackIdExpr(userId, appId, norm, language)}, ${sqlString(storefront)}, ${sqlString(locale)}, strftime('%s','now')*1000;`
		);
		summary.storefrontsAdded += 1;
	} else if (heldLocale !== locale) {
		statements.push(
			`UPDATE tracked_keyword_storefront SET locale_code = ${sqlString(locale)} WHERE tracked_keyword_id = ${trackIdExpr(userId, appId, norm, language)} AND storefront_code = ${sqlString(storefront)};`
		);
		summary.storefrontsMoved += 1;
	}
	heldStorefronts.set(key, locale);
}

/**
 * Two keyword rows that send Apple the same search. A pair is keyed by the
 * keyword row, and a keyword row by its language, so the same text listed
 * under two languages in a storefront that indexes one of them resolves to one
 * locale and therefore one URL, fetched twice a day for one answer.
 */
function sameSearchWarnings(wantedPairs) {
	const languages = new Map();
	for (const key of wantedPairs.keys()) {
		const [keyword, storefront, locale] = key.split("|");
		const at = keyword.lastIndexOf(":");
		const search = `${storefront}|${locale}|${keyword.slice(0, at)}`;
		const seen = languages.get(search) ?? new Set();
		seen.add(keyword.slice(at + 1));
		languages.set(search, seen);
	}
	const counts = new Map();
	for (const [search, seen] of languages) {
		if (seen.size > 1) {
			const [storefront, locale] = search.split("|");
			const where = `${storefront} (${locale})`;
			counts.set(where, (counts.get(where) ?? 0) + 1);
		}
	}
	// Counted, never named: the terms are the operator's strategy, and this
	// output lands in terminals and logs.
	return [...counts].map(
		([where, n]) =>
			`${where}: ${n} keyword(s) are listed under more than one language and resolve to the same search there, so each is fetched once per language for one answer`
	);
}

/**
 * Listed storefronts the reference data holds as inactive.
 *
 * `active` gates everything except the rank crawl: lookups, reviews, charts
 * and both Apple Ads passes skip an inactive storefront without a word, and
 * none of the first three can be collected after the fact (invariant 1). The
 * seed ships several storefronts inactive, one of them retired on purpose
 * because it is not a real storefront, and the two cannot be told apart from
 * the row. So a plain run says so and writes nothing; switching one on is
 * asked for by name.
 */
function settleInactive(state, listed, out) {
	const { activate, summary, warnings } = out;
	const statements = [];
	const inactive = (state.storefronts ?? [])
		.filter((s) => s.active === 0 && listed.has(s.code))
		.map((s) => s.code)
		.toSorted();
	for (const code of inactive) {
		const update = `UPDATE storefront SET active = 1 WHERE code = ${sqlString(code)} AND active = 0;`;
		if (activate) {
			statements.push(update);
			summary.storefrontsActivated += 1;
		} else {
			warnings.push(
				`${code}: storefront is inactive. Ranks are crawled there, but ratings, metadata, reviews, charts and Apple Ads popularity are skipped, and that history cannot be backfilled. Re-run with --activate, or run: ${update}`
			);
		}
	}
	return statements;
}

/** The app, its owner and its language, each only where the row is missing. */
function holdApp(state, userId, { appId, language, name }) {
	const out = [];
	if (!state.apps.some((a) => a.id === appId)) {
		out.push(
			`INSERT OR IGNORE INTO app (id, current_name, first_seen_at, last_seen_at) VALUES (${appId}, ${sqlString(name)}, strftime('%s','now')*1000, strftime('%s','now')*1000);`
		);
	}
	if (
		!state.trackedApps.some((t) => t.user_id === userId && t.app_id === appId)
	) {
		out.push(
			`INSERT OR IGNORE INTO tracked_app (user_id, app_id, created_at) VALUES (${sqlString(userId)}, ${appId}, strftime('%s','now')*1000);`
		);
	}
	if (
		!state.appLanguages.some(
			(l) => l.app_id === appId && l.language === language
		)
	) {
		out.push(
			`INSERT OR IGNORE INTO app_language (app_id, language) VALUES (${appId}, ${sqlString(language)});`
		);
	}
	return out;
}

/**
 * @param config  { [userId]: { apps: [{ appId, name, language, storefronts,
 * keywords }] } }, a list, because one person routinely ships more than one
 * app and `tracked_app` has always been keyed (user_id, app_id).
 * @param state   rows already in the database
 * @param options `prune`: also remove what the file does not list, for the
 *   users the file names. Off by default, because the file is not the only
 *   writer. `activate`: also switch on a listed storefront the reference data
 *   holds as inactive.
 * @returns The SQL to run, counts for the human-readable plan, the tracked
 *   storefronts the database holds and the file does not (`unlisted`, kept
 *   unless pruning), any storefront the reference data does not know about or
 *   holds inactive (`warnings`), and what is wrong with the file (`errors`,
 *   which leave `statements` empty).
 */
export function planChanges(
	rawConfig,
	state,
	{ prune = false, activate = false } = {}
) {
	const statements = [];
	const { config, errors, warnings } = validateConfig(rawConfig);
	// Reference problems are per storefront, not per keyword: one line each.
	const unknownStorefronts = new Set();
	const listedStorefronts = new Set();
	// Pair-key prefixes (keyword and storefront) whose locale could not be
	// resolved, so prune leaves whatever pair is stored for them.
	const unresolved = [];
	const unlisted = [];
	const summary = {
		apps: 0,
		keywordsAdded: 0,
		pairsActivated: 0,
		pairsRetired: 0,
		storefrontsActivated: 0,
		storefrontsAdded: 0,
		storefrontsMoved: 0,
		storefrontsRemoved: 0,
		tracksAdded: 0,
		tracksRemoved: 0,
		unlisted: 0,
	};
	if (errors.length > 0) {
		// Planning from a file known to be wrong writes the mistake as rows.
		return { errors, statements, summary, unlisted, warnings };
	}
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
	// Keyed by storefront, valued by the locale the row was stored under.
	const heldStorefronts = new Map(
		state.trackedStorefronts.map((s) => [
			`${trackKey(s.user_id, s.app_id, s.normalized, s.language)}|${s.storefront_code}`,
			s.locale_code,
		])
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
			const { appId, language, storefronts, keywords } = app;
			summary.apps += 1;

			statements.push(...holdApp(state, userId, app));

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
						unknownStorefronts.add(storefront);
						// Unresolved is not unlisted. Treating it as dropped let prune
						// delete the tracking row and retire the pair of a storefront
						// the file still names, on nothing but missing reference data.
						wanted.storefronts.add(`${track}|${storefront}`);
						unresolved.push(`${norm}:${language}|${storefront}|`);
						continue;
					}
					listedStorefronts.add(storefront);
					holdStorefront(
						{ appId, language, locale, norm, storefront, track, userId },
						{ heldStorefronts, statements, summary, wanted }
					);
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
			...retireUnwanted(
				activePair,
				{ stillReferenced, unresolved, wantedPairs },
				summary
			)
		);
	}

	for (const storefront of unknownStorefronts) {
		warnings.push(
			`${storefront}: not in the reference data; add the storefront and its locales first`
		);
	}
	warnings.push(...sameSearchWarnings(wantedPairs));
	statements.push(
		...settleInactive(state, listedStorefronts, { activate, summary, warnings })
	);

	return { errors, statements, summary, unlisted, warnings };
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
