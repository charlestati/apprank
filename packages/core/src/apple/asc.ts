// App Store Connect API client for Analytics Reports retrieval.
// Five-step flow: report request → reports → instances → segments → download.

import { importP8, signJwt, nowEpochSeconds } from "./jwt";

export interface AscCredentials {
	issuerId: string;
	keyId: string;
	privateKeyPem: string; // .p8 contents
}

const API_BASE = "https://api.appstoreconnect.apple.com";

/** ASC tokens are capped at 20 minutes; mint fresh per batch of calls. */
export async function mintAscToken(creds: AscCredentials): Promise<string> {
	const key = await importP8(creds.privateKeyPem);
	const iat = nowEpochSeconds();
	return signJwt(
		{ alg: "ES256", kid: creds.keyId, typ: "JWT" },
		{ aud: "appstoreconnect-v1", exp: iat + 19 * 60, iat, iss: creds.issuerId },
		key
	);
}

interface AscResource<A = Record<string, unknown>> {
	type: string;
	id: string;
	attributes: A;
}
interface AscList<A = Record<string, unknown>> {
	data: AscResource<A>[];
	links?: { next?: string };
}

export interface ReportRequestAttributes {
	accessType: "ONGOING" | "ONE_TIME_SNAPSHOT";
	stoppedDueToInactivity?: boolean;
}
export interface ReportAttributes {
	name: string;
	category: string;
}
export interface InstanceAttributes {
	granularity: "DAILY" | "WEEKLY" | "MONTHLY";
	processingDate: string;
}
export interface SegmentAttributes {
	url: string;
	checksum: string;
	sizeInBytes: number;
}

export class AscApiError extends Error {
	status: number;
	endpoint: string;
	constructor(status: number, body: string, endpoint: string) {
		super(`ASC API ${status} at ${endpoint}: ${body.slice(0, 300)}`);
		this.name = "AscApiError";
		this.status = status;
		this.endpoint = endpoint;
	}
}

export class AscClient {
	#creds: AscCredentials;
	#token: { value: string; expiresAt: number } | null = null;

	constructor(creds: AscCredentials) {
		this.#creds = creds;
	}

	async #headers(): Promise<Record<string, string>> {
		if (!this.#token || this.#token.expiresAt < Date.now()) {
			this.#token = {
				expiresAt: Date.now() + 18 * 60 * 1000,
				value: await mintAscToken(this.#creds),
			};
		}
		return {
			Authorization: `Bearer ${this.#token.value}`,
			"Content-Type": "application/json",
		};
	}

	/** GET with pagination follow; segments occasionally 404/500, so the caller retries. */
	async #getAll<A>(url: string): Promise<AscResource<A>[]> {
		const out: AscResource<A>[] = [];
		let next: string | undefined = url;
		while (next) {
			const res = await fetch(next, { headers: await this.#headers() });
			if (!res.ok) {
				throw new AscApiError(res.status, await res.text(), next);
			}
			const json = (await res.json()) as AscList<A>;
			out.push(...json.data);
			next = json.links?.next;
		}
		return out;
	}

	listReportRequests(
		appId: string
	): Promise<AscResource<ReportRequestAttributes>[]> {
		return this.#getAll(`${API_BASE}/v1/apps/${appId}/analyticsReportRequests`);
	}

	async createReportRequest(
		appId: string,
		accessType: ReportRequestAttributes["accessType"]
	): Promise<AscResource<ReportRequestAttributes>> {
		const res = await fetch(`${API_BASE}/v1/analyticsReportRequests`, {
			body: JSON.stringify({
				data: {
					type: "analyticsReportRequests",
					attributes: { accessType },
					relationships: { app: { data: { type: "apps", id: appId } } },
				},
			}),
			headers: await this.#headers(),
			method: "POST",
		});
		if (!res.ok) {
			throw new AscApiError(
				res.status,
				await res.text(),
				"createReportRequest"
			);
		}
		return (
			(await res.json()) as { data: AscResource<ReportRequestAttributes> }
		).data;
	}

	listReports(
		reportRequestId: string,
		category?: string
	): Promise<AscResource<ReportAttributes>[]> {
		const filter = category
			? `?filter[category]=${encodeURIComponent(category)}`
			: "";
		return this.#getAll(
			`${API_BASE}/v1/analyticsReportRequests/${reportRequestId}/reports${filter}`
		);
	}

	listInstances(
		reportId: string,
		granularity?: InstanceAttributes["granularity"]
	): Promise<AscResource<InstanceAttributes>[]> {
		const filter = granularity ? `?filter[granularity]=${granularity}` : "";
		return this.#getAll(
			`${API_BASE}/v1/analyticsReports/${reportId}/instances${filter}`
		);
	}

	listSegments(instanceId: string): Promise<AscResource<SegmentAttributes>[]> {
		return this.#getAll(
			`${API_BASE}/v1/analyticsReportInstances/${instanceId}/segments`
		);
	}
}

/** Download a segment (gzip TSV) as a stream, suitable for R2 put without buffering. */
export async function downloadSegment(segmentUrl: string): Promise<Response> {
	// Segment URLs are pre-signed; no auth header.
	const res = await fetch(segmentUrl);
	if (!res.ok || !res.body) {
		throw new AscApiError(res.status, "segment download failed", segmentUrl);
	}
	return res;
}
