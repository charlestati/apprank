/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */

// Runs the commands issue.mjs prints through a real shell, with wrangler
// replaced by a stub, and applies the SQL that reaches it to a real SQLite
// table. What the operator pastes is the contract, not the text on screen.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const ISSUE = path.join(import.meta.dirname, "issue.mjs");

/** A checkout-shaped folder and an `npx` that prints the --command it gets. */
function sandbox() {
	const dir = mkdtempSync(path.join(tmpdir(), "mcp-token-"));
	mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
	const bin = path.join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(
		path.join(bin, "npx"),
		'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = "--command" ] && printf "%s" "$2"; shift; done\n'
	);
	chmodSync(path.join(bin, "npx"), 0o755);
	return { bin, dir };
}

function issue(...args) {
	const out = execFileSync("node", [ISSUE, ...args], { encoding: "utf-8" });
	const lines = out.split("\n");
	// Each printed command runs from its `cd apps/web` line to the blank line
	// after it, exactly what an operator would select and paste.
	const commands = lines.flatMap((line, i) => {
		if (!line.trim().startsWith("cd apps/web")) {
			return [];
		}
		const end = lines.indexOf("", i);
		return [lines.slice(i, end).join("\n")];
	});
	assert.equal(commands.length, 2, out);
	const [insert, revoke] = commands;
	return {
		id: out.match(/apprank_mcp_(?<id>[0-9a-f]+)_/u).groups.id,
		insert,
		revoke,
	};
}

/** The SQL the shell actually hands wrangler. */
function throughShell(command, { bin, dir }) {
	return execFileSync("bash", ["-c", command], {
		cwd: dir,
		encoding: "utf-8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	});
}

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE mcp_credential (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, secret_hash TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER)"
	);
	return db;
}

test("the scope list reaches the database as JSON the server can parse", () => {
	const box = sandbox();
	const db = database();
	const { insert } = issue(
		"--user",
		"o'brien",
		"--name",
		"bob-ci",
		"--scopes",
		"read:rankings,read:health"
	);
	const sql = throughShell(insert, box);
	assert.match(sql, /'\["read:rankings","read:health"\]'/u);
	db.exec(sql);
	const row = db
		.prepare("SELECT user_id, name, scopes FROM mcp_credential")
		.get();
	assert.equal(row.user_id, "o'brien");
	assert.equal(row.name, "bob-ci");
	assert.deepEqual(JSON.parse(row.scopes), ["read:rankings", "read:health"]);
});

test("revoking one user's credential leaves another user's of the same name alone", () => {
	const box = sandbox();
	const db = database();
	const alice = issue("--user", "alice", "--name", "laptop");
	const bob = issue("--user", "bob", "--name", "laptop");
	db.exec(throughShell(alice.insert, box));
	db.exec(throughShell(bob.insert, box));
	db.exec(throughShell(alice.revoke, box));
	const revoked = db
		.prepare(
			"SELECT user_id, revoked_at IS NOT NULL AS revoked FROM mcp_credential ORDER BY user_id"
		)
		.all()
		.map((r) => ({ ...r }));
	assert.deepEqual(revoked, [
		{ revoked: 1, user_id: "alice" },
		{ revoked: 0, user_id: "bob" },
	]);
	assert.notEqual(alice.id, bob.id);
});
