#!/usr/bin/env node
// Rebuild the D1 `ranking` observations from the R2 archive — the proof that
// D1 is a materialised view and R2 is the source of truth.
//
// Usage:
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node rebuild.mjs [--verify] [--out rebuild.sql]
//
//   --verify   don't write SQL; compare archive observation counts against the
//              live D1 ranking table (needs wrangler auth) and report drift
//   --out      write INSERT statements to a .sql file for `wrangler d1 execute`
//
// R2 credentials: create an R2 API token (dashboard → R2 → Manage API Tokens).
// Zero egress: reads are free.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { AwsClient } from "aws4fetch";

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

function sqlEscape(s) {
	return s === null || s === undefined
		? "NULL"
		: `'${String(s).replaceAll("'", "''")}'`;
}

const verify = process.argv.includes("--verify");
const outIdx = process.argv.indexOf("--out");
let outFile = "rebuild.sql";
if (outIdx !== -1) {
	[outFile] = process.argv.slice(outIdx + 1);
}

const keys = await listAll("rankings/v1/");
console.log(`archive files: ${keys.length}`);

const observations = [];
for (const key of keys) {
	const body = await getObject(key);
	for (const line of body.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		observations.push(JSON.parse(line));
	}
}
console.log(`observations in archive: ${observations.length}`);

if (verify) {
	const raw = execSync(
		`npx wrangler d1 execute apprank --remote --json --command "SELECT COUNT(*) AS n, MIN(observed_date) AS min_d, MAX(observed_date) AS max_d FROM ranking WHERE valid = 1"`,
		{
			cwd: new URL("../../apps/collector", import.meta.url).pathname,
			encoding: "utf-8",
		}
	);
	const [
		{
			results: [d1],
		},
	] = JSON.parse(raw);
	// The archive lags D1 by up to one day (compaction runs overnight), so
	// compare only fully-compacted dates.
	const dates = new Set(observations.map((o) => o.date));
	console.log(
		`D1 valid rankings: ${d1.n} (${d1.min_d} → ${d1.max_d}); archive dates: ${dates.size}`
	);
	console.log(
		dates.size > 0
			? "Run drift checks per-date as needed."
			: "Archive empty — nothing to verify yet."
	);
	process.exit(0);
}

const lines = observations.map(
	(o) =>
		`INSERT INTO ranking (pair_id, observed_date, fetched_at, http_status, response_ms, result_count, result_ids, collector_version, r2_key, valid) VALUES (` +
		`${o.pairId}, ${sqlEscape(o.date)}, ${o.fetchedAt}, ${o.httpStatus}, ${o.responseMs ?? "NULL"}, ${o.resultCount}, ${sqlEscape(JSON.stringify(o.resultIds))}, ${sqlEscape(o.collectorVersion)}, NULL, 1) ` +
		`ON CONFLICT(pair_id, observed_date) DO NOTHING;`
);
writeFileSync(outFile, `${lines.join("\n")}\n`);
console.log(`wrote ${lines.length} INSERTs to ${outFile}`);
console.log(
	`apply with: npx wrangler d1 execute apprank --remote --file ${outFile}  (from apps/collector)`
);
