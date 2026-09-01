// ASC Analytics Reports ingestion, for every tracked app, no app hardcoded.
//
// Flow per day (driven by the SchedulerDO task loop, one bounded step per
// tick):
//   asc_poll (fan-out)  read tracked apps from D1, queue one init per app
//   asc_poll(init)      ensure ONGOING + ONE_TIME_SNAPSHOT requests exist
// asc_poll(reports) list reports for the ONGOING request, filter categories,
// dump the full report list to R2 once (per-search-term verification)
//   asc_poll(instances) for one report at a time: list DAILY instances, queue
//                       unseen ones as asc_fetch_instance tasks
//   asc_fetch_instance  download all segments verbatim (.tsv.gz) to R2, record
//                       bookkeeping, detect duplicate/skipped processingDate
//
// Verbatim-first: parsing into metric tables comes after we've seen real
// report shapes. The archive is the source of truth; a parser can always
// re-run.

import { AscClient, downloadSegment } from "@apprank/core/apple/asc";
import type { AscCredentials } from "@apprank/core/apple/asc";

import type { Env } from "../env";
import { getStateJson, setStateJson, recordFetchError } from "../lib/state";
import type { Task, AscReportRef } from "./types";

const DEFAULT_CATEGORIES = ["APP_STORE_ENGAGEMENT", "COMMERCE", "APP_USAGE"];

function ascCreds(env: Env): AscCredentials {
	return {
		issuerId: env.ASC_ISSUER_ID,
		keyId: env.ASC_KEY_ID,
		privateKeyPem: env.ASC_PRIVATE_KEY,
	};
}

async function fanOutStep(env: Env): Promise<Task[]> {
	// The apps to ingest come from the database, never from configuration:
	// ASC reports exist only for apps the operator owns, which in practice is
	// the tracked set (misconfigured ones fail per-app and are recorded).
	const apps = await env.DB.prepare(
		"SELECT DISTINCT app_id FROM tracked_app"
	).all<{ app_id: number }>();
	return apps.results.map((a) => ({
		appId: String(a.app_id),
		stage: "init" as const,
		type: "asc_poll" as const,
	}));
}

async function initStep(env: Env, appId: string): Promise<Task[]> {
	const asc = new AscClient(ascCreds(env));
	const existing = await asc.listReportRequests(appId);
	let ongoing = existing.find(
		(r) =>
			r.attributes.accessType === "ONGOING" &&
			!r.attributes.stoppedDueToInactivity
	);
	const stopped = existing.find(
		(r) =>
			r.attributes.accessType === "ONGOING" &&
			r.attributes.stoppedDueToInactivity
	);
	if (stopped) {
		// Known ASC behavior: ONGOING requests die if not polled. Recreate; alert
		// via fetch_error.
		await recordFetchError(env.DB, {
			endpoint: "asc:reportRequest",
			errorClass: "stopped_due_to_inactivity",
			params: appId,
		});
	}
	if (!ongoing) {
		ongoing = await asc.createReportRequest(appId, "ONGOING");
	}
	// One-time snapshot: fire once ever per app, to capture all available
	// history.
	const snapshotKey = `asc:${appId}:snapshot_requested`;
	const snapshotDone = await getStateJson<boolean>(env.DB, snapshotKey);
	if (
		!snapshotDone &&
		!existing.some((r) => r.attributes.accessType === "ONE_TIME_SNAPSHOT")
	) {
		await asc.createReportRequest(appId, "ONE_TIME_SNAPSHOT");
		await setStateJson(env.DB, snapshotKey, true);
	}
	await setStateJson(env.DB, `asc:${appId}:ongoing_request_id`, ongoing.id);
	return [{ appId, requestId: ongoing.id, stage: "reports", type: "asc_poll" }];
}

async function reportsStep(
	env: Env,
	appId: string,
	taskRequestId: string | undefined
): Promise<Task[]> {
	const asc = new AscClient(ascCreds(env));
	const requestId =
		taskRequestId ??
		(await getStateJson<string>(env.DB, `asc:${appId}:ongoing_request_id`));
	if (!requestId) {
		return [{ appId, stage: "init", type: "asc_poll" }];
	}
	const reports = await asc.listReports(requestId);
	// Dump the complete report list once. This is how we verify whether any
	// report carries per-search-term impressions (open question from planning).
	const dumpedKey = `asc:${appId}:report_list_dumped`;
	const dumped = await getStateJson<boolean>(env.DB, dumpedKey);
	if (!dumped) {
		await env.ARCHIVE.put(
			`asc/${appId}/report-list-${requestId}.json`,
			JSON.stringify(
				reports.map((r) => ({ id: r.id, ...r.attributes })),
				null,
				2
			)
		);
		await setStateJson(env.DB, dumpedKey, true);
	}
	const categories =
		(await getStateJson<string[]>(env.DB, "asc:categories")) ??
		DEFAULT_CATEGORIES;
	const wanted: AscReportRef[] = reports
		.filter((r) => categories.includes(r.attributes.category))
		.map((r) => ({
			category: r.attributes.category,
			name: r.attributes.name,
			reportId: r.id,
		}));
	return [
		{
			appId,
			reportQueue: wanted,
			requestId,
			stage: "instances",
			type: "asc_poll",
		},
	];
}

async function instancesStep(
	env: Env,
	task: Extract<Task, { type: "asc_poll" }>
): Promise<Task[]> {
	// One report per tick to stay inside the subrequest budget.
	const asc = new AscClient(ascCreds(env));
	const queue = task.reportQueue ?? [];
	const [report] = queue;
	if (!report) {
		return [];
	}
	const rest = queue.slice(1);
	const instances = await asc.listInstances(report.reportId, "DAILY");
	const followUps: Task[] = [];
	for (const inst of instances) {
		const seen = await env.DB.prepare(
			"SELECT id FROM asc_report_instance WHERE app_id = ? AND report_type = ? AND granularity = ? AND processing_date = ? AND instance_id = ?"
		)
			.bind(
				task.appId,
				report.name,
				inst.attributes.granularity,
				inst.attributes.processingDate,
				inst.id
			)
			.first();
		if (!seen) {
			followUps.push({
				appId: task.appId ?? "",
				granularity: inst.attributes.granularity,
				instanceId: inst.id,
				processingDate: inst.attributes.processingDate,
				report,
				type: "asc_fetch_instance",
			});
		}
	}
	if (rest.length > 0) {
		followUps.push({
			appId: task.appId,
			reportQueue: rest,
			requestId: task.requestId,
			stage: "instances",
			type: "asc_poll",
		});
	}
	return followUps;
}

export function ascPollStep(
	env: Env,
	task: Extract<Task, { type: "asc_poll" }>
): Promise<Task[]> {
	if (!task.stage) {
		return fanOutStep(env);
	}
	if (task.stage === "init") {
		return initStep(env, task.appId ?? "");
	}
	if (task.stage === "reports") {
		return reportsStep(env, task.appId ?? "", task.requestId);
	}
	return instancesStep(env, task);
}

export async function ascFetchInstanceStep(
	env: Env,
	task: Extract<Task, { type: "asc_fetch_instance" }>
): Promise<Task[]> {
	const asc = new AscClient(ascCreds(env));
	const { appId, report, instanceId, granularity, processingDate } = task;

	// Duplicate processingDate detection (known Apple defect: two instances with
	// the same date, then the following date never publishes). Scoped to the app:
	// across two tracked apps, the same report type and date is the normal case,
	// and comparing them flagged every second app's first report as a defect.
	const dup = await env.DB.prepare(
		"SELECT id FROM asc_report_instance WHERE app_id = ? AND report_type = ? AND granularity = ? AND processing_date = ? AND instance_id != ?"
	)
		.bind(appId, report.name, granularity, processingDate, instanceId)
		.first();

	const segments = await asc.listSegments(instanceId);
	const safeName = report.name.replaceAll(/[^\w.-]+/gu, "_");
	let firstKey: string | null = null;
	for (const [i, seg] of segments.entries()) {
		const res = await downloadSegment(seg.attributes.url);
		const key = `asc/${appId}/${safeName}/${granularity}/${processingDate}-${instanceId}-${i}.tsv.gz`;
		await env.ARCHIVE.put(key, res.body, {
			httpMetadata: { contentType: "application/gzip" },
		});
		firstKey ??= key;
	}

	await env.DB.prepare(
		"INSERT OR IGNORE INTO asc_report_instance (app_id, report_type, granularity, processing_date, instance_id, r2_key, checksum, anomaly, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)
		.bind(
			appId,
			report.name,
			granularity,
			processingDate,
			instanceId,
			firstKey,
			segments[0]?.attributes.checksum ?? null,
			dup ? "duplicate_date" : null,
			Date.now()
		)
		.run();
	if (dup) {
		await recordFetchError(env.DB, {
			endpoint: "asc:instance",
			errorClass: "duplicate_processing_date",
			params: `${appId} ${report.name} ${processingDate}`,
		});
	}
	return [];
}

/**
 * Daily gap check: yesterday-2 should exist for each report we ingest.
 *
 * Grouped per app. Apple skips a processing date per report request, and
 * requests are per app, so with the app dimension collapsed, one app's
 * published Monday satisfied the `NOT EXISTS` for every other app's missing
 * Monday and the defect went unreported.
 */
export async function ascDetectSkippedDates(env: Env): Promise<void> {
	const rows = await env.DB.prepare(
		"SELECT app_id, report_type, MAX(processing_date) AS latest, COUNT(DISTINCT processing_date) AS days FROM asc_report_instance WHERE granularity = 'DAILY' GROUP BY app_id, report_type"
	).all<{
		app_id: number;
		report_type: string;
		latest: string;
		days: number;
	}>();
	for (const r of rows.results) {
		const gaps = await env.DB.prepare(
			`SELECT DATE(a.processing_date, '+1 day') AS missing FROM asc_report_instance a
       WHERE a.granularity = 'DAILY' AND a.app_id = ? AND a.report_type = ?
         AND DATE(a.processing_date, '+1 day') < ?
         AND NOT EXISTS (
           SELECT 1 FROM asc_report_instance b
           WHERE b.app_id = a.app_id AND b.report_type = a.report_type
             AND b.granularity = 'DAILY'
             AND b.processing_date = DATE(a.processing_date, '+1 day'))
       LIMIT 10`
		)
			.bind(r.app_id, r.report_type, r.latest)
			.all<{ missing: string }>();
		for (const g of gaps.results) {
			await recordFetchError(env.DB, {
				endpoint: "asc:instance",
				errorClass: "skipped_processing_date",
				params: `${r.app_id} ${r.report_type} ${g.missing}`,
			});
		}
	}
}
