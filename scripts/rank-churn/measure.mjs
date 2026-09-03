#!/usr/bin/env node

// Measure how far a search page moves between consecutive observations, so the
// depth past which a rank stops being reportable is evidence rather than a
// guess. Reads what the collector already stored; touches no Apple endpoint.
//
// Usage:
//   node scripts/rank-churn/measure.mjs [--days 30] [--storefront fr] [--json]
//
//   --days        how far back to read (default 30)
//   --storefront  restrict to one storefront code
//   --json        machine-readable output instead of the table
//
// D1 rather than R2 on purpose. R2 is the source of truth, but this asks a
// question about a hot window that D1 already holds, and reading the archive
// would cost a list plus a GET per pair per day for an answer that does not
// change. If the retention window is ever pruned below the range asked for, the
// script says how much it actually found rather than implying the rest was
// stable.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { DEPTH_BANDS, measure, noiseFloor } from "./churn.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const COLLECTOR = path.join(ROOT, "apps/collector");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const days = Number(flag("days", 30));
const storefront = flag("storefront", null);
const asJson = args.includes("--json");

function wranglerConfig() {
	return existsSync(path.join(COLLECTOR, "wrangler.local.jsonc"))
		? "wrangler.local.jsonc"
		: "wrangler.jsonc";
}

function query(sql) {
	const out = execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"apprank",
			"--remote",
			"-c",
			wranglerConfig(),
			"--json",
			"--command",
			sql,
		],
		{ cwd: COLLECTOR, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 }
	);
	return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

const since = new Date(Date.now() - days * 86_400_000)
	.toISOString()
	.slice(0, 10);

const dates = query(
	`SELECT DISTINCT observed_date FROM ranking
    WHERE observed_date >= '${since}' AND valid = 1
    ORDER BY observed_date`
).map((r) => r.observed_date);

if (dates.length < 2) {
	console.error(
		`Need two days of observations to measure movement; found ${dates.length} since ${since}.`
	);
	process.exit(1);
}

// One query per day. A day of 387 pairs carries a few hundred kilobytes of
// result_ids, and a month of it in one statement is large enough that the
// wrangler round-trip becomes the failure mode rather than the query.
const observations = [];
const where = storefront ? ` AND cp.storefront_code = '${storefront}'` : "";
for (const date of dates) {
	const rows = query(
		`SELECT r.pair_id AS pairId, r.observed_date AS date, r.result_ids AS ids
       FROM ranking r JOIN crawl_pair cp ON cp.id = r.pair_id
      WHERE r.observed_date = '${date}' AND r.valid = 1
        AND r.result_count > 0${where}`
	);
	for (const row of rows) {
		const ids = JSON.parse(row.ids ?? "[]");
		if (ids.length > 0) {
			observations.push({ date: row.date, ids, pairId: row.pairId });
		}
	}
	process.stderr.write(`  read ${date}: ${rows.length} pages\r`);
}
process.stderr.write("\n");

const result = measure(observations);
const floor = noiseFloor(result.rows);

if (asJson) {
	console.log(JSON.stringify({ ...result, dates, noiseFloor: floor }, null, 2));
	process.exit(0);
}

const pct = (n) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
console.log(
	`\n${dates.length} days (${dates[0]} to ${dates.at(-1)}), ${result.pairs} pairs, ${result.comparisons} day-to-day comparisons\n`
);
console.log("  depth      samples   median move   p90 move   left the page");
console.log("  --------------------------------------------------------------");
for (const r of result.rows) {
	console.log(
		`  ${r.band.padEnd(9)}  ${String(r.samples).padStart(7)}   ${String(r.medianMove ?? "n/a").padStart(11)}   ${String(r.p90Move ?? "n/a").padStart(8)}   ${pct(r.dropRate).padStart(13)}`
	);
}

const [, last] = DEPTH_BANDS.at(-1);
console.log(
	floor === null
		? `\nNo band dropped 10% or more of its apps. The page held together to ${last}, so the cutoff is below this data rather than inside it.\n`
		: `\nOne app in ten leaves the page from rank ${floor} down. Past that, absence is a property of the sample and not of the app, so a rank there should carry its confidence rather than be plotted as a fact.\n`
);
