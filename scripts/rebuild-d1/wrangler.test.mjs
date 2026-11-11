/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyHint, d1Args, wranglerConfig } from "./wrangler.mjs";

function collector({ local }) {
	const dir = mkdtempSync(path.join(tmpdir(), "rebuild-d1-"));
	writeFileSync(path.join(dir, "wrangler.jsonc"), "{}");
	if (local) {
		writeFileSync(path.join(dir, "wrangler.local.jsonc"), "{}");
	}
	return dir;
}

/** An `npx` on PATH that prints its argv, one per line, and its cwd. */
function stubNpx() {
	const bin = mkdtempSync(path.join(tmpdir(), "rebuild-d1-bin-"));
	writeFileSync(
		path.join(bin, "npx"),
		'#!/bin/sh\npwd\nfor a in "$@"; do printf "%s\\n" "$a"; done\n'
	);
	chmodSync(path.join(bin, "npx"), 0o755);
	return bin;
}

test("queries the real database when wrangler.local.jsonc exists, never the placeholder", () => {
	const config = wranglerConfig(collector({ local: true }));
	assert.equal(config, "wrangler.local.jsonc");
	const args = d1Args(config, "SELECT 1");
	assert.equal(args[args.indexOf("-c") + 1], "wrangler.local.jsonc");
	assert.ok(args.includes("--remote"));
});

test("falls back to the committed config on a clone with no local one", () => {
	assert.equal(wranglerConfig(collector({ local: false })), "wrangler.jsonc");
});

test("passes the SQL as one argument, quotes and wildcards intact", () => {
	const sql =
		"SELECT COUNT(*) AS n FROM ranking WHERE observed_date = '2026-09-08'";
	assert.equal(d1Args("wrangler.jsonc", sql).at(-1), sql);
});

test("the printed apply command runs from anywhere against the local config and the written file", () => {
	const dir = collector({ local: true });
	const elsewhere = mkdtempSync(path.join(tmpdir(), "rebuild-d1-cwd-"));
	const hint = applyHint("wrangler.local.jsonc", "rebuild.sql", dir);
	const [cwd, ...argv] = execFileSync("bash", ["-c", hint], {
		cwd: elsewhere,
		encoding: "utf-8",
		env: { ...process.env, PATH: `${stubNpx()}:${process.env.PATH}` },
	})
		.trim()
		.split("\n");
	assert.equal(path.basename(cwd), path.basename(dir));
	assert.equal(argv[argv.indexOf("-c") + 1], "wrangler.local.jsonc");
	assert.equal(argv[argv.indexOf("--file") + 1], path.resolve("rebuild.sql"));
	assert.ok(argv.includes("--remote"));
});
