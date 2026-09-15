#!/usr/bin/env node

// Score the pending keyword suggestions against the tracked set, on this
// machine, with a local embedding model.
//
// The collector cannot do this. It runs on Workers, its filter is whole-word
// overlap with the seed, and that admits same-word false friends (an
// unrelated app that happens to share a short seed word) while rejecting real
// variants that share no word. This is the second pass: it never proposes anything, it
// only rules out what the cheap filter let through.
//
// Usage:
//   node score.mjs [--storefront fr] [--threshold 0.75] [--model …] [--apply]
//
//   --apply   dismiss everything below the threshold. Without it, nothing is
//             written and the report is the whole output.
//
// Needs `ollama serve` running and the model pulled, plus wrangler auth for the
// database. A dismissal is reversible in the sense that the row survives with
// its reason; it is not re-proposed, which is the point.

import { execFileSync } from "node:child_process";
import path from "node:path";

import { scoreCandidates, split } from "./relevance.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const COLLECTOR = path.join(ROOT, "apps/collector");
const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

/**
 * Where to cut, measured against this model on the live French set.
 *
 * The absolute number means little: `qwen3-embedding:0.6b` scores short related
 * phrases high, so the whole distribution sat between 0.69 and 0.99 and only
 * the ranking is informative. What the data showed is a clean break just below
 * 0.75, with every false friend the word-overlap filter had admitted underneath
 * it (three at 0.689, 0.700 and 0.701) and the first real variant at 0.785.
 *
 * Deliberately conservative. A proposal wrongly dropped is never offered again,
 * while one wrongly kept costs a glance, so the default cuts only what is
 * unambiguous and the report exists to argue with.
 */
const DEFAULT_THRESHOLD = "0.75";

const args = process.argv.slice(2);
function flag(name, fallback) {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
}
const storefront = flag("storefront", "fr");
// Interpolated into SQL below, so it has to be a storefront code and nothing else.
if (!/^[a-z]{2}$/u.test(storefront)) {
	console.error(`--storefront must be a two-letter code, got ${storefront}`);
	process.exit(2);
}
const threshold = Number(flag("threshold", DEFAULT_THRESHOLD));
// Pinned rather than defaulted: the same text through a different model is a
// different number, and a threshold calibrated against one says nothing about
// the other.
const model = flag("model", "qwen3-embedding:0.6b");
const apply = args.includes("--apply");

function d1(command) {
	const config = "wrangler.local.jsonc";
	const raw = execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"apprank",
			"--remote",
			"--config",
			config,
			"--json",
			"--command",
			command,
		],
		{ cwd: COLLECTOR, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
	);
	const [{ results }] = JSON.parse(raw);
	return results;
}

/**
 * One request per batch, not per term: the model is local but the per-call
 * overhead is not, and a tracked set of a few hundred terms is a single batch.
 */
async function embed(texts) {
	const res = await fetch(`${OLLAMA}/api/embed`, {
		body: JSON.stringify({ input: texts, model }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		throw new Error(
			`ollama embed failed: ${res.status} ${await res.text()}\n` +
				`Is 'ollama serve' running and '${model}' pulled?`
		);
	}
	const body = await res.json();
	return body.embeddings;
}

const tracked = d1(
	`SELECT DISTINCT k.normalized AS term FROM crawl_pair cp
     JOIN keyword k ON k.id = cp.keyword_id
    WHERE cp.storefront_code = '${storefront}' AND cp.ref_count > 0`
).map((r) => r.term);

const pending = d1(
	`SELECT id, json_extract(payload, '$.term') AS term,
          json_extract(payload, '$.seed') AS seed
     FROM suggestion
    WHERE status = 'pending' AND type = 'promote_keyword'
      AND json_extract(payload, '$.storefront') = '${storefront}'`
);

if (tracked.length === 0 || pending.length === 0) {
	console.log(
		`${storefront}: ${pending.length} pending against ${tracked.length} tracked. Nothing to score.`
	);
	process.exit(0);
}

console.log(
	`${storefront}: scoring ${pending.length} pending against ${tracked.length} tracked keywords with ${model}`
);

const [trackedVectors, candidateVectors] = await Promise.all([
	embed(tracked),
	embed(pending.map((p) => p.term)),
]);

const scored = scoreCandidates(
	pending.map((p, i) => ({ ...p, vector: candidateVectors[i] })),
	tracked.map((term, i) => ({ term, vector: trackedVectors[i] }))
);
const { drop, keep } = split(scored, threshold);

for (const s of scored) {
	const mark = s.score < threshold ? "drop" : "keep";
	console.log(
		`${s.score.toFixed(3)}  ${mark}  ${s.term.padEnd(38)} nearest: ${s.nearest}`
	);
}
console.log(`\n${keep.length} keep, ${drop.length} below ${threshold}`);

if (!apply) {
	console.log("Dry run. Pass --apply to dismiss the ones below the threshold.");
	process.exit(0);
}
if (drop.length === 0) {
	process.exit(0);
}
d1(
	`UPDATE suggestion SET status = 'dismissed' WHERE id IN (${drop.map((d) => d.id).join(",")})`
);
console.log(`dismissed ${drop.length}`);
