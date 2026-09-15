// `pnpm track`: keep a local file and the tracked set in the database in step.
//
// Adding an app or a keyword must never be a code change (invariant 5), but
// the raw SQL for it is four statements with subqueries and easy to get wrong.
// This reads a gitignored config, works out the difference against what is
// already in the database, and prints it. Nothing is written without
// `--apply`.
//
// The database is the source of truth: crawl_pair is reference-counted across
// users, ownership lives on the rows, retiring preserves history, and the
// dashboard writes rows too when a suggestion is accepted. The file is a local
// copy you edit, so:
//
//   pnpm track                  what the file would add; also lists what the
//                               database holds that the file does not
//   pnpm track --apply          add it
//   pnpm track --pull           rewrite the file from the database (additive)
//   pnpm track --prune          also remove what the file does not list
//   pnpm track --prune --apply
//
// `--local` targets the local D1 instead of the remote one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planChanges, pullConfig } from "./plan.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
const COLLECTOR = path.join(ROOT, "apps", "collector");
const CONFIG = path.join(ROOT, "tracked.local.json");
const CONFIG_NAME = path.relative(ROOT, CONFIG);

const apply = process.argv.includes("--apply");
const pull = process.argv.includes("--pull");
const prune = process.argv.includes("--prune");
const local = process.argv.includes("--local");
const target = local ? "--local" : "--remote";

if (pull && (apply || prune)) {
	console.error(
		"--pull only rewrites the file. Run it on its own, then plan again."
	);
	process.exit(2);
}

function readConfig() {
	return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf-8")) : null;
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
		apps: query("SELECT id, current_name FROM app"),
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
		trackedStorefronts: query(
			`SELECT tk.user_id, tk.app_id, k.normalized, k.language, ts.storefront_code, ts.locale_code
       FROM tracked_keyword_storefront ts
       JOIN tracked_keyword tk ON tk.id = ts.tracked_keyword_id
       JOIN keyword k ON k.id = tk.keyword_id`
		),
		trackedKeywords: query(
			`SELECT tk.user_id, tk.app_id, tk.keyword_id, k.text, k.normalized, k.language
       FROM tracked_keyword tk JOIN keyword k ON k.id = tk.keyword_id`
		),
	};
}

if (pull) {
	const { added, config, withoutStorefront } = pullConfig(
		readConfig() ?? {},
		currentState()
	);
	if (withoutStorefront > 0) {
		console.warn(
			`warning: ${withoutStorefront} tracked keyword(s) have no storefront recorded, so there is no line to write for them; add them to the file by hand`
		);
	}
	if (added === 0) {
		console.log(`${CONFIG_NAME} already lists everything the database tracks.`);
		process.exit(0);
	}
	writeFileSync(CONFIG, `${JSON.stringify(config, null, "\t")}\n`);
	console.log(
		`Added ${added} keyword(s) to ${CONFIG_NAME}. Run \`pnpm track\` to confirm it reports in sync.`
	);
	process.exit(0);
}

const config = readConfig();
if (!config) {
	console.error(
		`No ${CONFIG_NAME}. Start from tracked.example.json, or run \`pnpm track --pull\` to build it from the database.`
	);
	process.exit(1);
}

const { statements, summary, unlisted, warnings } = planChanges(
	config,
	currentState(),
	{ prune }
);

for (const w of warnings) {
	console.warn(`warning: ${w}`);
}

if (unlisted.length > 0) {
	// Printed to this terminal only, never written anywhere tracked: the terms are
	// the operator's ASO strategy.
	console.log(
		`In the database but not in ${CONFIG_NAME} (kept): ${unlisted.length}`
	);
	for (const t of unlisted) {
		console.log(
			`  ${t.user_id}  app ${t.app_id}  ${t.storefront_code}  ${t.language}  ${t.normalized}`
		);
	}
	console.log(
		"Run `pnpm track --pull` to add them to the file, or `--prune` to remove them.\n"
	);
}

if (statements.length === 0) {
	console.log("Nothing to write.");
	process.exit(0);
}

console.log(
	[
		`apps:            ${summary.apps}`,
		`keywords added:  ${summary.keywordsAdded}`,
		`tracks added:    ${summary.tracksAdded}`,
		`tracks removed:  ${summary.tracksRemoved}`,
		`storefronts +/-: ${summary.storefrontsAdded} / ${summary.storefrontsRemoved} (${summary.storefrontsMoved} moved to a new locale)`,
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
