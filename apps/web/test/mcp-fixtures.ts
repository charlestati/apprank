// Helpers for driving the MCP endpoint over JSON-RPC in tests.

import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";

import worker from "../src/index";
import { formatToken, hashSecret } from "../src/mcp/auth";

export const MCP_URL = "https://example.com/mcp";

export interface IssuedCredential {
	id: string;
	token: string;
}

export async function issueCredential(options: {
	id?: string;
	userId: string;
	name?: string;
	scopes?: string[];
	expiresAt?: number | null;
	revokedAt?: number | null;
	windowCount?: number;
	windowStart?: number | null;
}): Promise<IssuedCredential> {
	const id = options.id ?? `cred${Math.random().toString(16).slice(2, 10)}`;
	const secret = `secret-${id}`;
	await env.DB.prepare(
		`INSERT INTO mcp_credential
       (id, user_id, name, secret_hash, scopes, created_at, expires_at,
        revoked_at, window_count, window_start)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9)`
	)
		.bind(
			id,
			options.userId,
			options.name ?? `client-${id}`,
			await hashSecret(secret),
			JSON.stringify(options.scopes ?? ["read:all"]),
			options.expiresAt === undefined ? null : options.expiresAt,
			options.revokedAt ?? null,
			options.windowCount ?? 0,
			options.windowStart === undefined ? null : options.windowStart
		)
		.run();
	return { id, token: formatToken(id, secret) };
}

export function mcpRequest(
	body: unknown,
	token?: string,
	headers: Record<string, string> = {}
): Request {
	return new Request(MCP_URL, {
		body: JSON.stringify(body),
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		method: "POST",
	});
}

let nextId = 1;

export function rpc(method: string, params: unknown = {}) {
	nextId += 1;
	return { id: nextId, jsonrpc: "2.0", method, params };
}

export function callTool(name: string, args: Record<string, unknown> = {}) {
	return rpc("tools/call", { arguments: args, name });
}

/** Reads a JSON-RPC reply whether it arrived as JSON or a one-shot SSE frame. */
export async function jsonRpcBody<T = Record<string, unknown>>(
	res: Response
): Promise<T> {
	const text = await res.text();
	if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
		const line = text.split("\n").find((l) => l.startsWith("data: "));
		return JSON.parse(line?.slice("data: ".length) ?? "{}") as T;
	}
	return JSON.parse(text) as T;
}

interface ToolReply {
	result?: { content?: { text: string }[]; isError?: boolean };
	error?: { message: string };
}

/** The JSON payload a tool answered with, plus whether it flagged an error. */
export async function toolPayload(
	res: Response
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
	const body = await jsonRpcBody<ToolReply>(res);
	const text = body.result?.content?.[0]?.text;
	return {
		data: text ? (JSON.parse(text) as Record<string, unknown>) : {},
		isError: body.result?.isError ?? false,
	};
}

/**
 * Drive the MCP endpoint with a real ExecutionContext and settle everything
 * the handler deferred, so the audit row is on disk before a test asserts on
 * it.
 *
 * The body is drained first, and that ordering is load-bearing: a streamed
 * (SSE) reply produces the tool result lazily as the consumer reads it, so the
 * tool has not run, and has not logged, until the stream is consumed.
 * Waiting on the ExecutionContext before reading would wait for nothing.
 */
export async function fetchMcp(
	request: Request,
	workerEnv: unknown
): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, workerEnv as never, ctx);
	const body = await res.text();
	await waitOnExecutionContext(ctx);
	return new Response(body, {
		headers: res.headers,
		status: res.status,
		statusText: res.statusText,
	});
}
