// How the rebuild reaches D1. Kept apart from rebuild.mjs, which connects to R2
// on import, so the choice of database can be tested.
//
// The committed wrangler.jsonc carries a placeholder database_id, so a call
// without `-c` targets a database that does not exist, or worse, someone
// else's. Every script prefers the gitignored wrangler.local.jsonc, where the
// real id lives, and this one has to as well.

import { existsSync } from "node:fs";
import path from "node:path";

export function wranglerConfig(collectorDir) {
	return existsSync(path.join(collectorDir, "wrangler.local.jsonc"))
		? "wrangler.local.jsonc"
		: "wrangler.jsonc";
}

/**
 * argv for one query. An argv rather than a shell string: the SQL holds quotes
 * and `*`, which a shell would strip or expand.
 */
export function d1Args(config, command) {
	return [
		"wrangler",
		"d1",
		"execute",
		"apprank",
		"--remote",
		"-c",
		config,
		"--json",
		"--command",
		command,
	];
}

const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * The command that applies the written SQL, runnable from anywhere: pnpm runs
 * the script from its own folder, so a relative --file would name a path the
 * reader is not in.
 */
export function applyHint(config, outFile, collectorDir) {
	return `cd ${shellQuote(collectorDir)} && npx wrangler d1 execute apprank --remote -c ${shellQuote(config)} --file ${shellQuote(path.resolve(outFile))}`;
}
