/* oxlint-disable vitest/require-top-level-describe -- file-wide hooks belong at the top of the file, not nested in one describe. */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

import { tracked, startRun, finishRun, recordHeartbeat } from "../src/lib/runs";
import { getStateJson } from "../src/lib/state";

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM collector_run").run();
	await env.DB.prepare("DELETE FROM collector_state").run();
});

async function runs() {
	const rows = await env.DB.prepare(
		"SELECT job, trigger, started_at, finished_at, ok, detail FROM collector_run ORDER BY id"
	).all<{
		job: string;
		trigger: string;
		started_at: number;
		finished_at: number | null;
		ok: number | null;
		detail: string | null;
	}>();
	return rows.results;
}

describe(tracked, () => {
	it("closes the run row on success and keeps what the job reported", async () => {
		await tracked(env.DB, "daily", "cron", () =>
			Promise.resolve({ queued: 3 })
		);
		const [row] = await runs();
		expect(row?.job).toBe("daily");
		expect(row?.trigger).toBe("cron");
		expect(row?.ok).toBe(1);
		expect(row?.finished_at).not.toBeNull();
		expect(JSON.parse(row?.detail ?? "{}")).toStrictEqual({ queued: 3 });
	});

	it("closes the row as failed and rethrows, so callers are unchanged", async () => {
		await expect(
			tracked(env.DB, "daily", "admin", () =>
				Promise.reject(new Error("apple said no"))
			)
		).rejects.toThrow("apple said no");
		const [row] = await runs();
		expect(row?.ok).toBe(0);
		expect(row?.finished_at).not.toBeNull();
		expect(row?.detail).toContain("apple said no");
	});

	it("leaves the row unfinished when the job never returns, the alarm case", async () => {
		// A crash between start and finish is exactly what observation tables
		// cannot show, so an open row has to be the visible signal.
		await startRun(env.DB, "daily", "cron");
		const [row] = await runs();
		expect(row?.finished_at).toBeNull();
		expect(row?.ok).toBeNull();
	});

	it("ignores a finish for a run that was never opened", async () => {
		await finishRun(env.DB, 0, true);
		await expect(runs()).resolves.toHaveLength(0);
	});
});

describe(recordHeartbeat, () => {
	it("keeps only the newest tick, since only the newest one means anything", async () => {
		await recordHeartbeat(env.DB, { at: 1000, didWork: true, queued: 2 });
		await recordHeartbeat(env.DB, { at: 2000, didWork: false, queued: 0 });
		await expect(getStateJson(env.DB, "loop_heartbeat")).resolves.toStrictEqual(
			{ at: 2000, didWork: false, queued: 0 }
		);
	});
});
