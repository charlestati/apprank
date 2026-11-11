import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// A request no test stubbed would otherwise go to happy-dom's real fetch,
// which dials localhost:3000: the test still passes (every page swallows a
// failed request), the log fills with ECONNREFUSED, and the teardown aborts
// whatever was left in flight. Installed as the global itself rather than
// through `vi.stubGlobal`, so `vi.unstubAllGlobals()` restores this guard
// instead of the real thing.
const unstubbed: string[] = [];

globalThis.fetch = (input: RequestInfo | URL) => {
	const url = input instanceof Request ? input.url : String(input);
	unstubbed.push(url);
	return Promise.reject(new Error(`Unstubbed fetch in a client test: ${url}`));
};

beforeEach(() => {
	unstubbed.length = 0;
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	if (unstubbed.length > 0) {
		const urls = unstubbed.splice(0).join(", ");
		throw new Error(`A test fetched without a stub: ${urls}`);
	}
});
