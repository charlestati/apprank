// `pnpm track` — reconcile the tracked set from one file.
//
// Adding an app or a keyword must never be a code change (invariant 5), but the
// raw SQL for it is four statements with subqueries and easy to get wrong. This
// reads a gitignored config, works out the difference against what is already
// in the database, and prints it. Nothing is written without `--apply`.
//
// The database stays the source of truth: crawl_pair is reference-counted
// across users, ownership lives on the rows, and retiring preserves history.
// The file is how you author that, not where it lives.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planChanges } from "./plan.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
const COLLECTOR = path.join(ROOT, "apps", "collector");
const CONFIG = path.join(ROOT, "tracked.local.json");

const apply = process.argv.includes("--apply");
const local = process.argv.includes("--local");
const target = local ? "--local" : "--remote";

function config() {
  if (!existsSync(CONFIG)) {
    console.error(
      `No ${path.relative(ROOT, CONFIG)}. Start from tracked.example.json.`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG, "utf-8"));
}

function wranglerConfig() {
  const local_ = path.join(COLLECTOR, "wrangler.local.jsonc");
  return existsSync(local_) ? "wrangler.local.jsonc" : "wrangler.jsonc";
}

function query(sql) {
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "apprank",
      target,
      "-c",
      wranglerConfig(),
      "--json",
      "--command",
      sql,
    ],
    { cwd: COLLECTOR, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

function currentState() {
  return {
    appLanguages: query("SELECT app_id, language FROM app_language"),
    apps: query("SELECT id FROM app"),
    crawlPairs: query(
      `SELECT cp.id, cp.ref_count, cp.storefront_code, cp.locale_code, k.normalized, k.language
       FROM crawl_pair cp JOIN keyword k ON k.id = cp.keyword_id`
    ),
    keywords: query("SELECT id, normalized, language FROM keyword"),
    storefrontLocales: query(
      `SELECT sl.storefront_code, sl.locale_code, sl.is_default, l.language
       FROM storefront_locale sl JOIN locale l ON l.code = sl.locale_code`
    ),
    trackedApps: query("SELECT user_id, app_id FROM tracked_app"),
    trackedKeywords: query(
      `SELECT tk.user_id, tk.app_id, tk.keyword_id, k.normalized, k.language
       FROM tracked_keyword tk JOIN keyword k ON k.id = tk.keyword_id`
    ),
  };
}

const { statements, summary, warnings } = planChanges(config(), currentState());

for (const w of warnings) {
  console.warn(`warning: ${w}`);
}

if (statements.length === 0) {
  console.log("Already in sync — nothing to write.");
  process.exit(0);
}

console.log(
  [
    `apps:            ${summary.apps}`,
    `keywords added:  ${summary.keywordsAdded}`,
    `tracks added:    ${summary.tracksAdded}`,
    `tracks removed:  ${summary.tracksRemoved}`,
    `pairs activated: ${summary.pairsActivated}`,
    `pairs retired:   ${summary.pairsRetired}   (history kept)`,
    `statements:      ${statements.length}`,
  ].join("\n")
);

const out = path.join(ROOT, "tracked.local.sql");
writeFileSync(out, `${statements.join("\n")}\n`);
console.log(`\nSQL written to ${path.relative(ROOT, out)}`);

if (!apply) {
  console.log("Dry run. Re-run with --apply to execute.");
  process.exit(0);
}

execFileSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    "apprank",
    target,
    "-c",
    wranglerConfig(),
    "--file",
    out,
  ],
  { cwd: COLLECTOR, stdio: "inherit" }
);
console.log("Applied. Run `pnpm track` again to confirm it reports in sync.");
