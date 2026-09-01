import assert from "node:assert/strict";
import { test } from "node:test";

import { localeFor, normalize, planChanges } from "./plan.mjs";

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
  assert.equal(normalize("  Mots Croisés  "), "mots croisés");
});

test("creates app, track and pair rows for a new user", () => {
  const { statements, summary } = planChanges(
    {
      friend: {
        appId: 42,
        name: "His App",
        language: "fr",
        storefronts: ["fr", "ca"],
        keywords: ["jeu de lettres"],
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
        normalized: "jeu de lettres",
        language: "fr",
      },
    ],
    keywords: [{ id: 5, normalized: "jeu de lettres", language: "fr" }],
  };
  const { summary } = planChanges(
    {
      friend: {
        appId: 2,
        name: "Another",
        language: "fr",
        storefronts: ["fr"],
        keywords: ["jeu de lettres"],
      },
    },
    state
  );
  assert.equal(summary.pairsActivated, 0);
  assert.equal(summary.keywordsAdded, 0);
  assert.equal(summary.tracksAdded, 1);
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
    trackedApps: [{ user_id: "charles", app_id: 1 }],
    trackedKeywords: [
      {
        user_id: "charles",
        app_id: 1,
        keyword_id: 3,
        normalized: "obsolete",
        language: "fr",
      },
    ],
  };
  const { statements, summary } = planChanges(
    {
      charles: {
        appId: 1,
        name: "App",
        language: "fr",
        storefronts: ["fr"],
        keywords: [],
      },
    },
    state
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
        normalized: "mots",
        language: "fr",
      },
    ],
    keywords: [{ id: 3, normalized: "mots", language: "fr" }],
    trackedApps: [{ user_id: "charles", app_id: 1 }],
    trackedKeywords: [
      {
        user_id: "charles",
        app_id: 1,
        keyword_id: 3,
        normalized: "mots",
        language: "fr",
      },
    ],
  };
  const { statements } = planChanges(
    {
      charles: {
        appId: 1,
        name: "App",
        language: "fr",
        storefronts: ["fr"],
        keywords: ["mots"],
      },
    },
    state
  );
  assert.deepEqual(statements, []);
});

test("warns instead of guessing when a storefront is unknown", () => {
  const { warnings } = planChanges(
    {
      charles: {
        appId: 1,
        name: "App",
        language: "fr",
        storefronts: ["zz"],
        keywords: ["mots"],
      },
    },
    EMPTY
  );
  assert.match(warnings[0], /zz: not in the reference data/u);
});
