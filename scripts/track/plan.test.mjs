import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { localeFor, normalize, planChanges, pullConfig } from "./plan.mjs";

const LOCALES = [
	{
		storefront_code: "fr",
		locale_code: "fr-FR",
		is_default: 1,
		language: "fr",
	},
	{
		storefront_code: "ca",
		locale_code: "en-CA",
		is_default: 1,
		language: "en",
	},
	{
		storefront_code: "ca",
		locale_code: "fr-CA",
		is_default: 0,
		language: "fr",
	},
	{
		storefront_code: "es",
		locale_code: "es-ES",
		is_default: 1,
		language: "es",
	},
];

const EMPTY = {
	appLanguages: [],
	apps: [],
	crawlPairs: [],
	keywords: [],
	storefrontLocales: LOCALES,
	trackedApps: [],
	trackedKeywords: [],
	trackedStorefronts: [],
};

test("prefers the locale matching the app's language over the default", () => {
	// Canada defaults to en-CA but also indexes fr-CA; a French app belongs on
	// the latter, which is the whole reason a pair is (keyword, storefront,
	// locale) rather than (keyword, storefront).
	assert.equal(localeFor("ca", "fr", LOCALES), "fr-CA");
});

test("falls back to the storefront default when the language is not indexed", () => {
	// Spain indexes no French. Querying it under es-ES describes what is actually
	// being asked; inventing a fr row would claim a cross-localization Apple does
	// not publish.
	assert.equal(localeFor("es", "fr", LOCALES), "es-ES");
});

test("normalizes the way the keyword table stores", () => {
	assert.equal(normalize("  Terme Accentué  "), "terme accentué");
});

test("creates app, track and pair rows for a new user", () => {
	const { statements, summary } = planChanges(
		{
			operator: {
				appId: 42,
				name: "App",
				language: "fr",
				storefronts: ["fr", "ca"],
				keywords: ["terme un"],
			},
		},
		EMPTY
	);
	assert.equal(summary.keywordsAdded, 1);
	assert.equal(summary.pairsActivated, 2); // one per storefront
	assert.ok(
		statements.some((s) => s.includes("INSERT OR IGNORE INTO tracked_app"))
	);
	assert.ok(statements.some((s) => s.includes("'fr-CA'")));
});

test("a second user tracking the same keyword adds no new pair", () => {
	// crawl_pair is the reference-counted union of demand: two people asking for
	// the same keyword must cost one fetch, not two.
	const state = {
		...EMPTY,
		apps: [{ id: 1 }],
		crawlPairs: [
			{
				id: 7,
				ref_count: 1,
				storefront_code: "fr",
				locale_code: "fr-FR",
				normalized: "terme un",
				language: "fr",
			},
		],
		keywords: [{ id: 5, normalized: "terme un", language: "fr" }],
	};
	const { summary } = planChanges(
		{
			other: {
				appId: 2,
				name: "Another",
				language: "fr",
				storefronts: ["fr"],
				keywords: ["terme un"],
			},
		},
		state
	);
	assert.equal(summary.pairsActivated, 0);
	assert.equal(summary.keywordsAdded, 0);
	assert.equal(summary.tracksAdded, 1);
});

/** One operator tracking one keyword in one storefront, already applied. */
function appliedState(normalized = "obsolete") {
	return {
		...EMPTY,
		apps: [{ id: 1, current_name: "App" }],
		appLanguages: [{ app_id: 1, language: "fr" }],
		crawlPairs: [
			{
				id: 9,
				ref_count: 1,
				storefront_code: "fr",
				locale_code: "fr-FR",
				normalized,
				language: "fr",
			},
		],
		keywords: [{ id: 3, normalized, language: "fr" }],
		trackedApps: [{ user_id: "operator", app_id: 1 }],
		trackedKeywords: [
			{
				user_id: "operator",
				app_id: 1,
				keyword_id: 3,
				text: normalized,
				normalized,
				language: "fr",
			},
		],
		trackedStorefronts: [stored("fr", "fr-FR", normalized)],
	};
}

/** One tracked_keyword_storefront row, joined the way track.mjs reads it. */
function stored(
	storefront,
	locale,
	normalized,
	userId = "operator",
	appId = 1
) {
	return {
		user_id: userId,
		app_id: appId,
		normalized,
		language: "fr",
		storefront_code: storefront,
		locale_code: locale,
	};
}

/** An active pair for the fixture keyword in another storefront. */
function pair(id, storefront, locale, normalized) {
	return {
		id,
		ref_count: 1,
		storefront_code: storefront,
		locale_code: locale,
		normalized,
		language: "fr",
	};
}

const EMPTY_ENTRY = {
	operator: {
		appId: 1,
		name: "App",
		language: "fr",
		storefronts: ["fr"],
		keywords: [],
	},
};

test("keeps a track the file does not list, and reports it", () => {
	// The dashboard writes tracking rows too. To the planner an accepted
	// suggestion looks exactly like a line the operator deleted, so treating the
	// file as complete undid every acceptance on the next run.
	const { statements, summary, unlisted } = planChanges(
		EMPTY_ENTRY,
		appliedState()
	);
	assert.deepEqual(statements, []);
	assert.equal(summary.unlisted, 1);
	assert.equal(unlisted[0].normalized, "obsolete");
	assert.equal(unlisted[0].storefront_code, "fr");
});

test("apply records where each keyword is tracked, not only that it is", () => {
	// tracked_keyword has no storefront. Without this row every reader of the
	// tracked set had to guess the storefronts from the shared pairs.
	const { statements, summary } = planChanges(
		{
			operator: {
				appId: 42,
				name: "App",
				language: "fr",
				storefronts: ["fr", "ca"],
				keywords: ["terme un"],
			},
		},
		EMPTY
	);
	assert.equal(summary.storefrontsAdded, 2);
	const rows = statements.filter((s) =>
		s.includes("INSERT OR IGNORE INTO tracked_keyword_storefront")
	);
	assert.equal(rows.length, 2);
	assert.ok(rows.some((s) => s.includes("'fr-CA'")));
	// After the track it points at, or the subquery finds nothing.
	const trackAt = statements.findIndex((s) =>
		s.includes("INTO tracked_keyword (")
	);
	assert.ok(statements.indexOf(rows[0]) > trackAt);
});

test("prune removes only the users the file names", () => {
	// A user missing from the file said nothing; an empty entry said "none".
	const state = appliedState();
	state.trackedKeywords.push({
		user_id: "someone-else",
		app_id: 2,
		keyword_id: 3,
		text: "obsolete",
		normalized: "obsolete",
		language: "fr",
	});
	state.trackedStorefronts.push(
		stored("fr", "fr-FR", "obsolete", "someone-else", 2)
	);
	const { statements, summary } = planChanges(EMPTY_ENTRY, state, {
		prune: true,
	});
	assert.equal(summary.tracksRemoved, 1);
	assert.ok(statements.some((s) => s.includes("'operator'")));
	assert.ok(!statements.some((s) => s.includes("'someone-else'")));
	// Still referenced by someone outside the file, so its pair keeps collecting.
	assert.equal(summary.pairsRetired, 0);
});

test("prune drops a storefront the file no longer lists and retires its pair", () => {
	const state = appliedState("kept");
	state.crawlPairs.push(pair(10, "ca", "fr-CA", "kept"));
	state.trackedStorefronts.push(stored("ca", "fr-CA", "kept"));
	const file = {
		operator: { ...EMPTY_ENTRY.operator, keywords: ["kept"] },
	};
	const { statements, summary } = planChanges(file, state, { prune: true });
	assert.equal(summary.storefrontsRemoved, 1);
	assert.equal(summary.tracksRemoved, 0);
	assert.ok(
		statements.some(
			(s) =>
				s.startsWith("DELETE FROM tracked_keyword_storefront") &&
				s.includes("'ca'")
		)
	);
	assert.equal(summary.pairsRetired, 1);
	assert.ok(
		statements.includes("UPDATE crawl_pair SET ref_count = 0 WHERE id = 10;")
	);
});

test("prune keeps a pair another user still points at, storefront by storefront", () => {
	// Keyword-level protection kept every storefront of a shared keyword alive;
	// the reference is the storefront row, so only the one still held survives.
	const state = appliedState("shared");
	state.crawlPairs.push(pair(10, "ca", "fr-CA", "shared"));
	state.trackedStorefronts.push(
		stored("ca", "fr-CA", "shared"),
		stored("fr", "fr-FR", "shared", "someone-else", 2)
	);
	const { summary, statements } = planChanges(EMPTY_ENTRY, state, {
		prune: true,
	});
	assert.equal(summary.pairsRetired, 1);
	assert.ok(
		statements.includes("UPDATE crawl_pair SET ref_count = 0 WHERE id = 10;")
	);
});

test("pull adds a keyword the database tracks to the entry that covers it", () => {
	const { added, config } = pullConfig(EMPTY_ENTRY, appliedState("new term"));
	assert.equal(added, 1);
	// The single-app shorthand is lifted into the canonical list once it grows.
	assert.deepEqual(config.operator.apps[0].keywords, ["new term"]);
});

test("pull never widens an entry into a storefront it did not cover", () => {
	// Adding "ca" to the existing entry would create a pair for every keyword in
	// it on the next apply: fetch volume nobody chose.
	const state = appliedState("new term");
	state.crawlPairs[0] = pair(9, "ca", "fr-CA", "new term");
	state.trackedStorefronts = [stored("ca", "fr-CA", "new term")];
	const { config } = pullConfig(EMPTY_ENTRY, state);
	assert.deepEqual(config.operator.apps[0].storefronts, ["fr"]);
	assert.deepEqual(config.operator.apps[0].keywords, []);
	assert.deepEqual(config.operator.apps[1], {
		appId: 1,
		name: "App",
		language: "fr",
		storefronts: ["ca"],
		keywords: ["new term"],
	});
});

test("pull never joins an entry wider than the keyword's own storefronts", () => {
	// The entry covers fr and ca, the keyword is collected in fr only. Joining
	// would create its ca pair on the next apply.
	const file = {
		operator: { ...EMPTY_ENTRY.operator, storefronts: ["fr", "ca"] },
	};
	const { config } = pullConfig(file, appliedState("new term"));
	assert.deepEqual(config.operator.apps[0].keywords, []);
	assert.deepEqual(config.operator.apps[1].storefronts, ["fr"]);
	assert.deepEqual(config.operator.apps[1].keywords, ["new term"]);
	assert.deepEqual(
		planChanges(config, appliedState("new term")).statements,
		[]
	);
});

test("pull takes no storefront from another user's pair", () => {
	// crawl_pair is shared. Someone else collecting the term in us must not put
	// us in this user's file, where their prune would protect it and their apply
	// could bring it back.
	const state = appliedState("new term");
	state.crawlPairs.push(pair(10, "us", "en-US", "new term"));
	state.trackedStorefronts.push(
		stored("us", "en-US", "new term", "someone-else", 2)
	);
	const { config } = pullConfig(EMPTY_ENTRY, state);
	assert.deepEqual(config.operator.apps[0].storefronts, ["fr"]);
	assert.deepEqual(config.operator.apps[0].keywords, ["new term"]);
});

test("pull counts a tracked keyword with no storefront recorded", () => {
	const state = appliedState("nowhere");
	state.trackedStorefronts = [];
	const { added, withoutStorefront } = pullConfig(EMPTY_ENTRY, state);
	assert.equal(added, 0);
	assert.equal(withoutStorefront, 1);
});

test("pull then plan writes nothing, and keeps the file's notes", () => {
	const file = { _readme: ["note"], ...EMPTY_ENTRY };
	const state = appliedState("new term");
	const { config } = pullConfig(file, state);
	assert.deepEqual(config._readme, ["note"]);
	assert.deepEqual(planChanges(config, state).statements, []);
	assert.equal(pullConfig(config, state).added, 0);
});

test("pull builds an entry for a user the file has never seen", () => {
	const state = appliedState("new term");
	const { config } = pullConfig({}, state);
	assert.deepEqual(config.operator.apps[0].keywords, ["new term"]);
	assert.equal(config.operator.apps[0].name, "App");
});

test("pull writes back a storefront accepted for a keyword the file already lists", () => {
	// The file tracks the term in fr; the dashboard accepted it for ca. Skipping
	// every listed keyword left ca out of the file, and pull-then-prune retired it.
	const file = {
		operator: { ...EMPTY_ENTRY.operator, keywords: ["new term"] },
	};
	const state = appliedState("new term");
	state.crawlPairs.push(pair(10, "ca", "fr-CA", "new term"));
	state.trackedStorefronts.push(stored("ca", "fr-CA", "new term"));
	const { added, config } = pullConfig(file, state);
	assert.equal(added, 1);
	assert.deepEqual(config.operator.apps[1].storefronts, ["ca"]);
	assert.deepEqual(config.operator.apps[1].keywords, ["new term"]);
	const pruned = planChanges(config, state, { prune: true });
	assert.equal(pruned.summary.pairsRetired, 0);
	assert.equal(pruned.summary.storefrontsRemoved, 0);
	assert.deepEqual(pruned.statements, []);
	assert.equal(pullConfig(config, state).added, 0);
});

test("retires a dropped keyword instead of deleting its history", () => {
	const state = {
		...EMPTY,
		apps: [{ id: 1 }],
		appLanguages: [{ app_id: 1, language: "fr" }],
		crawlPairs: [
			{
				id: 9,
				ref_count: 1,
				storefront_code: "fr",
				locale_code: "fr-FR",
				normalized: "obsolete",
				language: "fr",
			},
		],
		keywords: [{ id: 3, normalized: "obsolete", language: "fr" }],
		trackedApps: [{ user_id: "operator", app_id: 1 }],
		trackedKeywords: [
			{
				user_id: "operator",
				app_id: 1,
				keyword_id: 3,
				normalized: "obsolete",
				language: "fr",
			},
		],
	};
	const { statements, summary } = planChanges(
		{
			operator: {
				appId: 1,
				name: "App",
				language: "fr",
				storefronts: ["fr"],
				keywords: [],
			},
		},
		state,
		{ prune: true }
	);
	assert.equal(summary.pairsRetired, 1);
	assert.ok(statements.some((s) => s.includes("SET ref_count = 0")));
	assert.ok(!statements.some((s) => s.includes("DELETE FROM crawl_pair")));
	assert.ok(!statements.some((s) => s.includes("DELETE FROM ranking")));
});

test("an unchanged config writes nothing at all", () => {
	// D1 charges for a conflicting upsert even when it updates nothing, so a
	// no-op re-run must emit no statements rather than harmless ones.
	const state = {
		...EMPTY,
		apps: [{ id: 1 }],
		appLanguages: [{ app_id: 1, language: "fr" }],
		crawlPairs: [
			{
				id: 9,
				ref_count: 1,
				storefront_code: "fr",
				locale_code: "fr-FR",
				normalized: "terme deux",
				language: "fr",
			},
		],
		keywords: [{ id: 3, normalized: "terme deux", language: "fr" }],
		trackedApps: [{ user_id: "operator", app_id: 1 }],
		trackedKeywords: [
			{
				user_id: "operator",
				app_id: 1,
				keyword_id: 3,
				normalized: "terme deux",
				language: "fr",
			},
		],
		trackedStorefronts: [stored("fr", "fr-FR", "terme deux")],
	};
	const { statements } = planChanges(
		{
			operator: {
				appId: 1,
				name: "App",
				language: "fr",
				storefronts: ["fr"],
				keywords: ["terme deux"],
			},
		},
		state
	);
	assert.deepEqual(statements, []);
});

test("warns instead of guessing when a storefront is unknown", () => {
	const { warnings } = planChanges(
		{
			operator: {
				appId: 1,
				name: "App",
				language: "fr",
				storefronts: ["zz"],
				keywords: ["terme deux"],
			},
		},
		EMPTY
	);
	assert.match(warnings[0], /zz: not in the reference data/u);
});

test("handles several apps under one user", () => {
	// tracked_app has always been keyed (user_id, app_id); the config shape was
	// the only thing assuming one app each.
	const { summary } = planChanges(
		{
			operator: {
				apps: [
					{
						appId: 1,
						name: "A",
						language: "fr",
						storefronts: ["fr"],
						keywords: ["x"],
					},
					{
						appId: 2,
						name: "B",
						language: "fr",
						storefronts: ["fr"],
						keywords: ["y"],
					},
				],
			},
		},
		EMPTY
	);
	assert.equal(summary.apps, 2);
	assert.equal(summary.tracksAdded, 2);
});

test("keeps accepting the single-app shorthand", () => {
	const { summary } = planChanges(
		{
			operator: {
				appId: 1,
				name: "A",
				language: "fr",
				storefronts: ["fr"],
				keywords: ["x"],
			},
		},
		EMPTY
	);
	assert.equal(summary.apps, 1);
});

test("two apps sharing a keyword still share one crawl pair", () => {
	const { summary } = planChanges(
		{
			operator: {
				apps: [
					{
						appId: 1,
						name: "A",
						language: "fr",
						storefronts: ["fr"],
						keywords: ["terme deux"],
					},
					{
						appId: 2,
						name: "B",
						language: "fr",
						storefronts: ["fr"],
						keywords: ["terme deux"],
					},
				],
			},
		},
		EMPTY
	);
	assert.equal(summary.pairsActivated, 1);
	assert.equal(summary.tracksAdded, 2);
});

test("plans the shipped example file as-is", () => {
	// The claim that tracked.example.json can be copied and applied is only
	// worth making if something checks the real file: the annotated example
	// once carried a shape that would have thrown on the first run. Every
	// storefront it names must resolve to a locale, or a new operator's first
	// command is a warning.
	const example = JSON.parse(
		readFileSync(
			path.join(import.meta.dirname, "../../tracked.example.json"),
			"utf-8"
		)
	);
	const locales = [
		{
			storefront_code: "us",
			locale_code: "en-US",
			is_default: 1,
			language: "en",
		},
		{
			storefront_code: "gb",
			locale_code: "en-GB",
			is_default: 1,
			language: "en",
		},
		{
			storefront_code: "ca",
			locale_code: "en-CA",
			is_default: 1,
			language: "en",
		},
		{
			storefront_code: "es",
			locale_code: "es-ES",
			is_default: 1,
			language: "es",
		},
	];
	const { summary, warnings } = planChanges(example, {
		...EMPTY,
		storefrontLocales: locales,
	});
	assert.deepEqual(warnings, []);
	// Three entries, two distinct app ids: the first app is listed twice to
	// carry a second language, which is the documented way to do it.
	assert.equal(summary.apps, 3);
	assert.equal(
		new Set(example.admin.apps.map((a) => a.appId).filter(Boolean)).size,
		2
	);
});

test("ignores underscore keys so the annotated example can be copied", () => {
	const { summary } = planChanges(
		{
			_readme: ["a note to the reader, not an operator"],
			operator: {
				apps: [
					{
						appId: 1,
						name: "A",
						language: "fr",
						storefronts: ["fr"],
						keywords: ["x"],
					},
				],
			},
		},
		EMPTY
	);
	assert.equal(summary.apps, 1);
});

test("tracks two languages for one app as two entries", () => {
	// `language` stamps the keyword and picks the locale, so one entry cannot
	// mix languages. Listing the app twice is the supported way to track, say,
	// Spanish terms in the Spanish store alongside French ones.
	const locales = [
		{
			storefront_code: "fr",
			locale_code: "fr-FR",
			is_default: 1,
			language: "fr",
		},
		{
			storefront_code: "es",
			locale_code: "es-ES",
			is_default: 1,
			language: "es",
		},
	];
	const { statements, summary } = planChanges(
		{
			operator: {
				apps: [
					{
						appId: 1,
						name: "A",
						language: "fr",
						storefronts: ["fr", "es"],
						keywords: ["terme fr"],
					},
					{
						appId: 1,
						name: "A",
						language: "es",
						storefronts: ["es"],
						keywords: ["termino es"],
					},
				],
			},
		},
		{ ...EMPTY, storefrontLocales: locales }
	);
	assert.equal(summary.pairsActivated, 3);
	const langs = statements.filter((s) => s.includes("app_language"));
	assert.equal(langs.length, 2);
});
