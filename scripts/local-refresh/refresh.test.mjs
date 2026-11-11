/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals -- `pnpm test:scripts` runs these under node --test, which vitest cannot reach */

// Runs refresh.sh end to end against stubs: `npx` (wrangler dev) announces
// readiness and exits, `curl` answers each job from a script of canned bodies
// and records how it was called, and `sleep` is all but instant. Nothing
// reaches the network or Apple; what is under test is how the script reacts to
// what the collector says.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const TOKEN = "admin-token-under-test";

const CURL = `#!/bin/bash
printf '%s\\n' "$*" >>"$STUB/curl.argv"
for a in "$@"; do [ "$a" = "@-" ] && cat >>"$STUB/curl.stdin"; done
url="\${@: -1}"
job="\${url##*job=}"
echo "$job" >>"$STUB/calls"
f="$STUB/responses/$job"
if [ -s "$f" ]; then
  head -n 1 "$f"
  tail -n +2 "$f" >"$f.rest"; mv "$f.rest" "$f"
  exit 0
fi
case "$job" in
  cadence) echo '{"job":"cadence","ok":true}' ;;
  daily) echo '{"job":"daily","queued":0}' ;;
  *) echo '{"empty":true}' ;;
esac
`;

function bin(dir, name, body) {
	writeFileSync(path.join(dir, name), body);
	chmodSync(path.join(dir, name), 0o755);
}

/** A checkout-shaped tree around a copy of the script, with stubbed tools. */
function run(
	responses,
	{ portHeld = false, staleConfig = false, verifyStatus = 0 } = {}
) {
	const root = mkdtempSync(path.join(tmpdir(), "local-refresh-"));
	const scripts = path.join(root, "scripts", "local-refresh");
	const collector = path.join(root, "apps", "collector");
	const stub = path.join(root, "stub");
	// refresh.sh puts $HOME/.vite-plus/bin first on PATH, so the stubs go there.
	const home = path.join(root, "home");
	const tools = path.join(home, ".vite-plus", "bin");
	for (const dir of [scripts, collector, path.join(stub, "responses"), tools]) {
		mkdirSync(dir, { recursive: true });
	}
	copyFileSync(
		path.join(import.meta.dirname, "refresh.sh"),
		path.join(scripts, "refresh.sh")
	);
	bin(scripts, "verify.sh", `#!/bin/sh\nexit ${verifyStatus}\n`);
	writeFileSync(
		path.join(collector, "wrangler.localcrawl.jsonc"),
		staleConfig ? "{}" : '{\n  "vars": {\n    "WORK_LOOP": "off"\n  }\n}\n'
	);
	writeFileSync(path.join(collector, ".dev.vars"), `ADMIN_TOKEN=${TOKEN}\n`);
	bin(tools, "npx", "#!/bin/sh\necho 'Ready on http://localhost'\n");
	bin(tools, "lsof", `#!/bin/sh\nexit ${portHeld ? 0 : 1}\n`);
	bin(tools, "sleep", "#!/bin/sh\nexec /bin/sleep 0.01\n");
	bin(tools, "curl", CURL);
	for (const [job, bodies] of Object.entries(responses)) {
		writeFileSync(
			path.join(stub, "responses", job),
			`${bodies.map((b) => JSON.stringify(b)).join("\n")}\n`
		);
	}
	const logs = path.join(root, "logs");
	const { status } = spawnSync("bash", [path.join(scripts, "refresh.sh")], {
		env: {
			...process.env,
			APPRANK_LOG_DIR: logs,
			HOME: home,
			PATH: `${tools}:${process.env.PATH}`,
			STUB: stub,
		},
		stdio: "ignore",
	});
	const read = (name) =>
		existsSync(path.join(stub, name))
			? readFileSync(path.join(stub, name), "utf-8")
			: "";
	const log = readdirSync(logs)
		.filter((name) => name.startsWith("refresh-"))
		.map((name) => readFileSync(path.join(logs, name), "utf-8"))
		.join("");
	return {
		argv: read("curl.argv"),
		calls: read("calls").split("\n").filter(Boolean),
		log,
		status,
		stdin: read("curl.stdin"),
	};
}

const crawled = (pairId) => ({ empty: false, pairId, throttled: false });
const step = (over) => ({
	empty: false,
	errors: [],
	followUps: 0,
	ok: true,
	task: "lookup",
	...over,
});

test("a throttled crawl drains no steps against the same address", () => {
	const { calls } = run({
		crawl: [crawled(1), { empty: false, pairId: 2, throttled: true }],
		step: [step(), step(), step()],
	});
	assert.deepEqual(calls, ["cadence", "crawl", "crawl"]);
});

function stepsAfterBackPressure(errorClass) {
	const hit = step({ errors: [{ endpoint: "lookup", errorClass }], ok: false });
	const { calls } = run({ step: [hit, hit, hit, hit, hit] });
	return calls.filter((c) => c === "step").length;
}

test("a throttled step ends the drain instead of retrying", () => {
	assert.equal(stepsAfterBackPressure("throttled"), 1);
});

test("a rate-limited step ends the drain instead of retrying", () => {
	assert.equal(stepsAfterBackPressure("rate_limited"), 1);
});

test("a step that failed for another reason still lets the drain go on", () => {
	const failed = step({
		errors: [{ endpoint: "lookup", errorClass: "http_error" }],
		ok: false,
	});
	const { calls } = run({ step: [failed, step(), step()] });
	assert.equal(calls.filter((c) => c === "step").length, 4);
});

test("the admin token never appears on curl's command line", () => {
	const { argv, stdin } = run({ crawl: [crawled(1)] });
	assert.ok(argv.length > 0);
	assert.doesNotMatch(argv, new RegExp(TOKEN, "u"));
	assert.match(stdin, new RegExp(`^Authorization: Bearer ${TOKEN}$`, "mu"));
});

test("a cycle that collected everything due exits 0", () => {
	const { status } = run({ crawl: [crawled(1), crawled(2)], step: [step()] });
	assert.equal(status, 0);
});

test("a throttled cycle is not a green run", () => {
	// Verify passes on a day nothing was collected, because it checks only the
	// rows that exist. On a runner with one cron a day that green was the whole
	// report, and the day's ranks were gone.
	const { log, status } = run({
		crawl: [{ empty: false, pairId: 1, throttled: true }],
	});
	assert.equal(status, 3);
	assert.match(log, /INCOMPLETE: throttled=1/u);
});

test("a throttled step fails the cycle the same way", () => {
	const hit = step({
		errors: [{ endpoint: "lookup", errorClass: "throttled" }],
		ok: false,
	});
	assert.equal(run({ step: [hit] }).status, 3);
});

test("a crawl loop that gave up with pairs still due exits 3", () => {
	const { calls, status } = run({ crawl: ["", "", ""].map(() => "boom") });
	assert.equal(calls.filter((c) => c === "crawl").length, 3);
	assert.equal(status, 3);
});

test("a step drain that stopped short exits 3", () => {
	const failed = step({
		errors: [{ endpoint: "lookup", errorClass: "http_error" }],
		ok: false,
	});
	assert.equal(run({ step: [failed, failed, failed, failed] }).status, 3);
});

test("a verify failure outranks an incomplete cycle", () => {
	const throttledCrawl = [{ empty: false, pairId: 1, throttled: true }];
	assert.equal(run({ crawl: throttledCrawl }, { verifyStatus: 1 }).status, 1);
	assert.equal(run({ crawl: throttledCrawl }, { verifyStatus: 2 }).status, 2);
});

test("a held port is its own failure and touches nothing", () => {
	// It answered 0, so an orphaned workerd turned every later cycle into a
	// successful no-op.
	const { calls, status } = run({ crawl: [crawled(1)] }, { portHeld: true });
	assert.equal(status, 4);
	assert.deepEqual(calls, []);
});

test("no logged body carries a keyword or a raw exception message", () => {
	const secret = "terme secret";
	const { log, status } = run({
		crawl: [
			{ empty: false, keyword: secret, pairId: 1, throttled: false },
			{ error: "boom", keyword: secret },
		],
		daily: [{ error: "boom", keyword: secret, threw: secret }],
		step: [
			step({ keyword: secret }),
			step({ ok: false, threw: `no such row for ${secret}` }),
		],
	});
	// Every branch that logs a body ran: a crawl, a crawl error, a failed
	// fan-out, a clean step and a step that threw.
	assert.equal(status, 0);
	for (const line of [
		"crawled pair 1",
		"error response",
		"daily fan-out failed",
		"step: ",
		"step (recorded an error)",
	]) {
		assert.ok(log.includes(line), line);
	}
	assert.match(log, /"threw":"<redacted, see fetch_error>"/u);
	assert.doesNotMatch(log, /terme secret/u);
});

test("a config written before WORK_LOOP is refused before anything is fetched", () => {
	const { calls, status } = run({ crawl: [crawled(1)] }, { staleConfig: true });
	assert.equal(status, 1);
	assert.deepEqual(calls, []);
});
