#!/usr/bin/env node

// Rebuild the D1 rank observations from the R2 archive: the proof that D1 is a
// materialised view and R2 is the source of truth.
//
// Writes `ranking` and its `rank_entry` index (top 10 plus tracked apps, the
// crawler's own rule), a bare `app` row for any app the index references that
// the database has not met, and the Apple Ads `popularity` and `seed_term`
// rows. Every statement is gap-filling: a row the collector already wrote is
// left alone. seed_term is the exception: it takes the month's latest week, as
// the collector's own upsert does.
//
// Usage:
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
//     node rebuild.mjs [--verify] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//                      [--out rebuild.sql]
//
//   --verify   write nothing; compare the archive with the live D1 ranking
//              table on (pair, date), print every date that differs, and exit
//              1 when any does (needs wrangler auth)
//   --since    first observed date to read, inclusive
//   --until    last observed date to read, inclusive
//   --out      name the .sql files are derived from: one per month
//              (rebuild-2026-09.sql) plus rebuild-ads.sql, each applied with
//              `wrangler d1 execute`
//
// One file per month, written as it is built. Everything in one string threw
// near 124,000 observations, and a month is also about what a day of the free
// tier's write budget can take beside live collection: apply them a day apart.
//
// R2 credentials: create an R2 API token (dashboard → R2 → Manage API Tokens).
// Zero egress: reads are free. wrangler auth is needed as well: which apps are
// tracked is reference data that lives only in D1, and the index rule depends
// on it.

import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

import { AwsClient } from "aws4fetch";

import {
	adsRows,
	buildAdsSql,
	buildSql,
	byMonth,
	findDrift,
	inRange,
	isIsoDate,
	parseGenreKey,
	parseTermsKey,
	partFile,
	rankingKeyDate,
} from "./sql.mjs";
import { applyHint, d1Args, wranglerConfig } from "./wrangler.mjs";

const BUCKET = "apprank-archive";
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
	console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
	process.exit(1);
}

const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const client = new AwsClient({
	accessKeyId,
	region: "auto",
	secretAccessKey,
	service: "s3",
});

async function listAll(prefix) {
	const keys = [];
	let token;
	do {
		const url = new URL(`${endpoint}/${BUCKET}`);
		url.searchParams.set("list-type", "2");
		url.searchParams.set("prefix", prefix);
		if (token) {
			url.searchParams.set("continuation-token", token);
		}
		const res = await client.fetch(url);
		if (!res.ok) {
			throw new Error(`list failed: ${res.status} ${await res.text()}`);
		}
		const xml = await res.text();
		for (const m of xml.matchAll(/<Key>(?<key>[^<]+)<\/Key>/gu)) {
			keys.push(m.groups.key);
		}
		token = xml.match(
			/<NextContinuationToken>(?<tok>[^<]+)<\/NextContinuationToken>/u
		)?.groups?.tok;
	} while (token);
	return keys;
}

async function getObject(key) {
	const res = await client.fetch(`${endpoint}/${BUCKET}/${key}`);
	if (!res.ok) {
		throw new Error(`get ${key} failed: ${res.status}`);
	}
	return res.text();
}

/**
 * Body plus when the object landed. `fetched_at` is not in any Apple body, and
 * R2's own timestamp is the closest true answer to "when did we ask".
 */
async function getObjectWithTime(key) {
	const res = await client.fetch(`${endpoint}/${BUCKET}/${key}`);
	if (!res.ok) {
		throw new Error(`get ${key} failed: ${res.status}`);
	}
	const modified = Date.parse(res.headers.get("Last-Modified") ?? "");
	return {
		fetchedAt: Number.isFinite(modified) ? modified : Date.now(),
		text: await res.text(),
	};
}

/**
 * Every archived Apple Ads response, flattened into rows.
 *
 * A genre object whose key names only the category is skipped and counted:
 * that was the layout before the genre id went into the key, and
 * PRODUCTIVITY_UTILITIES maps back to two genres, so the dimension those rows
 * were stored under is not in the archive. Skipping is the honest move;
 * guessing would put one storefront-wide list under two labels.
 */
async function loadAdsRows(since, until) {
	const genre = [];
	const terms = [];
	let skipped = 0;
	for (const key of await listAll("ads/popularity/")) {
		const dims = parseGenreKey(key);
		if (!dims) {
			skipped += 1;
			continue;
		}
		if (!inRange(dims.week, since, until)) {
			continue;
		}
		const { fetchedAt, text } = await getObjectWithTime(key);
		genre.push(...adsRows(JSON.parse(text), dims, fetchedAt));
	}
	for (const key of await listAll("ads/popularity-terms/")) {
		const dims = parseTermsKey(key);
		if (!dims) {
			skipped += 1;
			continue;
		}
		if (!inRange(dims.week, since, until)) {
			continue;
		}
		const { fetchedAt, text } = await getObjectWithTime(key);
		terms.push(...adsRows(JSON.parse(text), dims, fetchedAt));
	}
	return { genre, skipped, terms };
}

const collectorDir = new URL("../../apps/collector", import.meta.url).pathname;

const config = wranglerConfig(collectorDir);

function d1(command) {
	const raw = execFileSync("npx", d1Args(config, command), {
		cwd: collectorDir,
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const [{ results }] = JSON.parse(raw);
	return results;
}

function flag(name) {
	const at = process.argv.indexOf(name);
	return at === -1 ? null : (process.argv[at + 1] ?? "");
}

const verify = process.argv.includes("--verify");
const outFile = flag("--out") ?? "rebuild.sql";
const since = flag("--since");
const until = flag("--until");
for (const [name, value] of [
	["--since", since],
	["--until", until],
]) {
	if (value !== null && !isIsoDate(value)) {
		console.error(`${name} takes a date as YYYY-MM-DD`);
		process.exit(2);
	}
}
if (!outFile) {
	console.error("--out takes a file name");
	process.exit(2);
}

const archived = await listAll("rankings/v1/");
const months = byMonth(
	archived.filter((key) => {
		const date = rankingKeyDate(key);
		return date !== null && inRange(date, since, until);
	})
);
console.log(
	`archive files: ${[...months.values()].reduce((n, keys) => n + keys.length, 0)} across ${months.size} month(s)`
);

/** One month's observations. Never more than a month is held at once. */
async function loadMonth(keys) {
	const observations = [];
	for (const key of keys) {
		const body = await getObject(key);
		for (const line of body.split("\n")) {
			if (line.trim()) {
				observations.push(JSON.parse(line));
			}
		}
	}
	return observations;
}

/** Appended in slices, so no string ever holds the whole month. */
function writeStatements(file, lines) {
	writeFileSync(file, "");
	for (let i = 0; i < lines.length; i += 2000) {
		appendFileSync(file, `${lines.slice(i, i + 2000).join("\n")}\n`);
	}
}

if (verify) {
	const bounds = [
		since ? `AND observed_date >= '${since}'` : "",
		until ? `AND observed_date <= '${until}'` : "",
	].join(" ");
	const live = new Map();
	// Counts first, for the dates the archive has no object for at all; the
	// pair-level read below is then one query per archived month.
	for (const row of d1(
		`SELECT observed_date AS d FROM ranking WHERE valid = 1 ${bounds} GROUP BY observed_date`
	)) {
		live.set(row.d, new Set());
	}
	const archive = new Map();
	let observed = 0;
	for (const [month, keys] of months) {
		for (const o of await loadMonth(keys)) {
			archive.set(o.date, (archive.get(o.date) ?? new Set()).add(o.pairId));
			observed += 1;
		}
		console.log(`read ${month}`);
	}
	const unarchived = [...live.keys()].filter((d) => !archive.has(d));
	const monthsToRead = new Set([
		...months.keys(),
		...unarchived.map((d) => d.slice(0, 7)),
	]);
	for (const month of monthsToRead) {
		for (const row of d1(
			`SELECT observed_date AS d, pair_id AS p FROM ranking WHERE valid = 1 AND observed_date LIKE '${month}-%' ${bounds}`
		)) {
			live.set(row.d, (live.get(row.d) ?? new Set()).add(row.p));
		}
	}
	// Compaction runs overnight and catches up for a few days, so the two
	// newest dates may rightly be in D1 alone.
	const settledBefore = new Date(Date.now() - 86_400_000)
		.toISOString()
		.slice(0, 10);
	const drift = findDrift(archive, live, settledBefore);
	console.log(
		`archive: ${observed} observations on ${archive.size} date(s); D1: ${live.size} date(s) with valid rankings`
	);
	if (drift.length === 0) {
		console.log(
			archive.size > 0
				? "No drift: every archived date matches D1 pair for pair."
				: "Archive empty in this range, nothing to verify."
		);
		process.exit(0);
	}
	for (const d of drift) {
		console.log(
			`${d.date}: ${d.missingFromD1} in the archive and not in D1, ${d.missingFromArchive} in D1 and not in the archive`
		);
	}
	console.error(
		`DRIFT on ${drift.length} date(s). Rows missing from D1 are what a rebuild restores; rows missing from the archive cannot be rebuilt, so do not prune D1 for those dates.`
	);
	process.exit(1);
}

// Which apps get an index row beyond the top ten is decided by the tracked set,
// so a rebuild that could not read it would silently index less than the
// crawler did. Fail instead.
const trackedIds = new Set(
	d1("SELECT DISTINCT app_id FROM tracked_app").map((r) => r.app_id)
);
console.log(`tracked apps: ${trackedIds.size}`);

const written = [];
for (const [month, keys] of months) {
	const observations = await loadMonth(keys);
	const file = partFile(outFile, month);
	const lines = buildSql(observations, trackedIds);
	writeStatements(file, lines);
	written.push(file);
	console.log(
		`${month}: ${observations.length} observations, ${lines.length} statements (ranking, app, rank_entry) to ${file}`
	);
}

const ads = await loadAdsRows(since, until);
console.log(
	`ads rows in archive: ${ads.genre.length} ranked, ${ads.terms.length} by-name${
		ads.skipped > 0
			? ` (${ads.skipped} objects skipped: key carries no genre id)`
			: ""
	}`
);
const adsLines = buildAdsSql(ads.genre, ads.terms);
if (adsLines.length > 0) {
	const file = partFile(outFile, "ads");
	writeStatements(file, adsLines);
	written.push(file);
	console.log(
		`${adsLines.length} statements (seed_term, popularity) to ${file}`
	);
}

if (written.length === 0) {
	console.log("Nothing in the archive for this range; no file written.");
	process.exit(0);
}
console.log(
	"Apply in order, one file at a time. Each row written counts against the day's D1 write budget, which live collection also needs:"
);
for (const file of written) {
	console.log(`  ${applyHint(config, file, collectorDir)}`);
}
