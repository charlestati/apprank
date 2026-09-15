// Writing to R2, which is the source of truth (CLAUDE.md, invariant 2).
//
// Every derived row is supposed to be reconstructible from the archived
// response, so an object that never landed is a hole no later run can fill:
// Apple will not serve that page, that day, or that week again. R2 on this
// account really does refuse: twenty `put`s failed on 2026-09-11 with
// "We encountered an internal error. Please try again. (10001)", and each one
// took a crawl's ranking with it.

import type { Env } from "../env";

type Body = string | ReadableStream | ArrayBuffer | null;

/** Stored on every object `gzip` produced, so a reader need not trust the key. */
export const GZIP_METADATA: R2PutOptions = {
	httpMetadata: { contentType: "application/gzip" },
};

/**
 * Compress a response body before archiving it.
 *
 * iTunes search and chart bodies are mostly repeated field names and artwork
 * URLs, so gzip takes them to about a fifth (measured 5.4x on search samples,
 * 3.5x on charts). A full 200-result search page is ~1.5 MB raw, which put the
 * 21-day sample window past a gigabyte on its own. Buffered rather than
 * streamed on purpose: `putArchived` retries, and a stream cannot be replayed.
 */
export function gzip(text: string): Promise<ArrayBuffer> {
	return new Response(
		new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
	).arrayBuffer();
}

/**
 * Archive something we would rather keep than lose. Throws when it did not
 * land, so the caller records a failure instead of deriving rows from a
 * response nothing can prove we received.
 *
 * Retries the transient refusal, then reads back: `put` resolving is not the
 * same as the object existing, and a success that cannot be read is the case
 * that silently breaks a rebuild months later. The retry has to wrap the call
 * itself, because R2's internal error arrives as a throw rather than as a
 * falsy result, and a loop that only re-checks `head` never runs a second time.
 */
export async function putArchived(
	env: Env,
	key: string,
	body: Body,
	options?: R2PutOptions
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await env.ARCHIVE.put(key, body, options);
			if (await env.ARCHIVE.head(key)) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		// A stream is consumed by the first attempt, so there is nothing left to
		// retry with. Fail now rather than write an empty object over the key.
		if (body instanceof ReadableStream) {
			break;
		}
	}
	const reason =
		lastError instanceof Error
			? `: ${lastError.message}`
			: " (not readable back)";
	throw new Error(`archive did not persist: ${key}${reason}`);
}

/**
 * Archive a body whose loss costs less than the write that depends on it.
 *
 * For diagnostic objects only: a throttled body, an error body, the
 * one-in-ten success sample. None of them is the observation itself, and none
 * is worth the day it costs when a failed `put` propagates. The throttle would
 * then go unrecorded and the loop would keep pushing at an Apple bucket that is
 * already full (invariant 4), or a pair would lose its rank for the sake of a
 * sample R2 expires in 21 days anyway. Callers store the key only when this
 * returns true, so `r2_key` never names an object that is not there.
 */
export async function tryPut(
	env: Env,
	key: string,
	body: string | ArrayBuffer,
	options?: R2PutOptions
): Promise<boolean> {
	try {
		await env.ARCHIVE.put(key, body, options);
		return true;
	} catch (error) {
		console.log(
			`archive put failed for ${key}: ${error instanceof Error ? error.message : "unknown"}`
		);
		return false;
	}
}
