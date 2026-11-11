/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */

// A workspace script named after a pnpm built-in can be shadowed silently: the
// built-in runs, exits 0, and the script never does. `pnpm rebuild:d1` ran
// `pnpm --filter rebuild-d1 rebuild` for exactly that reason, and printed a
// clean "Already up to date" in place of a rebuild.
//
// Whether pnpm picks the script or the built-in is decided by the manifest in
// the directory pnpm runs from, not the filtered package's (measured on pnpm
// 12.13). So a package script under a built-in name works from its own folder
// and is silently skipped through `pnpm --filter` from the root, unless the
// root defines the same name; and a few built-ins (`ci`) never look for a
// script at all.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..", "..");

/** Every command and alias `pnpm help` lists on pnpm 12. */
const BUILTINS = new Set(
	`access init recursive multi m add install i install-test it update up
	upgrade outdated audit change version lane bugs issues list ls ll la licenses
	licences why view info show v sbom whoami deprecate undeprecate unpublish star
	unstar stars dist-tag dist-tags ping doctor search s se find rebuild rb pack
	publish stage remove uninstall rm un uni patch patch-commit patch-remove peers
	set-script ss test t tst run run-script tasks pipeline exec dlx create
	completion start stop restart find-hash runtime rt env shim bin clean purge ci
	clean-install ic install-clean root prefix config c get set pkg pack-app store
	cache cat-file cat-index ignored-builds approve-builds permissions approve link
	ln import dedupe deploy prune fetch unlink dislink docs home repo self-update
	setup login adduser team owner owners logout with edit profile token xmas help`.split(
		/\s+/u
	)
);

/** Built-ins whose whole job is to run the same-named script. */
const ALWAYS_SCRIPT = new Set(["start", "test"]);

/**
 * Built-ins that defer to a same-named script in the manifest pnpm runs from.
 * Measured, not documented for all of them: `ci` is absent because it ran a
 * clean install over a root script of that name.
 */
const SCRIPT_FIRST = new Set([
	...ALWAYS_SCRIPT,
	"clean",
	"deploy",
	"purge",
	"rebuild",
	"tasks",
]);

function workspaceManifests() {
	const yaml = readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf-8");
	const globs = [];
	let inPackages = false;
	for (const line of yaml.split("\n")) {
		if (/^\S/u.test(line)) {
			inPackages = line.startsWith("packages:");
			continue;
		}
		const m =
			inPackages && line.match(/^\s+-\s+["']?(?<glob>[^"']+)["']?\s*$/u);
		if (m) {
			globs.push(m.groups.glob);
		}
	}
	const dirs = globs.flatMap((glob) => {
		assert.ok(glob.endsWith("/*"), `unsupported workspace glob ${glob}`);
		const parent = path.join(ROOT, glob.slice(0, -2));
		return readdirSync(parent, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(parent, d.name));
	});
	return dirs
		.map((dir) => path.join(dir, "package.json"))
		.filter((file) => existsSync(file))
		.map((file) => ({
			file: path.relative(ROOT, file),
			scripts: Object.keys(
				JSON.parse(readFileSync(file, "utf-8")).scripts ?? {}
			),
		}));
}

const rootScripts = new Set(
	Object.keys(
		JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")).scripts
	)
);

test("finds the workspace packages, so the checks below are not vacuous", () => {
	const files = new Set(workspaceManifests().map((m) => m.file));
	assert.ok(files.has(path.join("scripts", "rebuild-d1", "package.json")));
	assert.ok(files.has(path.join("apps", "collector", "package.json")));
});

/**
 * Root scripts deliberately named after a built-in that ignores them, and only
 * ever invoked through `pnpm run`. `ci` is the name CI and every doc call as
 * `pnpm run ci`; a bare `pnpm ci` is pnpm's clean install instead.
 */
const RUN_ONLY = new Set(["ci"]);

test("no root script is a built-in that ignores scripts", () => {
	const shadowed = [...rootScripts].filter(
		(name) =>
			BUILTINS.has(name) && !SCRIPT_FIRST.has(name) && !RUN_ONLY.has(name)
	);
	assert.deepEqual(shadowed, []);
});

test("no package script is shadowed by a built-in when run through --filter", () => {
	const shadowed = workspaceManifests().flatMap(({ file, scripts }) =>
		scripts
			.filter(
				(name) =>
					BUILTINS.has(name) &&
					!ALWAYS_SCRIPT.has(name) &&
					!(SCRIPT_FIRST.has(name) && rootScripts.has(name))
			)
			.map((name) => `${file}: ${name}`)
	);
	assert.deepEqual(shadowed, []);
});
