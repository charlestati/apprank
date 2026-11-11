/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.join(import.meta.dirname, "write-config.mjs");

function generate() {
	const dir = mkdtempSync(path.join(tmpdir(), "apprank-crawl-config-"));
	const out = path.join(dir, "wrangler.localcrawl.jsonc");
	try {
		execFileSync(process.execPath, [script, out], {
			env: { ...process.env, D1_DATABASE_ID: "test-database-id" },
			stdio: "pipe",
		});
		const [, ...body] = readFileSync(out, "utf-8").split("\n");
		return JSON.parse(body.join("\n"));
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

test("the runner config has no schedule and no work loop of its own", () => {
	const config = generate();
	// Crons would make the session a second collector racing the deployment;
	// the Durable Object's alarm loop would make it a second fetcher racing
	// refresh.sh, which is what the 2026-11-11 run's log showed.
	assert.equal(config.triggers, undefined);
	assert.equal(config.vars.WORK_LOOP, "off");
});

test("the runner config collects everything, against the real database", () => {
	const config = generate();
	assert.equal(config.vars.COLLECTION_MODE, "all");
	assert.equal(config.d1_databases[0].database_id, "test-database-id");
	assert.equal(config.d1_databases[0].remote, true);
	assert.equal(config.r2_buckets[0].remote, true);
});

test("refuses to write a config without a database id", () => {
	const env = { ...process.env };
	delete env.D1_DATABASE_ID;
	assert.throws(() =>
		execFileSync(process.execPath, [script, "/dev/null"], {
			env,
			stdio: "pipe",
		})
	);
});
